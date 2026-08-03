export interface Token {
	text: string;
	/** A dotted TextMate scope, or '' for whitespace and unclassified text. */
	scope: string;
}

const KEYWORDS = new Set([
	'None',
	'True',
	'False',
	'Ellipsis',
	'NotImplemented',
	'null',
	'undefined',
	'true',
	'false',
	'void',
	'never',
	'unknown',
	'any',
	'self',
	'cls',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/;
const OPERATORS = ['->', '=>', '**', '...', '==', '|', '&', '*', '=', '/', '?', '+', '-', '<', '>', '~'];

/**
 * Where in a signature the scanner currently is. Signature labels are short and
 * uniform enough across languages that this beats embedding a real grammar.
 */
type Slot = 'param' | 'type' | 'default' | 'return' | 'plain';

/**
 * Splits a signature label such as `(stop: SupportsIndex, /) -> range` into
 * colorable tokens. Not a language parser: it classifies by position, which is
 * accurate for Python and reasonable for TypeScript, Rust and friends.
 */
export function tokenizeSignature(label: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let slot: Slot = 'plain';

	const atTopLevel = () => parenDepth === 1 && bracketDepth === 0;
	const push = (text: string, scope: string) => tokens.push({ text, scope });

	while (index < label.length) {
		const rest = label.slice(index);
		const char = label.charAt(index);

		if (/\s/.test(char)) {
			const run = /^\s+/.exec(rest)![0];
			push(run, '');
			index += run.length;
			continue;
		}

		if (char === '"' || char === "'") {
			const literal = readString(label, index);
			push(literal, char === '"' ? 'string.quoted.double' : 'string.quoted.single');
			index += literal.length;
			continue;
		}

		const number = NUMBER.exec(rest);
		if (number && /[0-9]/.test(char)) {
			push(number[0], 'constant.numeric');
			index += number[0].length;
			continue;
		}

		const identifier = IDENTIFIER.exec(rest);
		if (identifier) {
			const name = identifier[0];
			push(name, classify(name, slot, label, index + name.length));
			if (slot === 'param') {
				slot = 'plain';
			}
			index += name.length;
			continue;
		}

		if (char === '(') {
			parenDepth++;
			push(char, 'punctuation.parenthesis');
			if (parenDepth === 1) {
				slot = 'param';
			}
			index++;
			continue;
		}

		if (char === ')') {
			parenDepth--;
			push(char, 'punctuation.parenthesis');
			if (parenDepth === 0) {
				slot = 'plain';
			}
			index++;
			continue;
		}

		if (char === '[' || char === '{') {
			bracketDepth++;
			push(char, 'punctuation.bracket');
			index++;
			continue;
		}

		if (char === ']' || char === '}') {
			bracketDepth--;
			push(char, 'punctuation.bracket');
			index++;
			continue;
		}

		if (char === ',') {
			push(char, 'punctuation.separator');
			if (atTopLevel()) {
				slot = 'param';
			}
			index++;
			continue;
		}

		if (char === ':') {
			push(char, 'punctuation.separator');
			if (atTopLevel()) {
				slot = 'type';
			}
			index++;
			continue;
		}

		if (char === '.') {
			push(char, 'punctuation.accessor');
			index++;
			continue;
		}

		const operator = OPERATORS.find((op) => rest.startsWith(op));
		if (operator) {
			push(operator, 'keyword.operator');
			if (operator === '->' || operator === '=>') {
				slot = 'return';
			} else if (operator === '=' && atTopLevel()) {
				slot = 'default';
			}
			index += operator.length;
			continue;
		}

		push(char, '');
		index++;
	}

	return tokens;
}

function classify(name: string, slot: Slot, label: string, after: number): string {
	if (KEYWORDS.has(name)) {
		return 'constant.language';
	}
	if (/^\s*\(/.test(label.slice(after))) {
		return 'entity.name.function';
	}
	switch (slot) {
		case 'param':
			return 'variable.parameter';
		case 'type':
		case 'return':
			return 'entity.name.type';
		default:
			return /^[A-Z]/.test(name) ? 'entity.name.type' : 'variable';
	}
}

function readString(label: string, start: number): string {
	const quote = label.charAt(start);
	let index = start + 1;
	while (index < label.length) {
		const char = label.charAt(index);
		if (char === '\\') {
			index += 2;
			continue;
		}
		index++;
		if (char === quote) {
			break;
		}
	}
	return label.slice(start, index);
}
