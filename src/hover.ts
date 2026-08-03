import * as vscode from 'vscode';
import { resolveCall } from './callsite';

/**
 * How long an explicit request stays honoured. The command fires
 * `editor.action.showHover` right after arming, so this only has to outlast one
 * round of hover resolution.
 */
const ARM_WINDOW_MS = 1500;

/**
 * Answers hovers for the call the cursor sits inside, so `alt+h` between the
 * parentheses of `np.array(|)` shows the same documentation as hovering the
 * function name.
 *
 * The parameter hints widget cannot serve this: it is capped at 440px wide and
 * ~250px tall by VS Code's stylesheet. The hover widget is wider, scrollable,
 * focusable with a second `alt+h`, and the user can drag it larger — VS Code
 * remembers the size and reuses it for every later hover.
 *
 * Hovering is otherwise left alone: the provider only answers while armed, so
 * moving the mouse never triggers it.
 */
export class CallDocsHoverProvider implements vscode.HoverProvider {
	private armedUntil = 0;
	/** Our own upstream query re-enters this provider; this breaks the recursion. */
	private busy = false;

	arm(): void {
		this.armedUntil = Date.now() + ARM_WINDOW_MS;
	}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Hover | undefined> {
		if (this.busy || Date.now() > this.armedUntil) {
			return undefined;
		}

		// Outside a call there is nothing to add — the language server's own hover
		// for the symbol under the cursor is already the right answer.
		const call = resolveCall(document, position);
		if (!call) {
			return undefined;
		}

		const contents = await this.fetchUpstream(document.uri, call.position);
		if (!contents.length) {
			return undefined;
		}
		return new vscode.Hover(contents, new vscode.Range(position, position));
	}

	private async fetchUpstream(
		uri: vscode.Uri,
		position: vscode.Position,
	): Promise<(vscode.MarkdownString | vscode.MarkedString)[]> {
		this.busy = true;
		try {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				uri,
				position,
			);
			return (hovers ?? []).flatMap((hover) => hover.contents);
		} catch {
			return [];
		} finally {
			this.busy = false;
		}
	}
}
