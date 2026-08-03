/**
 * Rewrites a language server's signature label into the short form used by
 * JupyterLab's completer — parameter names and their defaults, nothing else:
 *
 *     (*values: object, sep: str | None = " ", flush: Literal[False] = False) -> None
 *     print(*values, sep=" ", flush=False)
 *
 * Typed stubs for numpy, pandas, matplotlib and scikit-learn carry annotations
 * far longer than the parameter names they describe, and the widget is capped at
 * 440px, so the annotations are what push the popup into a wall of wrapped text.
 */

export interface ParameterLike {
	label: string | [number, number];
}

export interface CompactSignature {
	label: string;
	/** Range of the active parameter within `label`, if it survived. */
	active: [number, number] | undefined;
	/**
	 * Parameter names alone, without defaults. Overloads of the same function
	 * usually differ only in the types of their arguments, not in the arguments
	 * themselves, so this is what tells a real alternative from a repeat.
	 */
	names: readonly string[];
}

/**
 * Keeps each parameter's name and default, drops its type annotation and the
 * return type. The active parameter's range is recomputed against the new
 * string, since the offsets the server gave point into the original.
 */
export function compactSignature(
	label: string,
	parameters: readonly ParameterLike[] | undefined,
	activeIndex: number,
): CompactSignature {
	const spans = parameterSpans(label, parameters);
	if (!spans.length) {
		return { label: emptyCall(label), active: undefined, names: [] };
	}

	let text = '(';
	let active: [number, number] | undefined;
	const names: string[] = [];

	for (const [index, span] of spans.entries()) {
		const piece = compactParameter(label.slice(span[0], span[1]));
		if (!piece) {
			continue;
		}
		names.push(piece.name);
		if (text.length > 1) {
			text += ', ';
		}
		const start = text.length;
		text += piece.text;
		if (index === activeIndex) {
			active = [start, text.length];
		}
	}

	return { label: `${text})`, active, names };
}

/** `name: Type = default` → `name=default`; markers like `/` and `*` drop out. */
function compactParameter(raw: string): { name: string; text: string } | undefined {
	const text = raw.trim();
	if (!text || text === '/' || text === '*') {
		return undefined;
	}

	const equals = findTopLevel(
		text,
		(char, before, rest) => char === '=' && !/[=!<>]/.test(before) && !rest.startsWith('='),
	);
	const declaration = equals < 0 ? text : text.slice(0, equals);
	const fallback = equals < 0 ? undefined : text.slice(equals + 1).trim();

	const colon = findTopLevel(declaration, (char) => char === ':');
	const name = (colon < 0 ? declaration : declaration.slice(0, colon)).trim();
	if (!name) {
		return undefined;
	}

	return { name, text: fallback ? `${name}=${fallback}` : name };
}

/**
 * Index of the first unnested character that `matches`, or -1. Strings are
 * skipped so a bracket or an `=` inside a default value cannot be mistaken for
 * structure. Angle brackets are deliberately not counted as nesting: a stray `>`
 * from `->` or a comparison would unbalance the depth, and generic arguments
 * never contain a top-level `:` or `=` anyway.
 */
function findTopLevel(
	text: string,
	matches: (char: string, before: string, rest: string) => boolean,
): number {
	let level = 0;
	let index = 0;

	while (index < text.length) {
		const char = text.charAt(index);
		if (char === '"' || char === "'") {
			index = endOfString(text, index);
			continue;
		}
		if (char === '(' || char === '[' || char === '{') {
			level++;
		} else if (char === ')' || char === ']' || char === '}') {
			level--;
		} else if (level === 0 && matches(char, text.charAt(index - 1), text.slice(index + 1))) {
			return index;
		}
		index++;
	}

	return -1;
}

/**
 * Character ranges of the parameters inside `label`. Servers usually give
 * offsets, sometimes the parameter text, and occasionally nothing usable — in
 * which case the label is split on its own top-level commas.
 */
function parameterSpans(
	label: string,
	parameters: readonly ParameterLike[] | undefined,
): [number, number][] {
	if (!parameters?.length) {
		return splitParameters(label);
	}

	const spans: [number, number][] = [];
	for (const parameter of parameters) {
		if (Array.isArray(parameter.label)) {
			spans.push([parameter.label[0], parameter.label[1]]);
			continue;
		}
		const at = label.indexOf(parameter.label);
		if (at < 0) {
			// One unresolvable parameter would misalign every index after it.
			return splitParameters(label);
		}
		spans.push([at, at + parameter.label.length]);
	}
	return spans;
}

/** Splits the outermost `(...)` group on its top-level commas. */
function splitParameters(label: string): [number, number][] {
	const open = label.indexOf('(');
	if (open < 0) {
		return [];
	}

	const spans: [number, number][] = [];
	let level = 0;
	let start = open + 1;
	let index = open;

	while (index < label.length) {
		const char = label.charAt(index);
		if (char === '"' || char === "'") {
			index = endOfString(label, index);
			continue;
		}
		if (char === '(' || char === '[' || char === '{') {
			level++;
		} else if (char === ')' || char === ']' || char === '}') {
			level--;
			if (level === 0) {
				push(spans, label, start, index);
				return spans;
			}
		} else if (char === ',' && level === 1) {
			push(spans, label, start, index);
			start = index + 1;
		}
		index++;
	}

	push(spans, label, start, label.length);
	return spans;
}

function push(spans: [number, number][], label: string, start: number, end: number): void {
	if (label.slice(start, end).trim()) {
		spans.push([start, end]);
	}
}

/** A label whose parameter list is empty, with the return type removed. */
function emptyCall(label: string): string {
	return label.indexOf('(') < 0 ? label : '()';
}

function endOfString(text: string, start: number): number {
	const quote = text.charAt(start);
	let index = start + 1;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === '\\') {
			index += 2;
			continue;
		}
		index++;
		if (char === quote) {
			break;
		}
	}
	return index;
}
