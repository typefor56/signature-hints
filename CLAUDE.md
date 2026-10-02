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
has no default keybinding. `Escape` closes the hover from the controller's
`_onKeyDown`, an editor-level DOM listener, which does not consume the key: any
other `Escape` binding fires too. Harmless in a plain editor; in a notebook
`notebook.cell.quitEdit` also runs and drops you out of the cell.

**With VSCodeVim the popup is Insert-mode only.** No API exposes Vim's mode
(`vim.mode` is a context key, `when` clauses only), but VSCodeVim sets
`editor.options.cursorStyle` per mode, readable by any extension:
`src/vimMode.ts` compares it with the Insert style (`vim.cursorStylePerMode.insert`
‖ `editor.cursorStyle` ‖ line) and the Normal one (‖ block); equal styles mean
it cannot tell and holds nothing back. Outside Insert, `Reopener.run` triggers
nothing and the provider answers `suppressed()` — truthy, so the language
server's popup does not show either; `onDidChangeTextEditorOptions` closes the
popup on leaving Insert and pokes the reopener on entering it. VSCodeVim is
detected by **its command** (`getCommands` includes `extension.vim_escape`),
never by `extensions.getExtension`: under `extensions.experimental.affinity` it
runs in another extension host, and from this one `getExtension('vscodevim.vim')`
is `undefined` — the extension believed there was no Vim and switched all of
this off (0.19.2–0.20.1). Commands, editor options and configuration are shared
by every host. **Extension tests cannot catch it**: the test host ignores
affinity and runs a single host. The proof is a normally launched VS Code under
`xvfb-run`, keys sent through `--remote-debugging-port`
(`Input.dispatchKeyEvent`), state read back through keybindings gated on
`parameterHintsVisible` / `vim.mode`: Normal → hidden; `i` in a call → visible;
one `Escape` → hidden and Normal.

**The server is asked ahead of the popup (`provider.warm`).** Most of the wait
was not the server but the time before anyone asked: the reopener's settle
delay, VS Code's own delay after `(`, and under VSCodeVim the whole stay in
Normal mode. `Reopener` warms on the leading edge of every cursor move in Insert
mode, and once the cursor has settled in Normal mode; `race()` reuses that
promise when asked for the same position and document version (one slot).
`fetchUpstream` already shares one request per call site, so typing does not
add requests. Measured with real keys and a 300 ms server: `i` in a call
500 → 90 ms, Insert mode 440 → 340 ms.

**In Insert mode, warm on arrival in a call only** (`Reopener.lastWarmed`).
Warming on every cursor move doubled the requests while typing arguments
(popup open, VS Code retriggers per key): Pylance CPU on a line with calls,
typed key by key in a 48-cell notebook, 11.0 s without the extension, 15.9 s
with 0.22.4, 10.5 s after. Key-to-text latency itself is the same with or
without the extension (60–80 ms per key in the probe, VSCodeVim's round trip).

**`reclaim` is throttled to once a second (`RECLAIM_THROTTLE_MS`).** Outside a
call nothing calls the provider, so `wasCalledFor` is false on every key and
`reclaim` re-registered twice per keystroke. Measured with a key held down
under VSCodeVim (80 repeats, notebook cell): 44 ms per key with Vim alone,
50–60 with 0.22.5, 44 after. VSCodeVim's own 40–45 ms per key (every character
is a round trip through its `type` override) is not ours to fix: typing letters
around it with `default:type` keybindings was tried and **reorders the text**
(`np.linspace(0, 10` came out as `nnspap.li(0,10ce `) — direct characters
overtake the ones still queued in VSCodeVim, which then puts the cursor back
where it believes it is. Do not retry.

**Opening on a known call shows the cache at once.** `a`, `A`, `I`, `o`, `O`
land on another position (or document version) than the warmed one, and the
leading-edge warm they fire would make the provider wait for the server again.
So when the popup is opening (`!context.isRetrigger`), the call site is cached
and no *finished* answer exists for the exact position, `race()` returns nothing
and `settle()` renders the cache (active parameter by comma count); the fetch
runs on for the next keystroke. Retriggers keep the deadline race, so typing
still gets the server's own active parameter. 330 → 70–125 ms for those keys.
In Normal mode the settled pass warms **two exact positions**: the cursor's
(`i`) and cursor + 1 (`a` — which on `(` is the first position inside the
call). The second fetch is queued behind the first (`after`): requests for one
call site are shared while in flight, so asking both at once would hand the
second position the first one's answer. `warmed` is a small map (`WARM_SLOTS`).
Exact answers need no trust rule, so `i` and `a` are immediate for variables'
methods and local functions too; `A`, `I`, `o`, `O` are only for imported names.

**Signatures are also cached by callee name** (`name|<name>`, written by
`remember()` next to the call-site entry). A `(` just typed has no call-site
entry, so opening falls back on the name: the second `np.linspace(` of a
session opens in ~75 ms instead of the server's time. The name can lie
(`x.append` on another `x`) and a comma count is not the server's active
parameter, so the opening path compares the fetch it left running with what it
showed; on a difference it parks the answer in the `warm` slot and calls
`onCorrected` → `Reopener.correct()` re-triggers (not after an `Escape` on that
call, not outside Insert mode). The retrigger finds the slot exact and done, so
it cannot loop. `settle()`'s own fallback stays call-site only: a name entry is
never replayed when the server answers nothing.

