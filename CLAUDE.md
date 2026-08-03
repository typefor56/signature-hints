# Signature Hints — notes for contributors

## The core trick

Extensions cannot draw their own popup near the cursor:

- Editor decorations are single-line — newlines in `contentText` are dropped.
- The hover widget is shared with every other hover provider, so Pylance's output
  mixes into ours.

So the extension does not build a widget. It registers its own
`SignatureHelpProvider`, calls the real language server underneath, and writes a
colored HTML string into `SignatureInformation.documentation` — the only part of
the built-in parameter hints widget that is passed through VS Code's markdown
renderer.

## Load-bearing VS Code internals

All verified against the installed VS Code **1.131.0**
(`/usr/share/code/resources/app/out/vs/workbench/workbench.desktop.main.{js,css}`).
Re-check these if behavior regresses after a VS Code update.

**1. The markdown sanitizer allows colored spans.**

```
/^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?
  (background-color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?
  (border-radius:[0-9]+px;)?$/
```

Applies to `style` on `<span>` only. The properties must appear **in this order**,
each terminated by `;`, with **no whitespace anywhere**. Anything else and the
whole attribute is dropped silently. `src/render.ts` builds the string to match;
the harness asserts every emitted style against this exact regex.

**2. The provider chain stops at the first truthy result.**

```js
async function (s,i,e,t,o){let n=s.ordered(i);for(let r of n)try{let a=await r.provideSignatureHelp(i,e,o,t);if(a)return a}catch(a){Ws(a)}}
```

Two consequences the extension relies on:

- Returning `{ signatures: [], activeSignature: 0, activeParameter: 0 }` is truthy,
  so it stops the chain — the language server is never asked. That is how
  exclusions and the off switch suppress the popup without touching settings.
- The widget then does `let o = e.signatures[e.activeSignature]; if(!o) return;`,
  so zero signatures renders nothing.

**3. Provider ordering is newest-first.**

`LanguageFeatureRegistry._compareByScoreAndTime`: higher score first, and for
equal scores `a._time < b._time → return 1`, so the **more recently registered**
provider is ordered first. Selector specificity cannot help — `score()` maxes at
10, which both `{language:'python'}` and `{language:'python',scheme:'file'}` reach.

Therefore `Registration.refresh()` in `src/extension.ts` re-registers after
startup (2s), on `extensions.onDidChange`, and when a new language is first
opened. `signatureHints.reclaimPriority` forces it.

**4. Empty `parameters` is safe.**

The widget does `r = o.parameters.length > 0; if(r) renderParameters(...) else span.textContent = o.label`,
and `o.parameters[a]` is only read behind `?.` or behind a falsy guard. The
extension always sends `parameters: []` because it does its own highlighting.

**5. Widget CSS constraints.**

```css
.parameter-hints-widget > .phwrapper { max-width: 440px }      /* not overridable */
.parameter-hints-widget .signature { padding: 4px 5px }        /* never collapses */
.parameter-hints-widget .docs .markdown-docs { white-space: initial }  /* spaces collapse */
.parameter-hints-widget .docs code { font-family: monospace; padding: 0 .4em;
                                     background: var(--vscode-textCodeBlock-background) }
```

The header line always exists — hence `signatureHints.header`. Because
`white-space` is `initial`, line breaks must be `<br>`, not `\n`.

## Module map

| File | Responsibility |
|---|---|
| `src/extension.ts` | Activation, provider re-registration, commands, diagnostics. |
| `src/provider.ts` | The provider: re-entrancy guard, upstream fetch, result assembly. |
| `src/callsite.ts` | Names the call at the cursor; glob exclusion matching. |
| `src/theme.ts` | Active theme JSON → scope → color map. |
| `src/tokenize.ts` | Signature label → classified tokens. |
| `src/render.ts` | Tokens → sanitizer-safe HTML. |

## Two things that will bite you

**Re-entrancy.** `provideSignatureHelp` calls
`vscode.executeSignatureHelpProvider`, which re-enters this provider. A `Set`
keyed by `uri|line|character` makes the nested call return `undefined` so the
chain falls through to the language server. Remove the guard and you get infinite
recursion.

**Markdown runs before HTML.** A Python signature like `(*values: object)` would
have its `*` parsed as emphasis. `escapeText` emits `&#42;` and friends as a
**single pass** — chained `.replace()` calls re-escape the `&` and `#` of the
entities produced by earlier steps, which was a real bug during development.

## Theme resolution

The active theme is found by matching `workbench.colorTheme` against
`contributes.themes[].label` / `.id` across `vscode.extensions.all`, which covers
built-in and installed themes alike.

`include` chains **must** be followed: `dark_modern.json` has no `tokenColors` at
all — they live in `dark_plus.json` → `dark_vs.json`. Included files are appended
first so the outer file wins ties.

Scope matching is TextMate's rule, simplified: dot-boundary prefix, longest
selector wins, later rule breaks ties. Descendant selectors
(`source.powershell variable.other.member`) are skipped — evaluating them needs a
full scope stack, which a standalone signature string does not have.

## Testing

There is no VS Code integration test. Everything except the actual widget
rendering is exercised by a headless harness that stubs the `vscode` module:

```sh
npm test   # compiles, then runs test/harness.js
```

It covers the tokenizer, theme resolution against the real Dark Modern and
Monokai files on disk, the fallback path, `tokenColorCustomizations` layering,
sanitizer conformance of every emitted style, call-site resolution (nested calls,
strings, comments, triple quotes, multi-line) and glob exclusions.

What it cannot cover, and needs `F5`: whether the spans actually paint, and
whether this provider wins the ordering race against Pylance.
