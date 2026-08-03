import * as vscode from 'vscode';
import { ExcludeSetting, excludePatterns, isExcluded, resolveCallName } from './callsite';
import { escapeText, formatDocumentation, parameterRange, renderSignatureHtml, RenderOptions } from './render';
import { compactSignature } from './simplify';
import { ThemeColors } from './theme';

type Mode = 'signature' | 'doc' | 'both' | 'none';
type Overloads = 'all' | 'active';
type Header = 'none' | 'name' | 'name+count';
type SignatureStyle = 'compact' | 'full';

/**
 * A truthy result with no signatures. Returning it stops VS Code's provider
 * chain — so the language server never gets asked — and leaves the widget
 * hidden, which is how exclusions and the off switch suppress the popup without
 * touching the user's settings.
 */
function suppressed(): vscode.SignatureHelp {
	return { signatures: [], activeSignature: 0, activeParameter: 0 };
}

/**
 * Takes over parameter hints: asks the real language server for the signature,
 * then re-renders it as colored HTML in the `documentation` field, which is the
 * only part of the built-in widget that goes through the markdown renderer.
 */
export class SignatureHintsProvider implements vscode.SignatureHelpProvider {
	/** Positions currently being resolved upstream, to break the recursion. */
	private readonly passthrough = new Set<string>();

	constructor(
		private readonly theme: ThemeColors,
		private readonly log: vscode.OutputChannel,
	) {}

	async provideSignatureHelp(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		context: vscode.SignatureHelpContext,
	): Promise<vscode.SignatureHelp | undefined> {
		// Our own `executeSignatureHelpProvider` call lands back here; stepping
		// aside lets it reach the language server underneath.
		if (this.passthrough.has(key(document, position))) {
			return undefined;
		}

		const config = vscode.workspace.getConfiguration('signatureHints', document);
		if (!config.get<boolean>('enabled', true)) {
			return suppressed();
		}
		const mode = config.get<Mode>('mode', 'both');
		if (mode === 'none') {
			return suppressed();
		}

		const name = resolveCallName(document, position);
		const exclude = excludePatterns(config.get<ExcludeSetting>('exclude'), document.languageId);
		if (isExcluded(name, exclude)) {
			return suppressed();
		}

		const upstream = await this.fetchUpstream(document, position, context);
		if (!upstream?.signatures?.length) {
			return undefined;
		}

		return this.build(upstream, name, mode, config);
	}

	/** Runs the provider chain again, with this provider disabled for the position. */
	async fetchUpstream(
		document: vscode.TextDocument,
		position: vscode.Position,
		context?: vscode.SignatureHelpContext,
	): Promise<vscode.SignatureHelp | undefined> {
		const marker = key(document, position);
		this.passthrough.add(marker);
		try {
			return await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
				'vscode.executeSignatureHelpProvider',
				document.uri,
				position,
				context?.triggerCharacter,
			);
		} catch (error) {
			this.log.appendLine(`[upstream] ${String(error)}`);
			return undefined;
		} finally {
			this.passthrough.delete(marker);
		}
	}

	private build(
		upstream: vscode.SignatureHelp,
		name: string | undefined,
		mode: Mode,
		config: vscode.WorkspaceConfiguration,
	): vscode.SignatureHelp | undefined {
		const overloads = config.get<Overloads>('overloads', 'active');
		const header = config.get<Header>('header', 'none');
		const style = config.get<SignatureStyle>('signatureStyle', 'compact');
		const maxDocLines = config.get<number>('maxDocLines', 12);
		const options: RenderOptions = {
			colors: config.get<'theme' | 'off'>('colors', 'theme'),
			monospace: config.get<boolean>('monospace', true),
		};

		const signatures = upstream.signatures;
		const activeSignature = clamp(upstream.activeSignature, signatures.length);
		const activeParameter = upstream.activeParameter ?? 0;

		const renderOne = (signature: vscode.SignatureInformation) =>
			this.renderSignature(signature, activeParameter, name, style, options);

		if (overloads === 'active') {
			const rendered = signatures.map((signature, index) => {
				const info = new vscode.SignatureInformation(label(header, name, index, signatures.length));
				info.parameters = [];
				const body = this.compose(
					mode,
					renderOne(signature),
					formatDocumentation(signature.documentation, maxDocLines),
				);
				if (!body) {
					return undefined;
				}
				info.documentation = body;
				return info;
			});
			const kept = rendered.filter((info): info is vscode.SignatureInformation => !!info);
			return kept.length ? { signatures: kept, activeSignature, activeParameter: 0 } : undefined;
		}

		const max = Math.max(1, config.get<number>('maxOverloads', 5));
		const shown = signatures.slice(0, max);
		let html = shown.map(renderOne).join('<br>');
		if (signatures.length > shown.length) {
			html += `<br>${escapeText(`… ${signatures.length - shown.length} more`)}`;
		}

		const active = signatures[activeSignature];
		const body = this.compose(mode, html, formatDocumentation(active?.documentation, maxDocLines));
		if (!body) {
			return undefined;
		}

		const info = new vscode.SignatureInformation(label(header, name, activeSignature, signatures.length));
		info.parameters = [];
		info.documentation = body;
		return { signatures: [info], activeSignature: 0, activeParameter: 0 };
	}

	/**
	 * One signature line: `print(*values, sep=" ", flush=False)`.
	 *
	 * The callee's name is prepended because language servers report a label that
	 * starts at the parenthesis, and reading the name off the popup itself is what
	 * lets the widget's plain header line be turned off.
	 */
	private renderSignature(
		signature: vscode.SignatureInformation,
		activeParameter: number,
		name: string | undefined,
		style: SignatureStyle,
		options: RenderOptions,
	): string {
		let label = signature.label;
		let active = parameterRange(signature, activeParameter);

		if (style === 'compact') {
			const compact = compactSignature(label, signature.parameters, activeParameter);
			label = compact.label;
			active = compact.active;
		}

		// A label that already carries the name — TypeScript's does — is left alone.
		if (name && label.startsWith('(')) {
			if (active) {
				active = [active[0] + name.length, active[1] + name.length];
			}
			label = name + label;
		}

		return renderSignatureHtml(label, active, this.theme, options);
	}

	/** Assembles the popup body; returns undefined when there is nothing to show. */
	private compose(mode: Mode, signatureHtml: string, docs: string): vscode.MarkdownString | undefined {
		const parts: string[] = [];
		if (mode === 'signature' || mode === 'both') {
			parts.push(signatureHtml);
		}
		if ((mode === 'doc' || mode === 'both') && docs.trim()) {
			parts.push(docs);
		}
		if (!parts.length) {
			return undefined;
		}

		// A blank line, not a rule: the docstring's own markdown blocks need one to
		// parse, and a rule costs height the 440px-wide widget cannot spare.
		const markdown = new vscode.MarkdownString(parts.join('\n\n'));
		markdown.supportHtml = true;
		markdown.isTrusted = false;
		return markdown;
	}
}

function label(header: Header, name: string | undefined, index: number, count: number): string {
	if (header === 'none') {
		return '';
	}
	const base = name ?? '';
	if (header === 'name+count' && count > 1) {
		return `${base}  ${index + 1}/${count}`;
	}
	return base;
}

function clamp(index: number | undefined, length: number): number {
	if (typeof index !== 'number' || index < 0 || index >= length) {
		return 0;
	}
	return index;
}

function key(document: vscode.TextDocument, position: vscode.Position): string {
	return `${document.uri.toString()}|${position.line}|${position.character}`;
}
