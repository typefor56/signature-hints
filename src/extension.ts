import * as vscode from 'vscode';
import { ExcludeSetting, excludePatterns, resolveCallName } from './callsite';
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
 * VS Code orders equally-scored providers newest-first, so registering after the
 * language server is what puts us in front of it. Selector specificity cannot
 * help: the score saturates at 10.
 */
class Registration {
	private disposable: vscode.Disposable | undefined;
	private lastLanguage: string | undefined;

	constructor(private readonly provider: vscode.SignatureHelpProvider) {}

	refresh(): void {
		this.disposable?.dispose();
		this.disposable = vscode.languages.registerSignatureHelpProvider(selector(), this.provider, {
			triggerCharacters: ['(', ','],
			retriggerCharacters: [',', ')'],
		});
	}

	/** Re-registers when a language is seen for the first time, after its server has loaded. */
	refreshForEditor(editor: vscode.TextEditor | undefined): void {
		const language = editor?.document.languageId;
		if (language && language !== this.lastLanguage) {
			this.lastLanguage = language;
			this.refresh();
		}
	}

	dispose(): void {
		this.disposable?.dispose();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Signature Hints');
	const theme = new ThemeColors();
	theme.reload();

	const provider = new SignatureHintsProvider(theme, log);
	const registration = new Registration(provider);
	registration.refresh();

	// Hovers from every provider are shown together, so this one needs no
	// priority games — unlike signature help, which stops at the first result.
	const docs = new CallDocsHoverProvider();

	// The language server usually registers its own provider a moment after
	// startup; claiming priority again once it has settled.
	const settle = setTimeout(() => registration.refresh(), 2000);

	context.subscriptions.push(
		log,
		registration,
		new vscode.Disposable(() => clearTimeout(settle)),
		vscode.extensions.onDidChange(() => registration.refresh()),
		vscode.window.onDidChangeActiveTextEditor((editor) => registration.refreshForEditor(editor)),
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
			vscode.window.setStatusBarMessage('Signature Hints: provider re-registered', 2000);
		}),
		vscode.commands.registerCommand('signatureHints.showDiagnostics', () =>
			showDiagnostics(log, theme, provider),
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
	log.appendLine(`cached sites : ${provider.cacheSize}`);
	log.appendLine(`last upstream: ${provider.lastUpstreamMs < 0 ? '(never)' : `${provider.lastUpstreamMs} ms`}`);

	// Timed separately: this is the language server's own latency, and it is the
	// number to look at when the popup feels slow.
	const started = Date.now();
	const upstream = await provider.fetchUpstream(editor.document, position);
	log.appendLine(`this fetch   : ${Date.now() - started} ms`);
	log.appendLine(`upstream     : ${upstream ? JSON.stringify(upstream, null, 2) : '(nothing)'}`);
}