**Memory is only shown when it cannot be wrong (`src/imports.ts`, 0.22.1).**
Two rules, both lexical and conservative: the callee's root name is bound by an
`import` and by nothing else in the file — or in the whole notebook, imports
live in another cell — and the arguments before the cursor are positional (no
`=`, no `*`). Otherwise the opening path is skipped and the server is awaited.
Python only. Tried and measured instead of the name: asking Pylance for the
callee's *definition* to key the cache on — after an edit it costs as much as
the signature itself (120–350 ms), the time is the re-analysis, so nothing is
gained. **Never compare active parameters with Pylance's**: its top-level
`activeParameter` is not an argument index (9 for `np.linspace` at any
position; the real one is on the signature), so a comparison never matches and
the correction re-triggered — a visible blink — on every opening. The
correction compares signature labels only and is a safety net.

**Both `Escape` bindings hand the key on to VSCodeVim.** Two extensions binding
the same key have no guaranteed order, and these win over VSCodeVim's
`extension.vim_escape`: on their own they closed the popup and left Vim in
Insert mode. `vimEscape()` in `src/extension.ts` runs `extension.vim_escape`
after closing, when VSCodeVim is installed (a no-op in Normal mode). Verified in a
real extension host with VSCodeVim: Insert, `ab`, dismiss, `x` deletes a
character instead of inserting one.

**Do not bind on `editorHoverVisible`.** That listener runs *before* the
keybinding service resolves the key, so `_hoverVisibleKey` is already false when
the `when` clause is evaluated and the binding never matches. That was a real
bug. The extension sets its own `signatureHints.hoverShown` key, whose lifetime
it controls: set after `showHover`, cleared on the dismiss command and on any
cursor move. No setting exposes it, but that is what `src/hover.ts` and `alt+h`
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
`vscode.executeSignatureHelpProvider`, which re-enters this provider. The nested
call must return `undefined` so the chain falls through to the language server.
Remove the guard and you get infinite recursion.

**The nested call must identify itself, not be guessed at.** Anything waved past
this provider is answered by the language server and rendered raw, so a wrong
guess *is* the bug where the built-in popup appears. Two guesses failed:

- **Position.** The marker stays set for the whole round trip — seconds on numpy
  stubs — so every real request landing there was handed over.
- **Trigger kind.** `_executeSignatureHelpProvider` hardcodes `Invoke`, but so
  does `editor.action.triggerParameterHints`, which `Reopener` calls on every
  settled cursor. The most common case was exactly the one it missed.

The command copies its third argument into the context it hands providers —
`{triggerKind:1,isRetrigger:!1,triggerCharacter:o}` — so `NESTED_QUERY`, a
control character, is an exact marker. A control character is not typeable, is
not one of the registered trigger characters, and reaches the server only inside
an `Invoke` request, where LSP gives the trigger character no meaning.

Everything else is answered from the fetch already in flight for that call site,
or from cache. Nothing else falls through.

The guard also holds a **count, not a flag**: a fetch abandoned on
`upstreamTimeoutMs` keeps running, so two can overlap at one position, and the
first to finish would otherwise lift the guard from under the other.

**Being in front is not being on screen.** The provider order decides who answers
the *next* trigger; a popup already up was opened by whoever was in front then.
Typing `(` triggers on the character, before any of this extension's cursor
handling runs, so a built-in popup can sit there while we are perfectly well
registered. `provider.lastRenderedCall` records which call our own popup was
built for, and `Reopener` re-triggers when it does not match, throttled.

That record must be **dropped on every edit**. Keeping it across edits was a bug:
typing `np.random.rando` then `m(` accepts a completion, which inserts `random()`
in one edit and triggers hints at once — and the extension still held a record
from before the deletion, for the very same call site, so it concluded the popup
was already its own. Clearing on edit is self-correcting: staying in front means
VS Code re-queries on the content change and we render again immediately.

Re-triggering is then not enough on its own — asking again without re-registering
just reaches the same provider. What decides whether to re-check the order is
`provider.wasCalledFor(document)`: VS Code re-queries providers on every content
change, so a match between the document's version and the version we were last
called at proves the chain reached us since that edit. Exact, and free — while we
are in front no probe runs at all, which is what keeps this off the typing path.
Gating it on "does the popup look like ours" instead was a bug: every `,` is a
trigger character, so comma spam handed the popup back on each keystroke while
the throttled guess suppressed the re-registration that would have fixed it.

**Hold the lead, do not chase it.** `(` is a trigger character: VS Code queries
providers the instant it is typed, or the instant `Tab` accepts a completion
ending in one. Anything that reacts afterwards has already lost that query, and a
debounced handler does not run at all during a burst. `Reopener.keepLead` runs on
every selection change and every edit — leading edge, no debounce — since the
decisive keystrokes are the ones spent typing a bare name with no call in sight.
Reacting only once the cursor sat inside a call was a bug.

It stops **inside** a call, though: re-registering cancels whatever the widget is
showing, and the `(` that opens a popup reaches this handler too, so holding the
lead there dismissed the popup one frame after it appeared. By then the lead has
already been taken during the name, and the debounced pass re-registers if it
must — re-opening the popup itself, so nothing blinks.

This is free where it counts. `reclaim` re-registers only when
`wasCalledFor(document)` is false, and an open popup of ours is re-queried on
every content change — so while one is showing the answer is true and nothing
happens. The churn is confined to the case where no popup is up, which is exactly
when re-registering cancels nothing.

**Do not probe the order by running the chain.** An earlier attempt did, keyed by
cursor position — which is exactly where VS Code sends real requests, so a
keystroke arriving during a probe was answered by the probe and the popup went
blank. Measuring beats probing.

**Never step aside once reached** (`exclusive`, on by default). The chain stops
at the first answer, so returning `undefined` mid-session hands that keystroke to
the language server and its raw popup flashes inside ours. Return an empty result
instead. The one exception stays `enabled: false`. And because all this re-triggers eagerly, `Escape` needs
recording: `signatureHints.dismissHints` marks the call site and `Reopener`
leaves it alone until the cursor leaves.

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
