import * as vscode from 'vscode';
import { ExcludeSetting, excludePatterns, isExcluded, resolveCall, resolveCallName } from './callsite';
import { CallDocsHoverProvider } from './hover';
import { SignatureHintsProvider } from './provider';
import { ThemeColors } from './theme';

type Mode = 'signature' | 'doc' | 'both' | 'none';

const MODE_CYCLE: Mode[] = ['signature', 'doc', 'both'];
const SCHEMES = ['file', 'untitled', 'vscode-notebook-cell'];

function selector(): vscode.DocumentFilter[] {
	const languages = vscode.workspace
		.getConfiguration('signatureHints')
		.get<string[]>('languages', ['*']);
	return languages.flatMap((language) => SCHEMES.map((scheme) => ({ language, scheme })));
}

/**
 * Delays before each re-registration attempt, roughly a minute in total.
 *
 * A single retry at +2s was not enough: Pylance registers its provider when the
 * language server finishes starting, which on a project with numpy-sized stubs
 * is well after that. Registering before it means losing, and the loss is
 * invisible — a provider that is not first is simply never called.
 */
const CHASE_DELAYS_MS = [1000, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 15000];

/**
 * How long a win stays trusted. Winning once is not winning forever: the Python
 * extension restarts its language server after resolving an interpreter, on
 * configuration changes, and when analysis settles — each restart re-registers
 * Pylance's provider, which makes it the newest and puts it back in front.
 */
const RECLAIM_AFTER_MS = 5000;

/**
 * VS Code orders equally-scored providers newest-first, so registering after the
 * language server is what puts us in front of it. Selector specificity cannot
 * help: the score saturates at 10.
 *
 * Re-registering is not free: `ParameterHintsModel` listens to the provider
 * registry (`this.providers.onDidChange(this.onModelChanged, this)`) and cancels
 * whatever is on screen. So this only retries while it is losing — the popup
 * being cancelled then is the language server's own, and the next trigger is
 * ours.
 */
class Registration {
	private disposable: vscode.Disposable | undefined;
	/** When our provider was last reached, per language. */
	private readonly lastServed = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private attempt = 0;
	/** Registrations performed, for Show Diagnostics. */
	refreshes = 0;

	constructor(private readonly provider: vscode.SignatureHelpProvider) {}

	refresh(): void {
		this.disposable?.dispose();
		this.disposable = vscode.languages.registerSignatureHelpProvider(selector(), this.provider, {
			triggerCharacters: ['(', ','],
			retriggerCharacters: [',', ')'],
		});
		this.refreshes++;
	}

	/**
	 * Being called at all proves we are in front for this language, which is the
	 * only signal available — the registry order itself is not observable.
	 */
	markServed(languageId: string): void {
		const first = !this.lastServed.has(languageId);
		this.lastServed.set(languageId, Date.now());
		if (first) {
			this.stop();
		}
	}

	/**
	 * Registers again if we have not been reached lately.
	 *
	 * Called just before the popup is opened, which is the one moment where
	 * re-registering is free: nothing is on screen for the registry change to
	 * cancel, and being the newest provider is exactly what the trigger that
	 * follows needs.
	 */
	reclaimIfStale(languageId: string): void {
		if (Date.now() - (this.lastServed.get(languageId) ?? 0) > RECLAIM_AFTER_MS) {
			this.refresh();
		}
	}

	/** Keeps re-registering until the active language is served, then gives up. */
	chase(): void {
		if (this.pending()) {
			this.stop();
			this.attempt = 0;
			this.step();
		}
	}

	private step(): void {
		const delay = CHASE_DELAYS_MS[this.attempt];
		if (delay === undefined) {
			return;
		}
		this.timer = setTimeout(() => {
			if (!this.pending()) {
				return;
			}
			this.refresh();
			this.attempt++;
			this.step();
		}, delay);
	}

	/** Languages our provider has been reached for, with how long ago. */
	get servedLanguages(): readonly string[] {
		const now = Date.now();
		return [...this.lastServed].map(([language, at]) => `${language} (${now - at}ms ago)`);
	}

	private pending(): boolean {
		const language = vscode.window.activeTextEditor?.document.languageId;
		return !!language && !this.lastServed.has(language);
	}

	private stop(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.stop();
		this.disposable?.dispose();
	}
}

/** Settles before probing the call site, so held arrow keys cost one check. */
const REOPEN_DEBOUNCE_MS = 120;

/**
 * Re-opens the popup when the cursor moves back inside a call.
 *
 * VS Code starts parameter hints on the trigger characters `(` and `,`, and
 * afterwards only keeps them alive while they are already showing. Leaving
 * `np.array(x)|` and coming back to `np.array(x|)` therefore shows nothing, and
 * typing does not bring it back either — nothing there is a trigger character.
 */
