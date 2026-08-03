import * as fs from 'fs';
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import * as vscode from 'vscode';

/** A TextMate rule flattened to a single selector. */
interface Rule {
	/** Dotted scope selector, e.g. "variable.parameter". */
	selector: string;
	foreground?: string;
	fontStyle?: string;
	/** Position in the merged rule list; higher wins ties. */
	order: number;
}

export interface TokenStyle {
	/** A CSS color value: "#RRGGBB" or "var(--vscode-…)". */
	foreground: string;
	bold: boolean;
	italic: boolean;
}

/**
 * Theme colors the popup falls back to when the active theme's JSON cannot be
 * read. These CSS variables track the theme, so the result stays coherent even
 * though it is not the editor's exact token palette.
 */
const FALLBACK: Record<string, string> = {
	'variable.parameter': 'var(--vscode-debugTokenExpression-name)',
	'entity.name.type': 'var(--vscode-debugTokenExpression-type)',
	'string': 'var(--vscode-debugTokenExpression-string)',
	'constant.numeric': 'var(--vscode-debugTokenExpression-number)',
	'constant.language': 'var(--vscode-debugTokenExpression-boolean)',
	'entity.name.function': 'var(--vscode-debugTokenExpression-name)',
	'variable': 'var(--vscode-editor-foreground)',
	'keyword.operator': 'var(--vscode-editor-foreground)',
	'punctuation': 'var(--vscode-editor-foreground)',
};

const DEFAULT_FOREGROUND = 'var(--vscode-editor-foreground)';

/** Built-in theme labels, keyed by the theme kind VS Code reports. */
const BUILTIN_BY_KIND: Record<number, string> = {
	[vscode.ColorThemeKind.Light]: 'Light Modern',
	[vscode.ColorThemeKind.Dark]: 'Dark Modern',
	[vscode.ColorThemeKind.HighContrast]: 'Dark High Contrast',
	[vscode.ColorThemeKind.HighContrastLight]: 'Light High Contrast',
};

export class ThemeColors {
	private rules: Rule[] = [];
	private cache = new Map<string, TokenStyle>();
	private resolvedFrom: string | undefined;
	private themeLabel = '';

	/** Where the palette came from — surfaced by the diagnostics command. */
	get source(): string {
		return this.resolvedFrom ?? `${this.themeLabel || 'unknown theme'} (not found on disk, using fallback colors)`;
	}

	get ruleCount(): number {
		return this.rules.length;
	}

	reload(): void {
		this.rules = [];
		this.cache.clear();
		this.resolvedFrom = undefined;

		const config = vscode.workspace.getConfiguration();
		this.themeLabel =
			config.get<string>('workbench.colorTheme') ??
			BUILTIN_BY_KIND[vscode.window.activeColorTheme.kind] ??
			'Dark Modern';

		const file = findThemeFile(this.themeLabel);
		if (file) {
			try {
				const raw: RawRule[] = [];
				collectTokenColors(file, raw, 0);
				this.rules = flatten(raw);
				this.resolvedFrom = file;
			} catch {
				this.rules = [];
			}
		}

		this.applyCustomizations(config);
	}

	/**
	 * Layers `editor.tokenColorCustomizations` on top: first the global block,
	 * then the block scoped to the active theme, which is the more specific one.
	 */
	private applyCustomizations(config: vscode.WorkspaceConfiguration): void {
		const custom = config.get<Record<string, unknown>>('editor.tokenColorCustomizations');
		if (!custom) {
			return;
		}
		const blocks: unknown[] = [custom, custom[`[${this.themeLabel}]`]];
		const extra: RawRule[] = [];
		for (const block of blocks) {
			if (!block || typeof block !== 'object') {
				continue;
			}
			const rules = (block as { textMateRules?: unknown }).textMateRules;
			if (Array.isArray(rules)) {
				extra.push(...(rules as RawRule[]));
			}
		}
		if (extra.length) {
			const base = this.rules.length;
			this.rules.push(...flatten(extra).map((r) => ({ ...r, order: base + r.order })));
			this.cache.clear();
		}
	}

