// Runs the extension's pure logic outside VS Code by stubbing the `vscode` module.
const Module = require('module');
const path = require('path');

const OUT = require('path').join(__dirname, '..', 'out');

const settings = {
  'workbench.colorTheme': undefined,
  'editor.tokenColorCustomizations': undefined,
};

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}

const vscodeStub = {
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  window: { activeColorTheme: { kind: 2 } },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in settings ? settings[key] : fallback),
    }),
  },
  extensions: {
    all: [
      {
        extensionPath: '/usr/share/code/resources/app/extensions/theme-defaults',
        packageJSON: {
          contributes: {
            themes: [
              { label: 'Dark Modern', path: './themes/dark_modern.json' },
              { label: 'Light Modern', path: './themes/light_modern.json' },
              { label: 'Monokai', path: './themes/monokai-color-theme.json' },
            ],
          },
        },
      },
      {
        extensionPath: '/usr/share/code/resources/app/extensions/theme-monokai',
        packageJSON: {
          contributes: { themes: [{ label: 'Monokai', path: './themes/monokai-color-theme.json' }] },
        },
      },
    ],
  },
  Position,
  Range,
  MarkdownString: class { constructor(v) { this.value = v || ''; } },
  SignatureInformation: class { constructor(label) { this.label = label; this.parameters = []; } },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};
// jsonc-parser resolves from the extension's node_modules
Module.globalPaths.push(require('path').join(__dirname, '..', 'node_modules'));

