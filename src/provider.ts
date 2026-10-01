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

/** Hard bound on nesting through `executeSignatureHelpProvider`. */
const MAX_NESTED_FETCHES = 4;

/**
 * Marks this extension's own upstream query, as its trigger character.
 *
 * A control character cannot be typed, is not among the trigger characters the
 * provider registers, and reaches the language server only in a request whose
 * kind is already `Invoke` — where LSP says the trigger character carries no
 * meaning. So it is invisible to everything except the check above.
 */
const NESTED_QUERY = '\u0000signatureHints';

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
	/** Positions being resolved upstream, counted, to break the recursion. */
	private readonly passthrough = new Map<string, number>();
	/** One upstream request per call site. */
	private readonly inFlight = new Map<string, Promise<vscode.SignatureHelp | undefined>>();
	/** The call site the popup currently on screen was built for, and when. */
	lastRenderedCall: string | undefined;
	lastRenderedAt = 0;
	/** Document and version of the last real call, for `wasCalledFor`. */
	private lastCalledUri: string | undefined;
	private lastCalledVersion = -1;
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
	/**
	 * True while VSCodeVim is out of Insert mode on this document: the popup is
	 * then held back entirely — answering empty stops the chain, so the language
	 * server's own popup does not show either.
	 */
	isHeldBack: ((document: vscode.TextDocument) => boolean) | undefined;
	/**
	 * Tally of how each call ended. Losing the race and being reached but
	 * returning nothing look identical from the outside — the built-in popup
	 * shows either way — so the two have to be told apart from in here.
	 */
	readonly outcomes = {
		reentrant: 0,
		disabled: 0,
		suppressed: 0,
		nothingUpstream: 0,
		fromCache: 0,
		rendered: 0,
		empty: 0,
	};

	/** The answer fetched ahead for the cursor's position (see `warm`). */
	private warmed: { marker: string; version: number; help: Promise<vscode.SignatureHelp | undefined> } | undefined;

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
		// Our own `executeSignatureHelpProvider` call lands back here, and it is the
		// only request that may be waved through: whatever falls past this provider
		// is answered by the language server and rendered raw.
		//
		// It identifies itself. `_executeSignatureHelpProvider` copies its third
		// argument straight into the context it hands to providers —
		// `{triggerKind: 1, isRetrigger: false, triggerCharacter: o}` — so a
		// character no keyboard produces is an exact signature.
		//
		// Position was not: the marker stays set for the whole round trip, seconds
		// on numpy stubs, and every real request landing there was handed over.
		// Neither was the trigger kind: the command hardcodes Invoke, but so does
		// `editor.action.triggerParameterHints`, which this extension calls itself
		// whenever the cursor settles inside a call.
		if (context?.triggerCharacter === NESTED_QUERY) {
			this.outcomes.reentrant++;
			return undefined;
		}
		this.onServed?.(document.languageId);
		this.lastCalledUri = document.uri.toString();
		this.lastCalledVersion = document.version;

		const config = vscode.workspace.getConfiguration('signatureHints', document);
		// Stepping aside, not suppressing: the built-in popup takes over again.
		if (!config.get<boolean>('enabled', true)) {
			this.outcomes.disabled++;
			this.trace(config, 'disabled');
			return undefined;
		}
		if (this.isHeldBack?.(document)) {
			this.outcomes.suppressed++;
			this.trace(config, 'Vim is not in Insert mode');
			return suppressed();
		}
		const mode = config.get<Mode>('mode', 'signature');
		if (mode === 'none') {
			this.outcomes.suppressed++;
			this.trace(config, 'mode is none');
			return suppressed();
		}

		const call = resolveCall(document, position);
		const exclude = excludePatterns(config.get<ExcludeSetting>('exclude'), document.languageId);
		if (isExcluded(call?.name, exclude)) {
			this.outcomes.suppressed++;
			this.trace(config, `excluded: ${call?.name}`);
			return suppressed();
		}

		const site = call && callKey(document, call);
		const started = Date.now();
		const upstream = await this.race(document, position, site, config);
		this.lastUpstreamMs = Date.now() - started;
		// The language server can take seconds on numpy, and Escape may have left
		// Insert mode meanwhile: an answer landing now would open in Normal mode.
		if (this.isHeldBack?.(document)) {
			this.outcomes.suppressed++;
			this.trace(config, 'Vim left Insert mode while waiting');
			return suppressed();
		}

		const resolved = this.settle(site, call, upstream);
		if (!resolved) {
			this.outcomes.nothingUpstream++;
			this.trace(config, `nothing upstream for ${call?.name ?? '(no call)'} after ${this.lastUpstreamMs}ms`);
			// Having been reached and then stepping aside is what lets the built-in
			// popup appear in the middle of ours — the same call rendered by this
			// extension one keystroke and by the language server the next. Showing
			// nothing is the lesser evil, and the cache makes it rare.
			return config.get<boolean>('exclusive', true) ? suppressed() : undefined;
		}

		const built = this.build(resolved, call?.name, mode, config);
		if (built) {
			this.outcomes.rendered++;
			// Which call the popup on screen belongs to. Without this the extension
			// cannot tell its own popup from the language server's, and so cannot
			// know whether re-triggering would fix a stale one or fight an Escape.
			this.lastRenderedCall = site;
			this.lastRenderedAt = Date.now();
			this.trace(config, `rendered ${call?.name ?? '?'} (${resolved.signatures.length} sig, ${this.lastUpstreamMs}ms)`);
			return built;
		}
		this.outcomes.empty++;
		this.trace(config, `built nothing for ${call?.name ?? '?'}`);
		return config.get<boolean>('exclusive', true) ? suppressed() : undefined;
	}

	/**
	 * The upstream answer, or nothing if it takes too long.
	 *
	 * Typed stubs the size of numpy's ufuncs take seconds to resolve the first
	 * time, and the popup cannot wait for that on every keystroke. Past the
	 * deadline the cached answer for this call site is used instead and the fetch
	 * is left running, so it lands in the cache for the next keystroke.
	 */
	private async race(
		document: vscode.TextDocument,
		position: vscode.Position,
		site: string | undefined,
		config: vscode.WorkspaceConfiguration,
	): Promise<vscode.SignatureHelp | undefined> {
		// Asked ahead of time for this very position and revision: nothing to wait for.
		const warmed = this.warmed;
		const pending =
			warmed?.marker === key(document, position) && warmed.version === document.version
				? warmed.help
				: this.fetchUpstream(document, position, site);
		const deadline = config.get<number>('upstreamTimeoutMs', 250);
		if (deadline <= 0 || !site || !this.recall(site)) {
			return pending;
		}

		let timer: ReturnType<typeof setTimeout>;
		const expired = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), deadline);
		});
		try {
			return await Promise.race([pending, expired]);
		} finally {
			clearTimeout(timer!);
		}
	}

	/**
	 * Asks the language server before VS Code asks us.
	 *
	 * Most of the wait for the popup is not the server: it is the time before
	 * anyone asks — the settle delay after a cursor move, VS Code's own delay
	 * after `(`, and under VSCodeVim the whole stay in Normal mode. Starting the
	 * fetch when the cursor arrives lets those run in parallel, so the answer is
	 * already there (or on its way) when the popup is wanted. One slot: only the
	 * position the cursor is at can be asked for next.
	 */
	warm(document: vscode.TextDocument, position: vscode.Position, site: string): void {
		const marker = key(document, position);
		if (this.warmed?.marker === marker && this.warmed.version === document.version) {
			return;
		}
		this.warmed = { marker, version: document.version, help: this.fetchUpstream(document, position, site) };
	}

	private trace(config: vscode.WorkspaceConfiguration, message: string): void {
		if (config.get<boolean>('trace', false)) {
			this.log.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
		}
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
		site: string | undefined,
		call: CallSite | undefined,
		upstream: vscode.SignatureHelp | undefined,
	): Resolved | undefined {
		if (upstream?.signatures?.length) {
			const activeSignature = clamp(upstream.activeSignature, upstream.signatures.length);
			return {
				signatures: upstream.signatures,
				activeSignature,
				activeParameter: upstream.activeParameter ?? 0,
			};
		}

		const cached = site ? this.recall(site) : undefined;
		if (!cached) {
			return undefined;
		}
		this.outcomes.fromCache++;
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

	/**
	 * Whether the chain reached us for this exact revision of the document.
	 *
	 * The precise, cheap answer to "are we in front". VS Code re-queries providers
	 * on every content change, so if the version we were last called at matches
	 * the document's, the chain reached us since that edit — and a provider that
	 * is not first is never called. This replaced an explicit probe that ran the
	 * chain to find out: the probe identified itself by cursor position, which is
	 * exactly where VS Code sends its real requests, so a fast keystroke during
	 * one had its answer swallowed. Measuring beats probing, and costs nothing.
	 */
	wasCalledFor(document: vscode.TextDocument): boolean {
		return this.lastCalledUri === document.uri.toString() && this.lastCalledVersion === document.version;
	}

	/**
	 * Drops the record of which call the visible popup was built for.
	 *
	 * Any edit invalidates it: if we are still in front, VS Code re-queries on the
	 * content change and we render again immediately; if we are not, the record
	 * stays cleared, and that is what marks the popup as somebody else's.
	 */
	forgetOwnership(): void {
		this.lastRenderedCall = undefined;
	}

	/**
	 * Runs the provider chain again, with this provider disabled for the position.
	 *
	 * One fetch per call site at a time: a fetch abandoned on the deadline keeps
	 * running, and the next keystroke must join it rather than pile another query
	 * onto a language server that is already the slow part.
	 */
	async fetchUpstream(
		document: vscode.TextDocument,
		position: vscode.Position,
		site?: string,
	): Promise<vscode.SignatureHelp | undefined> {
		const existing = site && this.inFlight.get(site);
		if (existing) {
			return existing;
		}

		// Safety net. The trigger kind is what stops a real request from being
		// mistaken for our own, and if that assumption ever fails this keeps the
		// mistake from nesting: past a handful of live fetches, answer from the
		// cache rather than opening another one.
		if (this.passthrough.size > MAX_NESTED_FETCHES) {
			return undefined;
		}

		const marker = key(document, position);
		// A count, not a flag: two fetches can overlap at one position once a
		// timed-out one is left running, and the first to finish must not lift the
		// guard from under the other — that is unbounded recursion.
		this.passthrough.set(marker, (this.passthrough.get(marker) ?? 0) + 1);

		const request = (async () => {
			try {
				const help = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
					'vscode.executeSignatureHelpProvider',
					document.uri,
					position,
					NESTED_QUERY,
				);
				if (site && help?.signatures?.length) {
					this.remember(site, help.signatures, clamp(help.activeSignature, help.signatures.length));
				}
				return help;
			} catch (error) {
				this.log.appendLine(`[upstream] ${String(error)}`);
				return undefined;
			} finally {
				const depth = (this.passthrough.get(marker) ?? 1) - 1;
				if (depth > 0) {
					this.passthrough.set(marker, depth);
				} else {
					this.passthrough.delete(marker);
				}
				if (site) {
					this.inFlight.delete(site);
				}
			}
		})();

		if (site) {
			this.inFlight.set(site, request);
		}
		return request;
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

		// The header line is always there and always plain text, so the name goes in
		// it when it is shown, and into the colored signature when it is not. Either
		// way it appears exactly once.
		const inSignature = header === 'none' ? name : undefined;
		const text = (signature: vscode.SignatureInformation) =>
			signatureText(signature, resolved.activeParameter, inSignature, style);
		// Off by default: the highlight is a coloured band behind one argument, and
		// on a line that is already syntax-coloured it reads as noise more than as
		// information.
		const highlight = config.get<boolean>('highlightActiveParameter', false);
		const renderOne = (signature: vscode.SignatureInformation) => {
			const { label: line, active } = text(signature);
			return renderSignatureHtml(line, highlight ? active : undefined, this.theme, options);
		};

		// An overload that takes the same arguments is not an alternative. `range`
		// really has two — one argument, or three — but numpy's differ only in the
		// types of theirs, which is what the `...` stand for and exactly what
		// compact mode exists to hide. Comparing names alone is therefore right in
		// compact style and wrong in full, where the types are the point.
		const seen = new Set<string>();
		const signatures = resolved.signatures.filter((signature) => {
			const identity = text(signature).key;
			if (seen.has(identity)) {
				return false;
			}
			seen.add(identity);
			return true;
		});
		const activeSignature = Math.min(resolved.activeSignature, signatures.length - 1);

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

		// 0 caps nothing: once identical overloads are folded together there is
		// usually little left to cap, and hiding a genuine alternative behind
		// `… 1 more` is worse than one extra line.
		const max = config.get<number>('maxOverloads', 0);
		const shown = max > 0 ? signatures.slice(0, max) : signatures;
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

/**
 * One signature line as text — `print(*values, sep=" ", flush=False)` — with the
 * range of the active parameter inside it, and a key for spotting repeats.
 *
 * `name` is prepended when the header line is off, because language servers
 * report a label that starts at the parenthesis and the name has to come from
 * somewhere. Text and colour are kept apart so duplicates can be found before
 * anything is rendered.
 */
function signatureText(
	signature: vscode.SignatureInformation,
	activeParameter: number,
	name: string | undefined,
	style: SignatureStyle,
): { label: string; active: [number, number] | undefined; key: string } {
	let text = signature.label;
	let active = parameterRange(signature, activeParameter);
	// In full style the annotations are on show, so two overloads that differ in
	// them are two overloads; in compact style they have just been stripped.
	let key = text;

	if (style === 'compact') {
		const compact = compactSignature(text, signature.parameters, activeParameter);
		text = compact.label;
		active = compact.active;
		key = compact.names.join(',');
	}

	// A label that already carries the name — TypeScript's does — is left alone.
	if (name && text.startsWith('(')) {
		if (active) {
			active = [active[0] + name.length, active[1] + name.length];
		}
		text = name + text;
	}

	return { label: text, active, key };
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

/** Identifies a call site, stable while the cursor moves through its arguments. */
export function callKey(document: vscode.TextDocument, call: CallSite): string {
	return `${document.uri.toString()}|${call.name}|${call.position.line}|${call.position.character}`;
}

function key(document: vscode.TextDocument, position: vscode.Position): string {
	return `${document.uri.toString()}|${position.line}|${position.character}`;
}