	/**
	 * Resolves a dotted TextMate scope. Matching follows TextMate's rule: a
	 * selector matches a scope when it is a dot-boundary prefix of it, the
	 * longest selector wins, and later rules break ties.
	 */
	style(scope: string): TokenStyle {
		const hit = this.cache.get(scope);
		if (hit) {
			return hit;
		}

		let best: Rule | undefined;
		for (const rule of this.rules) {
			if (!matches(rule.selector, scope)) {
				continue;
			}
			if (
				!best ||
				rule.selector.length > best.selector.length ||
				(rule.selector.length === best.selector.length && rule.order > best.order)
			) {
				best = rule;
			}
		}

		const style: TokenStyle = {
			foreground: best?.foreground ?? fallbackFor(scope),
			bold: !!best?.fontStyle?.includes('bold'),
			italic: !!best?.fontStyle?.includes('italic'),
		};
		this.cache.set(scope, style);
		return style;
	}
}

function fallbackFor(scope: string): string {
	let probe = scope;
	while (probe) {
		const hit = FALLBACK[probe];
		if (hit) {
			return hit;
		}
		const cut = probe.lastIndexOf('.');
		if (cut < 0) {
			break;
		}
		probe = probe.slice(0, cut);
	}
	return DEFAULT_FOREGROUND;
}

function matches(selector: string, scope: string): boolean {
	return scope === selector || scope.startsWith(selector + '.');
}

interface RawRule {
	scope?: string | string[];
	settings?: { foreground?: string; fontStyle?: string };
}

/**
 * Reads a theme file and everything it `include`s, appending rules so that the
 * outermost file ends up last and therefore wins.
 */
function collectTokenColors(file: string, out: RawRule[], depth: number): void {
	if (depth > 10) {
		return;
	}
	const parsed = jsonc.parse(fs.readFileSync(file, 'utf8')) as {
		include?: string;
		tokenColors?: RawRule[] | string;
	};
	if (!parsed) {
		return;
	}
	if (typeof parsed.include === 'string') {
		const included = path.resolve(path.dirname(file), parsed.include);
		if (fs.existsSync(included)) {
			collectTokenColors(included, out, depth + 1);
		}
	}
	// A string `tokenColors` points at a .tmTheme plist, which we do not parse.
	if (Array.isArray(parsed.tokenColors)) {
		out.push(...parsed.tokenColors);
	}
}

function flatten(raw: RawRule[]): Rule[] {
	const rules: Rule[] = [];
	raw.forEach((entry, index) => {
		const foreground = entry.settings?.foreground;
		const fontStyle = entry.settings?.fontStyle;
		if (!foreground && !fontStyle) {
			return;
		}
		const scopes = Array.isArray(entry.scope)
			? entry.scope
			: typeof entry.scope === 'string'
				? entry.scope.split(',')
				: [];
		for (const scope of scopes) {
			const selector = scope.trim();
			// Descendant selectors ("source.python variable") need the full scope
			// stack to evaluate, which a standalone signature string does not have.
			if (!selector || selector.includes(' ')) {
				continue;
			}
			rules.push({
				selector,
				...(foreground ? { foreground } : {}),
				...(fontStyle ? { fontStyle } : {}),
				order: index,
			});
		}
	});
	return rules;
}

/** Locates the JSON of the theme with the given label among installed extensions. */
function findThemeFile(label: string): string | undefined {
	for (const extension of vscode.extensions.all) {
		const themes = extension.packageJSON?.contributes?.themes;
		if (!Array.isArray(themes)) {
			continue;
		}
		for (const theme of themes) {
			if (theme?.label !== label && theme?.id !== label) {
				continue;
			}
			const file = path.resolve(extension.extensionPath, theme.path);
			if (fs.existsSync(file)) {
				return file;
			}
		}
	}
	return undefined;
}
