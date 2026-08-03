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
  exclusions and `mode: "none"` suppress the popup without touching settings.
  **`enabled: false` must return `undefined` instead**, or turning the extension
  off hides parameter hints altogether rather than restoring the built-in ones.
  That was a real bug.
- The widget then does `let o = e.signatures[e.activeSignature]; if(!o) return;`,
  so zero signatures renders nothing.

**3. Provider ordering is newest-first.**

```js
static _compareByScoreAndTime(i,e){return i._score<e._score?1:i._score>e._score?-1:
  Krt(i.selector)&&!Krt(e.selector)?1:!Krt(i.selector)&&Krt(e.selector)?-1:
  i._time<e._time?1:i._time>e._time?-1:0}
function Krt(s){return typeof s=="string"?!1:Array.isArray(s)?s.some(Krt):!!s.isBuiltin}
```

Three keys in order: score, then non-builtin before builtin, then **newest
first**. `isBuiltin` is set on core selectors only, so it never separates us from
another extension — the tiebreak that decides is `_time`.

Selector specificity cannot help: `score()` assigns, never accumulates, and maxes
at 10. `{language:'*',scheme:'file'}` gets `p=10` from the scheme and then
`Math.max(p,5)` for the wildcard language, so it ties `{language:'python'}`
exactly.

Therefore `Registration` in `src/extension.ts` re-registers on a backoff for the
first minute, on `extensions.onDidChange`, and on every editor change.
`signatureHints.reclaimPriority` forces it.

Two things make this harder than it looks:

- **Losing is invisible.** A provider that is not first is never called, so there
  is nothing to observe. The only signal is the inverse: *being* called proves we
  won. `provider.onServed` reports that, and `Registration` stops chasing.
  **A win is not permanent.** Treating it as one was a real bug: the Python
  extension restarts its language server (interpreter resolution, config changes,
  analysis settling) and each restart re-registers Pylance as the newest, so it
  takes the lead back and our provider is never called again. `lastServed` is a
  timestamp, and priority is reclaimed whenever the cursor settles inside a call.
  **Do not guess from elapsed time** — that was the second bug. Retyping `(` in
  `range()` makes VS Code trigger on the character, so whoever is in front at
  that instant answers, and "we were called 300ms ago" says nothing about who
  that is. `provider.isFirst` measures it: set a probe key, run
  `executeSignatureHelpProvider`, see whether we are reached. The probe returns a
  truthy empty result, which stops the chain at us — so checking costs no
  language server query while we are winning.
- **Losing and returning nothing look identical.** Both leave the built-in popup
  on screen. `signatureHints.trace` and `provider.outcomes` are what separate
  them; without those the only honest answer is "I don't know which".
- **Re-registering cancels the popup.** `ParameterHintsModel` does
  `this._register(this.providers.onDidChange(this.onModelChanged,this))`, and
  `onModelChanged` calls `cancel()`. So never re-register on a timer once served
  — it would dismiss the popup mid-typing. While losing it is harmless: the popup
  being cancelled is the language server's.

A single retry at +2s was the original design and it was wrong. Pylance registers
when its server finishes starting, which with numpy-sized stubs is 20s or more.

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

The header line always exists — `this.domNodes.signature.innerText=""` then
`T(this.domNodes.signature,FP(".code"))`, unconditionally, plus `has-docs:after`
once documentation is present. ~13px that no return value collapses, hence
`signatureHints.header` defaulting to `name`: the space is spent either way.
Because
`white-space` is `initial`, line breaks must be `<br>` (or markdown hard breaks,
two trailing spaces) and indentation must be `&nbsp;`, not `\n` and spaces.

`max-width: 440px` is a literal, not a CSS variable, and extensions cannot inject
workbench CSS — **widening the popup is impossible**, only shortening its content
is. It is also why a tall widget jumps away from the cursor: VS Code flips a tall
content widget above the line and pins it to the viewport edge.

**6. The widget is capped and scrollable.**

```js
updateMaxHeight(){let t=`${Math.max(this.editor.getLayoutInfo().height/4,250)}px`;
  this.domNodes.element.style.maxHeight=t;…phwrapper…style.maxHeight=t}
```

