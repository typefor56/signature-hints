import * as vscode from 'vscode';
import { CallSite, ExcludeSetting, excludePatterns, isExcluded, resolveCall } from './callsite';
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
 * hidden. That is how exclusions and `mode: "none"` suppress the popup without
 * touching the user's settings.
 *
 * Note what this is *not* for: `enabled: false` returns `undefined` instead, so
 * the chain falls through and the built-in parameter hints come back. Turning
 * the extension off has to mean the popup goes back to normal, not that it
 * disappears.
 */
function suppressed(): vscode.SignatureHelp {
	return { signatures: [], activeSignature: 0, activeParameter: 0 };
}

/** How long a call site's signatures stay usable after the last successful fetch. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
	signatures: readonly vscode.SignatureInformation[];
	activeSignature: number;
	at: number;
}

/** What the popup is built from, whether it came fresh or from the cache. */
interface Resolved {
	signatures: readonly vscode.SignatureInformation[];
	activeSignature: number;
	activeParameter: number;
}

/**
 * Takes over parameter hints: asks the real language server for the signature,
 * then re-renders it as colored HTML in the `documentation` field, which is the
 * only part of the built-in widget that goes through the markdown renderer.
 */
export class SignatureHintsProvider implements vscode.SignatureHelpProvider {
	/** Positions currently being resolved upstream, to break the recursion. */
	private readonly passthrough = new Set<string>();
	/** Last good answer per call site, so a slow reply does not blank the popup. */
	private readonly cache = new Map<string, CacheEntry>();
	/** Milliseconds the last upstream round trip took, for Show Diagnostics. */
	lastUpstreamMs = -1;
	/**
	 * Notified whenever this provider is actually reached. Being called is the
	 * only observable proof of winning the registration race — the registry's
	 * order is not exposed to extensions.
	 */
	onServed: ((languageId: string) => void) | undefined;

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
		this.onServed?.(document.languageId);

		const config = vscode.workspace.getConfiguration('signatureHints', document);
		// Stepping aside, not suppressing: the built-in popup takes over again.
		if (!config.get<boolean>('enabled', true)) {
			return undefined;
		}
		const mode = config.get<Mode>('mode', 'signature');
		if (mode === 'none') {
			return suppressed();
		}

		const call = resolveCall(document, position);
		const exclude = excludePatterns(config.get<ExcludeSetting>('exclude'), document.languageId);
		if (isExcluded(call?.name, exclude)) {
			return suppressed();
		}

		const started = Date.now();
		const upstream = await this.fetchUpstream(document, position, context);
		this.lastUpstreamMs = Date.now() - started;

		const resolved = this.settle(document, call, upstream);
		if (!resolved) {
			return undefined;
		}

		return this.build(resolved, call?.name, mode, config);
	}

	/**
	 * Picks between the fresh answer and the remembered one.
	 *
	 * While a request is pending VS Code keeps showing the previous hints, but a
	 * request that resolves to nothing hides the widget — and a language server
	 * loaded with typed stubs does return nothing now and then while you type.
	 * Replaying the last good answer for the same call site is what keeps the
	 * popup on screen.
	 */
	private settle(
		document: vscode.TextDocument,
		call: CallSite | undefined,
		upstream: vscode.SignatureHelp | undefined,
	): Resolved | undefined {
		const key = call && `${document.uri.toString()}|${call.name}|${call.position.line}|${call.position.character}`;

		if (upstream?.signatures?.length) {
			const activeSignature = clamp(upstream.activeSignature, upstream.signatures.length);
			if (key) {
				this.remember(key, upstream.signatures, activeSignature);
			}
			return {
				signatures: upstream.signatures,
				activeSignature,
				activeParameter: upstream.activeParameter ?? 0,
			};
		}

		const cached = key ? this.recall(key) : undefined;
		if (!cached) {
			return undefined;
		}
		return {
			signatures: cached.signatures,
			activeSignature: cached.activeSignature,
			// The server is the one that resolves `sep=` by name; without it, fall
			// back to counting commas.
			activeParameter: call?.activeParameter ?? 0,
		};
	}

	private remember(
		key: string,
		signatures: readonly vscode.SignatureInformation[],
		activeSignature: number,
	): void {
		this.cache.delete(key);
		this.cache.set(key, { signatures, activeSignature, at: Date.now() });
		while (this.cache.size > CACHE_MAX_ENTRIES) {
			// Map iterates in insertion order, so this drops the oldest.
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.cache.delete(oldest);
		}
	}

	private recall(key: string): CacheEntry | undefined {
		const entry = this.cache.get(key);
		if (!entry) {
			return undefined;
		}
		if (Date.now() - entry.at > CACHE_TTL_MS) {
			this.cache.delete(key);
			return undefined;
		}
		return entry;
	}

	get cacheSize(): number {
		return this.cache.size;
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
		resolved: Resolved,
		name: string | undefined,
		mode: Mode,
		config: vscode.WorkspaceConfiguration,
	): vscode.SignatureHelp | undefined {
		const overloads = config.get<Overloads>('overloads', 'all');
		const header = config.get<Header>('header', 'name');
		const style = config.get<SignatureStyle>('signatureStyle', 'compact');
		const maxDocLines = config.get<number>('maxDocLines', 0);
		const options: RenderOptions = {
			colors: config.get<'theme' | 'off'>('colors', 'theme'),
			monospace: config.get<boolean>('monospace', true),
		};

		const { signatures, activeSignature, activeParameter } = resolved;

		// The header line is always there and always plain text, so the name goes in
		// it when it is shown, and into the colored signature when it is not. Either
		// way it appears exactly once.
		const inSignature = header === 'none' ? name : undefined;
		const renderOne = (signature: vscode.SignatureInformation) =>
			this.renderSignature(signature, activeParameter, inSignature, style, options);

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

		const max = Math.max(1, config.get<number>('maxOverloads', 10));
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
	 * `name` is prepended when the header line is off, because language servers
	 * report a label that starts at the parenthesis and the name has to come from
	 * somewhere.
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
