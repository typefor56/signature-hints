/**
 * Which names in a Python source are bound by an `import` and nothing else.
 *
 * `np.linspace` is the same function wherever it is written; `df.plot` depends
 * on what `df` is on that line. Only the first kind can be shown from memory
 * without asking the language server again. Lexical and conservative on
 * purpose: a name it misses just waits for the server. Pure: no `vscode`.
 */
export function importedRoots(source: string): Set<string> {
	const roots = new Set<string>();
	const bind = (list: string): void => {
		for (const item of list.split(',')) {
			const match = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
			const name = match?.[2] ?? match?.[1]?.split('.')[0];
			if (name) {
				roots.add(name);
			}
		}
	};
	for (const match of source.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
		bind(match[1] ?? '');
	}
	for (const match of source.matchAll(/^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+\(?([^\n#)]+)/gm)) {
		bind(match[1] ?? '');
	}
	// Bound again by an assignment, a `def` or a `class`: no longer the import.
	for (const match of source.matchAll(/^[ \t]*(?:(?:def|class)[ \t]+(\w+)|(\w+)[ \t]*(?::[^=\n]*)?=(?!=))/gm)) {
		roots.delete(match[1] ?? match[2] ?? '');
	}
	return roots;
}

/**
 * Whether the arguments typed so far are plain positional ones, so that
 * counting commas gives the parameter the language server would give. A
 * keyword argument (`num=50`) or an unpacking (`*args`) breaks that.
 */
export function positionalOnly(argumentsBeforeCursor: string): boolean {
	return !/=|(^|[,(])\s*\*/.test(argumentsBeforeCursor);
}