and `.body` sits in a `DomScrollableElement` with `alwaysConsumeMouseWheel`. So
stacking every overload plus the full docstring into one `SignatureInformation`
costs nothing: the first signature stays at the top and the rest scrolls. That is
why `overloads` defaults to `all` — a single signature also means no `.multiple`
class, hence no `1/5` navigation buttons and no 22px controls column.

**7. Nothing re-triggers hints on cursor movement.**

`ParameterHintsModel.onCursorChange` only keeps an *already active* session
alive; a cursor landing inside an existing call starts nothing, and neither does
typing, since none of it is a trigger character. `Reopener` in `src/extension.ts`
watches selections and runs `editor.action.triggerParameterHints`. It keys on the
call site so movement within one call does not fight a manual `Escape`.

**8. Pending keeps the hints, resolved-to-nothing hides them.**

`ParameterHintsModel`'s state is `Default | Active | Pending`, and
`Pending` carries `previouslyActiveHints`, which the widget keeps rendering. So a
slow provider is harmless — but a provider that *resolves* to null drops the
state to `Default` and the popup vanishes mid-typing. Pylance does return nothing
now and then on typed stubs, hence the 30s per-call-site cache in `provider.ts`:
on an empty upstream reply the last good answer is replayed rather than passing
the emptiness through.

**9. The hover widget has none of these limits.**

`--vscode-hover-maxWidth` is a real CSS variable, set from
`_setHoverWidgetMaxDimensions`, and the widget is wrapped in a `ResizableContentWidget`
whose size is kept in a static (`YE._lastDimensions`) — so a user drag persists
across hovers.

`HideHoverAction` is registered `precondition: void 0` with **no `kbOpts`** — it
has no default keybinding. `Escape` closes the hover through a DOM listener in
the widget, which does not consume the key, so any other `Escape` binding fires
too. Harmless in a plain editor; in a notebook `notebook.cell.quitEdit` also runs
and drops you out of the cell. `package.json` contributes the missing binding
under `editorHoverVisible && notebookEditorFocused`; extension keybindings
outrank built-in ones, so it wins. No setting exposes it, but that is what `src/hover.ts` and `alt+h`
exist for: the parameter hints widget shows the signature, the hover shows the
prose.

## Module map

| File | Responsibility |
|---|---|
| `src/extension.ts` | Activation, provider re-registration, commands, diagnostics. |
| `src/provider.ts` | The provider: re-entrancy guard, upstream fetch, result assembly. |
| `src/callsite.ts` | Names the call at the cursor; per-language glob exclusions. |
| `src/simplify.ts` | Server label → `name(a, b=1)`, annotations stripped. |
| `src/hover.ts` | `alt+h`: the callee's docs inside its own parentheses. |
| `src/theme.ts` | Active theme JSON → scope → color map. |
| `src/tokenize.ts` | Signature label → classified tokens. |
| `src/render.ts` | Tokens → sanitizer-safe HTML. |

## Four things that will bite you

**Re-entrancy.** `provideSignatureHelp` calls
`vscode.executeSignatureHelpProvider`, which re-enters this provider. A map keyed
by `uri|line|character` makes the nested call return `undefined` so the chain
falls through to the language server. Remove the guard and you get infinite
recursion. It holds a **count, not a flag**: a fetch abandoned on
`upstreamTimeoutMs` keeps running, so two can overlap at one position, and the
first to finish would otherwise lift the guard from under the other.

**Being in front is not being on screen.** The provider order decides who answers
the *next* trigger; a popup already up was opened by whoever was in front then.
Typing `(` triggers on the character, before any of this extension's cursor
handling runs, so a built-in popup can sit there while we are perfectly well
registered. `provider.lastRenderedCall` records which call our own popup was
built for; `Reopener` re-triggers when it does not match — throttled, and never
when it does, which is what keeps `Escape` respected.

**Rewriting the label invalidates the server's offsets.**
`ParameterInformation.label` is usually a `[start, end]` pair into the *original*
label, so `compactSignature` has to recompute the active parameter's range as it
rebuilds the string — and `renderSignature` shifts it again when it prepends the
callee's name. Get this wrong and the highlight lands on the wrong parameter,
which looks like a bug in the language server rather than in here.

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