const { tokenizeSignature } = require(path.join(OUT, 'tokenize.js'));
const { ThemeColors } = require(path.join(OUT, 'theme.js'));
const { renderSignatureHtml, parameterRange, formatDocumentation } = require(path.join(OUT, 'render.js'));
const { resolveCallName, resolveCall, isExcluded, excludePatterns } = require(path.join(OUT, 'callsite.js'));
const { compactSignature } = require(path.join(OUT, 'simplify.js'));

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  got      ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${name}`);
};

// ---------- tokenizer ----------
console.log('\n== tokenizer ==');
const t1 = tokenizeSignature('(stop: SupportsIndex, /) -> range');
check('range: stop is a parameter', t1.find(t => t.text === 'stop').scope, 'variable.parameter');
check('range: SupportsIndex is a type', t1.find(t => t.text === 'SupportsIndex').scope, 'entity.name.type');
check('range: return type', t1.find(t => t.text === 'range').scope, 'entity.name.type');

const t2 = tokenizeSignature('(*values: object, sep: str | None = " ", end: str | None = "\\n", flush: Literal[False] = False) -> None');
const byText = (s) => t2.filter(t => t.text === s).map(t => t.scope);
check('print: *values param', byText('values')[0], 'variable.parameter');
check('print: sep param', byText('sep')[0], 'variable.parameter');
check('print: str type', byText('str')[0], 'entity.name.type');
check('print: None constant', byText('None')[0], 'constant.language');
check('print: False constant', byText('False')[0], 'constant.language');
check('print: string default', t2.find(t => t.text === '" "').scope, 'string.quoted.double');
check('print: Literal type', byText('Literal')[0], 'entity.name.type');
check('print: return None', byText('None').slice(-1)[0], 'constant.language');
check('print: label roundtrips', t2.map(t => t.text).join(''),
  '(*values: object, sep: str | None = " ", end: str | None = "\\n", flush: Literal[False] = False) -> None');

const t3 = tokenizeSignature('(a: number, b?: string[], c: Map<string, number> = new Map()) => void');
check('ts: b param', t3.find(t => t.text === 'b').scope, 'variable.parameter');
check('ts: roundtrips', t3.map(t => t.text).join(''), '(a: number, b?: string[], c: Map<string, number> = new Map()) => void');

const t4 = tokenizeSignature('(n: int = 1, m: float = 2.5e3) -> None');
check('numeric default', t4.find(t => t.text === '2.5e3').scope, 'constant.numeric');

// ---------- theme ----------
console.log('\n== theme (Dark Modern via include chain) ==');
const theme = new ThemeColors();
theme.reload();
console.log(`   source: ${theme.source}`);
console.log(`   rules : ${theme.ruleCount}`);
check('param color', theme.style('variable.parameter').foreground, '#9CDCFE');
check('type color', theme.style('entity.name.type').foreground, '#4EC9B0');
check('constant.language color', theme.style('constant.language').foreground, '#569cd6');
check('numeric color', theme.style('constant.numeric').foreground, '#b5cea8');
check('string color', theme.style('string.quoted.double').foreground, '#ce9178');
check('function color', theme.style('entity.name.function').foreground, '#DCDCAA');

console.log('\n== theme (Monokai) ==');
settings['workbench.colorTheme'] = 'Monokai';
const monokai = new ThemeColors();
monokai.reload();
console.log(`   source: ${monokai.source}`);
console.log(`   param=${monokai.style('variable.parameter').foreground} type=${monokai.style('entity.name.type').foreground} string=${monokai.style('string.quoted.double').foreground}`);
check('monokai differs from dark modern', monokai.style('string.quoted.double').foreground !== '#ce9178', true);

console.log('\n== theme (unknown -> fallback vars) ==');
settings['workbench.colorTheme'] = 'Some Theme That Does Not Exist';
const missing = new ThemeColors();
missing.reload();
check('fallback param', missing.style('variable.parameter').foreground, 'var(--vscode-debugTokenExpression-name)');
check('fallback punctuation', missing.style('punctuation.separator').foreground, 'var(--vscode-editor-foreground)');
settings['workbench.colorTheme'] = undefined;

console.log('\n== theme (tokenColorCustomizations override) ==');
settings['editor.tokenColorCustomizations'] = {
  textMateRules: [{ scope: 'variable.parameter', settings: { foreground: '#ABCDEF', fontStyle: 'italic' } }],
};
const custom = new ThemeColors();
custom.reload();
check('customization wins', custom.style('variable.parameter').foreground, '#ABCDEF');
check('customization italic', custom.style('variable.parameter').italic, true);
settings['editor.tokenColorCustomizations'] = undefined;

// ---------- render ----------
console.log('\n== render ==');
const SANITIZER = /^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/;

const html = renderSignatureHtml('(stop: SupportsIndex, /) -> range', [1, 20], theme, { colors: 'theme', monospace: true });
console.log('   ' + html);
const styles = [...html.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
check('every style passes the VS Code sanitizer regex', styles.every(s => SANITIZER.test(s)), true);
check('at least one highlighted span', styles.some(s => s.includes('background-color')), true);
check('active parameter is bold', /<strong>/.test(html), true);
check('wrapped in code', html.startsWith('<code>') && html.endsWith('</code>'), true);

const printHtml = renderSignatureHtml('(*values: object, sep: str | None = " ") -> None', [1, 16], theme, { colors: 'theme', monospace: false });
const printStyles = [...printHtml.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
check('print styles pass sanitizer', printStyles.every(s => SANITIZER.test(s)), true);
check('asterisk escaped as entity', printHtml.includes('&#42;'), true);
check('no raw asterisk left', !printHtml.includes('*'), true);
check('no raw angle bracket', !/[<>]/.test(printHtml.replace(/<\/?(span|strong|em|code)[^>]*>/g, '')), true);

const plain = renderSignatureHtml('(a: int)', undefined, theme, { colors: 'off', monospace: false });
check('colors=off emits no spans', !plain.includes('<span'), true);

check('parameterRange from offsets', parameterRange({ label: '(a: int, b: int)', parameters: [{ label: [1, 7] }, { label: [9, 15] }] }, 1), [9, 15]);
check('parameterRange from text', parameterRange({ label: '(a: int, b: int)', parameters: [{ label: 'a: int' }, { label: 'b: int' }] }, 1), [9, 15]);

// ---------- callsite ----------
console.log('\n== callsite ==');
const doc = (text) => ({
  getText: (range) => {
    const lines = text.split('\n');
    const slice = lines.slice(range.start.line, range.end.line + 1);
    if (slice.length) slice[slice.length - 1] = slice[slice.length - 1].slice(0, range.end.character);
    return slice.join('\n');
  },
  offsetAt: (p) => text.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character,
  positionAt: (offset) => {
    const before = text.slice(0, offset).split('\n');
    return new Position(before.length - 1, before[before.length - 1].length);
  },
});
const at = (text, line, character) => resolveCallName(doc(text), new Position(line, character));

check('simple call', at('range(', 0, 6), 'range');
check('dotted call', at('np.random.randint(1, ', 0, 21), 'np.random.randint');
check('nested call', at('print(len(', 0, 10), 'len');
check('after nested closes', at('print(len(x), ', 0, 14), 'print');
check('paren in string ignored', at('print("(" , ', 0, 12), 'print');
check('hash inside string not a comment', at('print("# hello", ', 0, 17), 'print');
check('comment ignored', at('# foo(\nprint(', 1, 6), 'print');
check('multi-line call', at('foo(\n  1,\n  ', 2, 2), 'foo');
check('subscript is not a call', at('d["a"](', 0, 7), undefined);
check('outside any call', at('x = 1', 0, 5), undefined);
check('triple-quoted string skipped', at('s = """a(b"""\nprint(', 1, 6), 'print');

// The hover for np.array lives on `array`, not on `np`.
const site = (text, line, character) => {
  const call = resolveCall(doc(text), new Position(line, character));
  return call && [call.name, call.position.line, call.position.character];
};
check('callee position is the last segment', site('np.array(', 0, 9), ['np.array', 0, 3]);
check('callee position, plain name', site('print(', 0, 6), ['print', 0, 0]);
check('callee position, second line', site('x = 1\nnp.random.randint(', 1, 18), ['np.random.randint', 1, 10]);
check('callee position, spaced paren', site('foo  (', 0, 6), ['foo', 0, 0]);
check('no call, no site', site('x = 1', 0, 5), undefined);

// Fallback used when the language server has not answered yet.
const argIndex = (text, line, character) =>
  resolveCall(doc(text), new Position(line, character))?.activeParameter;
check('first argument', argIndex('f(', 0, 2), 0);
check('second argument', argIndex('f(a, ', 0, 5), 1);
check('third argument', argIndex('f(a, b, ', 0, 8), 2);
check('commas in a nested call do not count', argIndex('f(g(a, b), ', 0, 11), 1);
check('commas in a list do not count', argIndex('f([a, b], ', 0, 10), 1);
check('commas in a string do not count', argIndex('f("a, b", ', 0, 10), 1);
check('nested call has its own count', argIndex('f(a, g(b, ', 0, 10), 1);

console.log('\n== exclusions ==');
check('bare name', isExcluded('print', ['print']), true);
check('bare name matches qualified', isExcluded('builtins.print', ['print']), true);
check('prefix glob', isExcluded('logging.info', ['logging.*']), true);
check('glob stops at dots', isExcluded('logging.a.b', ['logging.*']), false);
check('double star crosses dots', isExcluded('logging.a.b', ['logging.**']), true);
check('deep glob', isExcluded('np.random.randint', ['np.random.*']), true);
check('no false positive', isExcluded('pprint', ['print']), false);
check('empty patterns', isExcluded('print', []), false);
check('undefined name', isExcluded(undefined, ['print']), false);

console.log('\n== exclusions by language ==');
check('flat list still works', excludePatterns(['print'], 'python'), ['print']);
check('language bucket', excludePatterns({ python: ['print'], javascript: ['console.log'] }, 'python'), ['print']);
check('other language unaffected', excludePatterns({ python: ['print'] }, 'javascript'), []);
check('star applies everywhere', excludePatterns({ '*': ['assert'], python: ['print'] }, 'python'), ['assert', 'print']);
check('missing setting', excludePatterns(undefined, 'python'), []);

// ---------- compact signatures ----------
console.log('\n== compact signature ==');

// Pylance's label for print, with the offsets it reports for each parameter.
const PRINT = '(*values: object, sep: str | None = " ", end: str | None = "\\n", file: SupportsWrite[str] | None = None, flush: Literal[False] = False) -> None';
const printParams = [];
for (const text of ['*values: object', 'sep: str | None = " "', 'end: str | None = "\\n"',
                    'file: SupportsWrite[str] | None = None', 'flush: Literal[False] = False']) {
  const at = PRINT.indexOf(text);
  printParams.push({ label: [at, at + text.length] });
}
const printCompact = compactSignature(PRINT, printParams, 1);
check('print compacts to names and defaults', printCompact.label,
  '(*values, sep=" ", end="\\n", file=None, flush=False)');
check('active parameter tracks the rewrite', printCompact.label.slice(...printCompact.active), 'sep=" "');

// The numpy overload from the screenshot: annotations dwarf the names.
const NPARRAY = '(object: _ArrayLike, dtype: None = ..., *, copy: bool | _CopyMode = ..., order: _OrderKACF = ..., subok: bool = ..., ndmin: int = ..., like: _SupportsArrayFunc | None = ...) -> NDArray';
check('np.array without server offsets', compactSignature(NPARRAY, undefined, 0).label,
  '(object, dtype=..., copy=..., order=..., subok=..., ndmin=..., like=...)');
check('bare * marker dropped', compactSignature(NPARRAY, undefined, 0).label.includes(', *,'), false);

check('positional-only marker dropped', compactSignature('(stop: SupportsIndex, /) -> range', undefined, 0).label, '(stop)');
check('no parameters', compactSignature('() -> None', undefined, 0).label, '()');
check('nested default keeps its commas', compactSignature('(a: Dict[str, int] = {"x": 1, "y": 2})', undefined, 0).label, '(a={"x": 1, "y": 2})');
check('comparison in a default is not a split', compactSignature('(a: bool = x >= 1)', undefined, 0).label, '(a=x >= 1)');
check('string label parameters', compactSignature('(a: int, b: str = "z")', [{ label: 'a: int' }, { label: 'b: str = "z"' }], 1).label, '(a, b="z")');
check('typescript label untouched by name prefixing', compactSignature('(a: number, b?: string[]): void', undefined, 0).label, '(a, b?)');

// ---------- documentation is not live HTML ----------
console.log('\n== docstring escaping ==');
// supportHtml is on for the signature's colours, and it applies to the whole
// string — so a docstring must not be able to bring its own tags.
const evil = { value: 'See <img src="https://example.invalid/beacon.png"> and <b>bold</b>.' };
check('markdown docstring tags neutralised', formatDocumentation(evil, 0).includes('<'), false);
check('markdown docstring text kept', formatDocumentation(evil, 0).includes('&lt;img src="https://example.invalid/beacon.png">'), true);
check('no tag can open', /<[a-zA-Z/]/.test(formatDocumentation(evil, 0)), false);
check('plain docstring tags neutralised', formatDocumentation('a <script>x</script> b', 0).includes('<script'), false);
check('markdown structure survives', formatDocumentation({ value: '# Title\n\n- one\n- two' }, 0).includes('# Title'), true);
check('fences survive', formatDocumentation({ value: '```py\nx = 1\n```' }, 0), '```py\nx = 1\n```');
check('blockquote survives', formatDocumentation({ value: '> note' }, 0), '> note  ');

// ---------- identical overloads ----------
console.log('\n== overload dedupe ==');
// Overloads are folded on their argument names: what the `...` stand for is the
// argument's type, which is exactly what compact mode drops.
const names = (label) => compactSignature(label, undefined, 0).names.join(',');
const distinct = (labels) => [...new Set(labels.map(names))];

// range genuinely has two: one argument, or three.
check('range keeps both overloads', distinct([
  '(stop: SupportsIndex, /) -> range[int]',
  '(start: SupportsIndex, stop: SupportsIndex, step: SupportsIndex = ..., /) -> range[int]',
]), ['stop', 'start,stop,step']);

// np.array: same arguments every time, only the types differ.
check('array collapses to one', distinct([
  '(object: _ArrayType, dtype: None = ..., *, copy: bool = ..., order: _OrderKACF = ..., subok: Literal[True] = ..., ndmin: int = ..., like: _SupportsArrayFunc = ...) -> _ArrayType',
  '(object: _ArrayLike, dtype: DTypeLike = ..., *, copy: bool = ..., order: _OrderKACF = ..., subok: bool = ..., ndmin: int = ..., like: _SupportsArrayFunc = ...) -> NDArray',
  '(object: object, dtype: DTypeLike, *, copy: bool = ..., order: _OrderKACF = ..., subok: bool = ..., ndmin: int = ..., like: _SupportsArrayFunc = ...) -> NDArray',
]), ['object,dtype,copy,order,subok,ndmin,like']);

// A required argument and one with a default are the same argument.
check('a default does not make an overload', distinct([
  '(a: int, dtype: DTypeLike) -> int',
  '(a: int, dtype: DTypeLike = ...) -> int',
]).length, 1);

// A different argument list must survive.
check('different names stay distinct', distinct([
  '(a: int, b: int) -> int',
  '(x: int, y: int) -> int',
]).length, 2);
check('an extra argument stays distinct', distinct([
  '(a: int) -> int',
  '(a: int, b: int) -> int',
]).length, 2);

// ---------- documentation ----------
console.log('\n== documentation ==');
const plainDoc = formatDocumentation('Prints the values.\n\nsep\n  string inserted between values.', 0);
check('plainDoc text keeps line breaks', plainDoc.includes('<br>'), true);
check('plainDoc text indentation survives', plainDoc.includes('&nbsp;&nbsp;string inserted'), true);
check('plainDoc text is escaped', formatDocumentation('a * b _c_', 0).includes('&#42;'), true);
check('doc truncated to maxDocLines', formatDocumentation('a\nb\nc\nd', 2), 'a<br>b<br>…');
check('zero means unlimited', formatDocumentation('a\nb\nc\nd', 0), 'a<br>b<br>c<br>d');
check('empty documentation', formatDocumentation(undefined, 12), '');
check('markdown gets hard breaks',
  formatDocumentation({ value: 'Returns x.\nsep\n  the separator' }, 0),
  'Returns x.  \nsep  \n  the separator  ');
check('markdown fence left alone', formatDocumentation({ value: '```py\na = 1\n```' }, 0), '```py\na = 1\n```');

// --- VSCodeVim mode from the cursor style (vimMode.ts) ---
const { isOutsideInsert, cursorStyleOf } = require(path.join(OUT, 'vimMode.js'));
const LINE = cursorStyleOf('line');
const BLOCK = cursorStyleOf('block');
check('vim defaults: block cursor is Normal', isOutsideInsert(BLOCK, '', undefined, ''), true);
check('vim defaults: line cursor is Insert', isOutsideInsert(LINE, '', undefined, ''), false);
check('vim: Insert style set to block-outline', isOutsideInsert(cursorStyleOf('block-outline'), 'block-outline', 'line', 'block'), false);
check('vim: editor cursorStyle used for Insert', isOutsideInsert(cursorStyleOf('underline'), '', 'underline', ''), false);
check('vim: same style for both modes holds nothing back', isOutsideInsert(BLOCK, 'block', undefined, 'block'), false);
check('vim: unknown cursor style holds nothing back', isOutsideInsert(undefined, '', undefined, ''), false);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures ? 1 : 0);