class Reopener {
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The call last triggered for, so `Escape` is not immediately undone. */
	private lastCall: string | undefined;

	constructor(private readonly registration: Registration) {}

	schedule(event: vscode.TextEditorSelectionChangeEvent): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.run(event.textEditor), REOPEN_DEBOUNCE_MS);
	}

	private run(editor: vscode.TextEditor): void {
		if (editor !== vscode.window.activeTextEditor || !editor.selection.isEmpty) {
			this.lastCall = undefined;
			return;
		}

		const config = vscode.workspace.getConfiguration('signatureHints', editor.document);
		if (
			!config.get<boolean>('reopenInsideCalls', true) ||
			!config.get<boolean>('enabled', true) ||
			config.get<Mode>('mode', 'signature') === 'none'
		) {
			return;
		}

		const call = resolveCall(editor.document, editor.selection.active);
		const exclude = excludePatterns(config.get<ExcludeSetting>('exclude'), editor.document.languageId);
		if (!call || isExcluded(call.name, exclude)) {
			this.lastCall = undefined;
			return;
		}

		// Moving between arguments of the same call is left alone: the popup is
		// either already up, or the user closed it on purpose.
		const key = `${call.name}|${call.position.line}|${call.position.character}`;
		if (key === this.lastCall) {
			return;
		}
		this.lastCall = key;

		// Order matters: take the lead back first, then ask for the popup, so the
		// trigger below is the one that reaches us.
		this.registration.reclaimIfStale(editor.document.languageId);
		void vscode.commands.executeCommand('editor.action.triggerParameterHints');
	}

	dispose(): void {
		clearTimeout(this.timer);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Signature Hints');
	const theme = new ThemeColors();
	theme.reload();

	const provider = new SignatureHintsProvider(theme, log);
	const registration = new Registration(provider);
	provider.onServed = (language) => registration.markServed(language);
	registration.refresh();
	registration.chase();

	// Hovers from every provider are shown together, so this one needs no
	// priority games — unlike signature help, which stops at the first result.
	const docs = new CallDocsHoverProvider();
	const reopener = new Reopener(registration);

	context.subscriptions.push(
		log,
		registration,
		reopener,
		vscode.window.onDidChangeTextEditorSelection((event) => reopener.schedule(event)),
		vscode.extensions.onDidChange(() => {
			registration.refresh();
			registration.chase();
		}),
		// Switching tabs is a safe moment to reclaim the lead: no popup is open, so
		// nothing gets cancelled. Opening a document may also be what starts a
		// language server.
		vscode.window.onDidChangeActiveTextEditor(() => {
			registration.refresh();
			registration.chase();
		}),
		vscode.workspace.onDidOpenTextDocument(() => registration.chase()),
		vscode.window.onDidChangeActiveColorTheme(() => theme.reload()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration('workbench.colorTheme') ||
				event.affectsConfiguration('editor.tokenColorCustomizations')
			) {
				theme.reload();
			}
			if (event.affectsConfiguration('signatureHints.languages')) {
				registration.refresh();
			}
		}),
		vscode.languages.registerHoverProvider(selector(), docs),
		vscode.commands.registerCommand('signatureHints.showDocs', () => showDocs(docs)),
		vscode.commands.registerCommand('signatureHints.toggle', toggle),
		vscode.commands.registerCommand('signatureHints.cycleMode', cycleMode),
		vscode.commands.registerCommand('signatureHints.excludeCallAtCursor', excludeCallAtCursor),
		vscode.commands.registerCommand('signatureHints.reclaimPriority', () => {
			registration.refresh();
			registration.chase();
			vscode.window.setStatusBarMessage('Signature Hints: provider re-registered', 2000);
		}),
		vscode.commands.registerCommand('signatureHints.showDiagnostics', () =>
			showDiagnostics(log, theme, provider, registration),
		),
	);

	void ensureParameterHintsEnabled();
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}

/**
 * The built-in widget is our rendering surface, so nothing shows while
 * `editor.parameterHints.enabled` is false — which is a setting users who
 * disliked the native popup are likely to have turned off.
 */
async function ensureParameterHintsEnabled(): Promise<void> {
	const editor = vscode.workspace.getConfiguration('editor');
	if (editor.get<boolean>('parameterHints.enabled', true)) {
		return;
	}
	const enable = 'Enable';
	const choice = await vscode.window.showWarningMessage(
		'Signature Hints renders inside the parameter hints popup, but "editor.parameterHints.enabled" is off.',
		enable,
		'Not now',
	);
	if (choice === enable) {
		await editor.update('parameterHints.enabled', true, vscode.ConfigurationTarget.Global);
	}
}

