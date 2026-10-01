import * as vscode from 'vscode';
import { ExcludeSetting, excludePatterns, isExcluded, resolveCall, resolveCallName } from './callsite';
import { CallDocsHoverProvider } from './hover';
import { callKey, SignatureHintsProvider } from './provider';
import { ThemeColors } from './theme';
import { isOutsideInsert } from './vimMode';

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

	constructor(private readonly provider: SignatureHintsProvider) {}

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
	 * Registers again unless the chain has already reached us for this revision.
	 *
	 * `wasCalledFor` is exact and free, so no throttle is needed and nothing is
	 * added to the typing path. A false answer means either we are behind, or no
	 * trigger happened at all — and re-registering is harmless in the second case,
	 * since an open popup is re-queried on every content change, so a popup that
	 * is ours would have kept the answer true.
	 *
	 * Returns true when the lead had to be taken back.
	 */
	reclaim(document: vscode.TextDocument): boolean {
		// Having rendered proves we were in front, and a popup of ours is likely on
		// screen. Re-registering cancels it — `ParameterHintsModel` listens to the
		// registry — so a lead we can vouch for is left alone. Without this, every
		// `,` inside a call made the popup vanish and come back: the document change
		// reaches us before VS Code's query for the new revision does, so
		// `wasCalledFor` reads false for a moment even though nothing is wrong.
		if (Date.now() - this.provider.lastRenderedAt < LEAD_TRUST_MS) {
			return false;
		}
		if (this.provider.wasCalledFor(document)) {
			return false;
		}
		this.refresh();
		return true;
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
const REOPEN_DEBOUNCE_MS = 50;

/** Minimum gap between two attempts to replace a popup that is not ours. */
const NUDGE_THROTTLE_MS = 1000;

/**
 * How long a successful render vouches for the lead. Long enough to cover a
 * burst of typing inside one call, short enough that a language server
 * restarting mid-session is noticed on the next pause.
 */
const LEAD_TRUST_MS = 2000;

/**
 * Our own visibility flag for the hover.
 *
 * VS Code's `editorHoverVisible` cannot be used in a `when` clause for this: the
 * hover hides itself from an editor-level `_onKeyDown` DOM listener, which runs
 * before the keybinding service resolves the key, so the context key has already
 * flipped to false by the time the clause is evaluated.
 */
const HOVER_SHOWN = 'signatureHints.hoverShown';

function setHoverShown(shown: boolean): void {
	void vscode.commands.executeCommand('setContext', HOVER_SHOWN, shown);
}

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
	private lastNudge = 0;
	/** Call site the user closed by hand; left alone until the cursor leaves it. */
	private dismissed: string | undefined;

	constructor(
		private readonly registration: Registration,
		private readonly provider: SignatureHintsProvider,
	) {}

	/** `Escape` on the popup: remember that this one was closed on purpose. */
	dismiss(editor: vscode.TextEditor | undefined): void {
		const call = editor && resolveCall(editor.document, editor.selection.active);
		this.dismissed = call && editor ? callKey(editor.document, call) : undefined;
	}

	schedule(event: vscode.TextEditorSelectionChangeEvent): void {
		// Leading edge, every time, before anything else can return early.
		this.keepLead(event.textEditor);
		// In Insert mode the popup is wanted now: ask the server without waiting
		// for the cursor to settle. In Normal mode, `run` asks once it has.
		if (!vimHoldsBack(event.textEditor)) {
			this.warm(event.textEditor);
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.run(event.textEditor), REOPEN_DEBOUNCE_MS);
	}

	/** Fetches the signatures of the call under the cursor ahead of the popup. */
	private warm(editor: vscode.TextEditor): void {
		if (editor !== vscode.window.activeTextEditor || !editor.selection.isEmpty) {
			return;
		}
		const config = vscode.workspace.getConfiguration('signatureHints', editor.document);
		if (!config.get<boolean>('enabled', true) || config.get<Mode>('mode', 'signature') === 'none') {
			return;
		}
		const position = editor.selection.active;
		const call = resolveCall(editor.document, position);
		const exclude = excludePatterns(config.get<ExcludeSetting>('exclude'), editor.document.languageId);
		if (call && !isExcluded(call.name, exclude)) {
			this.provider.warm(editor.document, position, callKey(editor.document, call));
		}
	}

	/**
	 * Stays in front while typing, rather than reacting once the lead is lost.
	 *
	 * Reacting cannot work here. `(` is a trigger character, so VS Code queries
	 * providers the instant it is typed — or the instant `Tab` accepts a
	 * completion that ends in one — and whoever is in front at that moment
	 * answers. Anything of ours that runs afterwards is already too late, and
	 * during a fast burst the debounced pass below does not run at all before the
	 * `(` lands. The only way to win that query is to have been in front before it
	 * happened, which means checking on every cursor move, including the ones
	 * spent typing the name with no call in sight.
	 *
	 * It is cheap and it cannot disturb anything: `reclaim` re-registers only when
	 * the chain has not reached us for this revision, and a popup of ours is
	 * re-queried on every edit — so when one is showing, this does nothing at all.
	 */
	keepLead(editor: vscode.TextEditor): void {
		if (editor !== vscode.window.activeTextEditor) {
			return;
		}
		const config = vscode.workspace.getConfiguration('signatureHints', editor.document);
		if (!config.get<boolean>('enabled', true)) {
			return;
		}

		// Only outside a call. Re-registering cancels whatever the widget is
		// showing, and inside a call something usually is — that was the single
		// blink when the popup first appeared: the `(` that opened it also reached
		// this handler, which re-registered and dismissed it a frame later.
		//
		// Nothing is lost by stopping here. The keystrokes that matter are the ones
		// spent typing the name, before any popup exists, and by the time `(` is
		// reached the lead has already been taken. Inside a call, the debounced pass
		// re-registers if it has to, and re-opens the popup itself.
		if (resolveCall(editor.document, editor.selection.active)) {
			return;
		}
		this.registration.reclaim(editor.document);
	}

	/** Run the pass now-ish without a cursor move: Vim just entered Insert mode. */
	poke(editor: vscode.TextEditor): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.run(editor), REOPEN_DEBOUNCE_MS);
	}

	private run(editor: vscode.TextEditor): void {
		// Outside Insert mode the cursor travels through calls without editing
		// them: no popup. Forgetting the call makes re-entering Insert inside it
		// count as arriving there.
		if (editor !== vscode.window.activeTextEditor || !editor.selection.isEmpty || vimHoldsBack(editor)) {
			this.lastCall = undefined;
			// Normal mode, cursor at rest in a call: have the answer ready for `i`.
			this.warm(editor);
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

		const position = editor.selection.active;
		const call = resolveCall(editor.document, position);
		const exclude = excludePatterns(config.get<ExcludeSetting>('exclude'), editor.document.languageId);
		if (!call || isExcluded(call.name, exclude)) {
			this.lastCall = undefined;
			return;
		}

		const site = callKey(editor.document, call);
		const moved = site !== this.lastCall;
		this.lastCall = site;
		if (moved) {
			this.dismissed = undefined;
		}
		if (this.dismissed === site) {
			return;
		}

		// Being in front is not the same as being on screen. Typing `(` makes VS
		// Code trigger on the character — and accepting a completion inserts the
		// whole `random()` at once — so a popup opened by whoever was in front at
		// that instant stays up until something re-triggers. Ownership is dropped on
		// every edit, so if this is still ours the popup was re-rendered since;
		// if it is not, what is showing belongs to someone else.
		const ours = this.provider.lastRenderedCall === site;
		const now = Date.now();
		const nudge = !ours && now - this.lastNudge > NUDGE_THROTTLE_MS;
		if (nudge) {
			this.lastNudge = now;
		}

		const reclaimed = this.registration.reclaim(editor.document);

		// Moving between arguments of the same call is left alone otherwise.
		if (moved || reclaimed || nudge) {
			void vscode.commands.executeCommand('editor.action.triggerParameterHints');
		}
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
	provider.isHeldBack = (document) => {
		const editor = vscode.window.activeTextEditor;
		return editor !== undefined && editor.document === document && vimHoldsBack(editor);
	};
	const registration = new Registration(provider);
	provider.onServed = (language) => registration.markServed(language);
	registration.refresh();
	registration.chase();
	// VSCodeVim may start after this extension: look again for a while.
	void detectVim();
	for (const delay of [2_000, 10_000, 30_000]) {
		setTimeout(() => void detectVim(), delay);
	}

	// Hovers from every provider are shown together, so this one needs no
	// priority games — unlike signature help, which stops at the first result.
	const docs = new CallDocsHoverProvider();
	const reopener = new Reopener(registration, provider);

	context.subscriptions.push(
		log,
		registration,
		reopener,
		vscode.window.onDidChangeTextEditorSelection((event) => {
			setHoverShown(false);
			reopener.schedule(event);
		}),
		// VSCodeVim changes the cursor style on every mode change. Leaving Insert
		// (Escape, Ctrl-[, a mapping…) closes the popup; entering it inside a
		// call opens it, as arriving there by typing would.
		vscode.window.onDidChangeTextEditorOptions(async (event) => {
			// A cursor style changing is VSCodeVim's doing: look for it again if
			// it had not started when this extension did.
			if (!vimPresent) {
				await detectVim();
			}
			if (event.textEditor !== vscode.window.activeTextEditor || !vimPresent) {
				return;
			}
			if (vimHoldsBack(event.textEditor)) {
				void vscode.commands.executeCommand('closeParameterHints');
			} else {
				reopener.poke(event.textEditor);
			}
		}),
		// An edit invalidates whatever is on screen. Staying first means we render
		// again right away; staying stale means the popup is not ours.
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (event.document === editor?.document) {
				provider.forgetOwnership();
				reopener.keepLead(editor);
			}
		}),
		vscode.extensions.onDidChange(() => {
			void detectVim();
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
		vscode.commands.registerCommand('signatureHints.dismissHover', dismissHover),
		vscode.commands.registerCommand('signatureHints.dismissHints', async () => {
			reopener.dismiss(vscode.window.activeTextEditor);
			await vscode.commands.executeCommand('closeParameterHints');
			await vimEscape();
		}),
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
	setHoverShown(true);
}

/**
 * `Escape` while the `alt+h` hover is up. The hover has already closed itself by
 * now; the point is to be the command that wins the key, so that in a notebook
 * `notebook.cell.quitEdit` does not also run and drop you out of the cell.
 */
function dismissHover(): void {
	setHoverShown(false);
	void vscode.commands.executeCommand('editor.action.hideHover').then(vimEscape);
}

/**
 * Both `Escape` bindings win the key over VSCodeVim's own, so on their own they
 * close the popup and leave Vim in Insert mode. Hand the key on: whatever
 * Escape does in Vim (Insert → Normal) happens too. In Normal mode it is a
 * no-op; without VSCodeVim, nothing runs.
 */
async function vimEscape(): Promise<void> {
	if (!vimPresent) {
		await detectVim();
	}
	if (!vimPresent) {
		return;
	}
	try {
		await vscode.commands.executeCommand('extension.vim_escape');
	} catch {
		// VSCodeVim not started yet: its command is not registered.
	}
}

/**
 * Whether VSCodeVim runs in this window, told by its command being registered.
 * Not `extensions.getExtension`: with `extensions.experimental.affinity`
 * VSCodeVim runs in another extension host, and from this one it does not
 * exist at all — while commands are shared by every host.
 */
let vimPresent = false;

async function detectVim(): Promise<void> {
	vimPresent = (await vscode.commands.getCommands(true)).includes('extension.vim_escape');
}

/**
 * VSCodeVim is out of Insert mode in this editor (Normal, Visual…), read from
 * the cursor style it sets per mode (see vimMode.ts). The popup only belongs
 * to Insert mode: in Normal mode the cursor merely passes through calls.
 */
function vimHoldsBack(editor: vscode.TextEditor): boolean {
	if (!vimPresent) {
		return false;
	}
	const vim = vscode.workspace.getConfiguration('vim');
	return isOutsideInsert(
		editor.options.cursorStyle,
		vim.get<string>('cursorStylePerMode.insert'),
		vscode.workspace.getConfiguration('editor', editor.document).get<string>('cursorStyle'),
		vim.get<string>('cursorStylePerMode.normal'),
	);
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

	const editorNow = vscode.window.activeTextEditor;
	const editor = editorNow;
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
	if (editorNow) {
		log.appendLine(`in front now : ${provider.wasCalledFor(editorNow.document)}`);
	}
	log.appendLine(`cached sites : ${provider.cacheSize}`);
	log.appendLine(`last upstream: ${provider.lastUpstreamMs < 0 ? '(never)' : `${provider.lastUpstreamMs} ms`}`);

	// Timed separately: this is the language server's own latency, and it is the
	// number to look at when the popup feels slow.
	const started = Date.now();
	const upstream = await provider.fetchUpstream(editor.document, position);
	log.appendLine(`this fetch   : ${Date.now() - started} ms`);
	log.appendLine(`upstream     : ${upstream ? JSON.stringify(upstream, null, 2) : '(nothing)'}`);
}
