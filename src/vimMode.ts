/**
 * Which VSCodeVim mode an editor is in, read from its cursor style.
 *
 * No API exposes VSCodeVim's mode to other extensions (`vim.mode` is a context
 * key, readable only in `when` clauses). But VSCodeVim sets the editor's cursor
 * style per mode, and that is readable: Normal is a block, Insert is the
 * editor's own style (`editor.cursorStyle`, a line by default), each overridable
 * with `vim.cursorStylePerMode.*`. Pure: no `vscode` import.
 */

/** VS Code's `TextEditorCursorStyle` values, by setting name. */
const CURSOR_STYLES: Readonly<Record<string, number>> = {
	line: 1,
	block: 2,
	underline: 3,
	'line-thin': 4,
	'block-outline': 5,
	'underline-thin': 6,
};

export function cursorStyleOf(name: string | undefined): number | undefined {
	return name === undefined ? undefined : CURSOR_STYLES[name];
}

/**
 * Whether the cursor style says Vim is out of Insert mode (Normal, Visual…).
 * When Insert and Normal share a style, nothing can be told apart, so this
 * answers false and nothing is held back.
 */
export function isOutsideInsert(
	current: number | undefined,
	insertSetting: string | undefined,
	editorSetting: string | undefined,
	normalSetting: string | undefined,
): boolean {
	const insert = cursorStyleOf(insertSetting || editorSetting || 'line');
	const normal = cursorStyleOf(normalSetting || 'block');
	if (current === undefined || insert === undefined || insert === normal) {
		return false;
	}
	return current !== insert;
}