/**
 * `alt+h`. On a name, this is just VS Code's own hover. Inside a call's
 * parentheses, the hover provider fills in the callee's documentation, so the
 * same key works in both places. Pressing it again focuses the hover, which is
 * how the docstring gets scrolled from the keyboard.
 */
async function showDocs(docs: CallDocsHoverProvider): Promise<void> {
	// Both are content widgets anchored to the cursor and they overlap. The
	// command is guarded by the `parameterHintsVisible` context key, so it is a
	// no-op when the popup is not up.
	await vscode.commands.executeCommand('closeParameterHints');
	docs.arm();
	await vscode.commands.executeCommand('editor.action.showHover');
}

async function toggle(): Promise<void> {
	const config = vscode.workspace.getConfiguration('signatureHints');
	const next = !config.get<boolean>('enabled', true);
	await config.update('enabled', next, vscode.ConfigurationTarget.Global);
	vscode.window.setStatusBarMessage(`Signature Hints: ${next ? 'on' : 'off'}`, 2000);
}

async function cycleMode(): Promise<void> {
	const config = vscode.workspace.getConfiguration('signatureHints');
	const current = config.get<Mode>('mode', 'signature');
	const next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length]!;
	await config.update('mode', next, vscode.ConfigurationTarget.Global);
	vscode.window.setStatusBarMessage(`Signature Hints: ${next}`, 2000);
}

async function excludeCallAtCursor(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	const name = resolveCallName(editor.document, editor.selection.active);
	if (!name) {
		vscode.window.showWarningMessage('Signature Hints: no call found at the cursor.');
		return;
	}
	const language = editor.document.languageId;
	const config = vscode.workspace.getConfiguration('signatureHints', editor.document);
	const setting = config.get<ExcludeSetting>('exclude') ?? {};

	if (excludePatterns(setting, language).includes(name)) {
		vscode.window.setStatusBarMessage(`Signature Hints: ${name} is already excluded`, 2000);
		return;
	}

	// Whichever shape the user already writes is the shape we keep.
	const next: ExcludeSetting = Array.isArray(setting)
		? [...setting, name]
		: { ...setting, [language]: [...((setting as Record<string, string[]>)[language] ?? []), name] };

	await config.update('exclude', next, vscode.ConfigurationTarget.Global);
	vscode.window.setStatusBarMessage(`Signature Hints: excluded ${name} for ${language}`, 2000);
}

const PROBE_SCOPES = [
	'variable.parameter',
	'entity.name.type',
	'constant.language',
	'constant.numeric',
	'string.quoted.double',
	'keyword.operator',
	'punctuation.separator',
];

async function showDiagnostics(
	log: vscode.OutputChannel,
	theme: ThemeColors,
	provider: SignatureHintsProvider,
	registration: Registration,
): Promise<void> {
	log.show(true);
	log.appendLine('='.repeat(60));
	log.appendLine(`theme source : ${theme.source}`);
	log.appendLine(`textmate rules: ${theme.ruleCount}`);
	for (const scope of PROBE_SCOPES) {
		const style = theme.style(scope);
		log.appendLine(`  ${scope.padEnd(24)} ${style.foreground}${style.bold ? ' bold' : ''}`);
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		log.appendLine('no active editor');
		return;
	}
	const position = editor.selection.active;
	log.appendLine(`document     : ${editor.document.uri.toString()}`);
	log.appendLine(`language     : ${editor.document.languageId}`);
	log.appendLine(`call at cursor: ${resolveCallName(editor.document, position) ?? '(none)'}`);
	log.appendLine(`served langs : ${registration.servedLanguages.join(', ') || '(never reached — the language server is still ahead of us)'}`);
	log.appendLine(`registrations: ${registration.refreshes}`);
	log.appendLine(`outcomes     : ${JSON.stringify(provider.outcomes)}`);
	log.appendLine(`cached sites : ${provider.cacheSize}`);
	log.appendLine(`last upstream: ${provider.lastUpstreamMs < 0 ? '(never)' : `${provider.lastUpstreamMs} ms`}`);

	// Timed separately: this is the language server's own latency, and it is the
	// number to look at when the popup feels slow.
	const started = Date.now();
	const upstream = await provider.fetchUpstream(editor.document, position);
	log.appendLine(`this fetch   : ${Date.now() - started} ms`);
	log.appendLine(`upstream     : ${upstream ? JSON.stringify(upstream, null, 2) : '(nothing)'}`);
}
