import * as vscode from 'vscode';
import { ThemeColors } from './theme';
import { tokenizeSignature } from './tokenize';

/** Highlight behind the active parameter; tracks the theme. */
const ACTIVE_BACKGROUND = 'var(--vscode-editor-selectionBackground)';
const DEFAULT_FOREGROUND = 'var(--vscode-editor-foreground)';

export interface RenderOptions {
	colors: 'theme' | 'off';
	monospace: boolean;
}

/**
 * Renders one signature label as sanitizer-safe HTML.
 *
 * VS Code's markdown sanitizer only keeps a `style` attribute on `<span>` when
 * it matches `color:…;background-color:…;border-radius:…px;` in exactly that
 * order, with no whitespace — hence the rigid string building below.
 */
export function renderSignatureHtml(
	label: string,
	active: readonly [number, number] | undefined,
	theme: ThemeColors,
	options: RenderOptions,
): string {
	let html = '';
	let offset = 0;

	for (const token of tokenizeSignature(label)) {
		const start = offset;
		const end = offset + token.text.length;
		offset = end;

		for (const [from, to] of splitAt(start, end, active)) {
			const piece = token.text.slice(from - start, to - start);
			const highlighted = !!active && from >= active[0] && to <= active[1];
			html += renderPiece(piece, token.scope, highlighted, theme, options);
		}
	}

	return options.monospace ? `<code>${html}</code>` : html;
}

function renderPiece(
	text: string,
	scope: string,
	highlighted: boolean,
	theme: ThemeColors,
	options: RenderOptions,
): string {
	const escaped = escapeText(text);
	if (!escaped) {
		return '';
	}

	const style = options.colors === 'theme' && scope ? theme.style(scope) : undefined;
	const foreground = style?.foreground ?? (highlighted ? DEFAULT_FOREGROUND : undefined);

	let body = escaped;
	if (style?.italic) {
		body = `<em>${body}</em>`;
	}
	if (highlighted || style?.bold) {
		body = `<strong>${body}</strong>`;
	}

	if (!foreground) {
		return body;
	}

	const declarations =
		`color:${foreground};` + (highlighted ? `background-color:${ACTIVE_BACKGROUND};border-radius:3px;` : '');
	return `<span style="${declarations}">${body}</span>`;
}

/** Cuts [start, end) on the active-parameter boundaries so a token can be partly highlighted. */
function splitAt(
	start: number,
	end: number,
	active: readonly [number, number] | undefined,
): [number, number][] {
	if (!active) {
		return [[start, end]];
	}
	const cuts = [start, end];
	for (const boundary of active) {
		if (boundary > start && boundary < end) {
			cuts.push(boundary);
		}
	}
	cuts.sort((a, b) => a - b);
	const ranges: [number, number][] = [];
	for (let i = 0; i < cuts.length - 1; i++) {
		const from = cuts[i]!;
		const to = cuts[i + 1]!;
		if (to > from) {
			ranges.push([from, to]);
		}
	}
	return ranges;
}

/**
 * Neutralises both HTML and Markdown. Markdown runs before the HTML is
 * rendered, so characters like `*` in `*values` are emitted as entities to keep
 * them from being parsed as emphasis; the renderer decodes them afterwards.
 */
export function escapeText(text: string): string {
	// A single pass: chained replaces would re-escape the `&` and `#` of the
	// entities produced by earlier steps.
	return text.replace(/[&<>"*_`[\]\\~|#]/g, (char) => ENTITIES[char] ?? char);
}

const ENTITIES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	'*': '&#42;',
	'_': '&#95;',
	'`': '&#96;',
	'[': '&#91;',
	']': '&#93;',
	'\\': '&#92;',
	'~': '&#126;',
	'|': '&#124;',
	'#': '&#35;',
};

/**
 * Character range of a parameter inside its signature label. Servers may give
 * offsets directly or just the parameter's text, in which case we search for it.
 */
export function parameterRange(
	signature: vscode.SignatureInformation,
	index: number,
): [number, number] | undefined {
	const parameter = signature.parameters?.[index];
	if (!parameter) {
		return undefined;
	}
	if (Array.isArray(parameter.label)) {
		return [parameter.label[0], parameter.label[1]];
	}
	const at = signature.label.indexOf(parameter.label);
	return at < 0 ? undefined : [at, at + parameter.label.length];
}

/** Pulls plain markdown out of the `string | MarkdownString` documentation union. */
export function documentationText(
	documentation: string | vscode.MarkdownString | undefined,
): string {
	if (!documentation) {
		return '';
	}
	return typeof documentation === 'string' ? documentation : documentation.value;
}
