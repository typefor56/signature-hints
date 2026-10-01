# Changelog

## 0.22.4

- Documentation only: the README says up front that the extension is made for
  VSCodeVim users too, and the comparison table lists the Vim behaviour and
  the opening speed. `vim` and `vscodevim` are added to the keywords.

## 0.22.3

- Documentation only: the README has a "How fast it opens" section with the
  measured opening times since 0.21 and the rules for when remembered
  signatures are shown.

## 0.22.2

- **`a` is as immediate as `i` for every callee.** In Normal mode only the
  cursor's own position — where `i` lands — had its answer fetched ahead; `a`
  lands one character further, so for a method of a variable or a local
  function it waited for the language server. Both positions are now fetched
  ahead (about 340 → 90 ms with a server answering in 300 ms).

## 0.22.1

- **The popup no longer blinks right after it opens.** 0.22.0 compared the
  remembered answer with the language server's, active parameter included —
  but Pylance's top-level active parameter is not an argument index (9 for
  `np.linspace`, wherever the cursor is), so the two never matched and the
  popup was redrawn on every opening. Only the signatures are compared now.
- **Remembered signatures are only shown when they cannot be wrong.** The
  callee has to come from an `import` that is never bound again (`np.…`,
  `plt.…`, `from numpy import linspace`), so the name is that function wherever
  it is written, and the arguments typed so far have to be positional. A
  method of a variable (`df.plot(`, `x.append(`) or a local function waits for
  the language server, as before 0.22.0: no stale signature is ever shown for
  them. Python only.

## 0.22.0

- **Typing `(` after a function seen before opens the popup at once.**
  Signatures are now also remembered by callee name, so the second
  `np.linspace(` of a session — on any line, in any cell — no longer waits for
  the language server (about 350 → 75 ms with a server answering in 300 ms).
  The first one still takes the server's time: there is nothing to reuse yet.
- **The popup corrects itself.** When it opens on remembered signatures and
  the server then answers something else — the same name bound to another
  function, or another active parameter — it is re-rendered with the server's
  answer as soon as that arrives.

## 0.21.2

- **`a` on a call's opening parenthesis opens the popup at once too.** In
  Normal mode the cursor on `(` is not in the call yet, so nothing was fetched
  ahead and `a` waited for the language server (about 360 ms against 70 ms
  elsewhere). The position `a` lands on is now fetched ahead as well.

## 0.21.1

- **Every way into Insert mode opens the popup at once**, not only `i`: `a`,
  `A`, `I`, `o`, `O` under VSCodeVim, and coming back to a call seen before.
  When the popup opens on a call whose signatures are already known, they are
  shown right away and the language server's answer serves the next keystroke.
  Measured with a server answering in 300 ms: 330 → 70–125 ms. Signatures are
  remembered for 5 minutes per call site (was 30 seconds).

## 0.21.0

- **The popup opens sooner.** The language server is now asked as soon as the
  cursor arrives in a call, instead of after the cursor has settled and VS Code
  has asked in turn. Under VSCodeVim the answer is fetched while still in
  Normal mode, so `i` inside a call opens the popup at once. Measured with a
  server answering in 300 ms: `i` in a call 500 → 90 ms, moving into a call or
  typing `(` in Insert mode 440 → 340 ms. The settle delay after a cursor move
  goes from 120 to 50 ms.

## 0.20.2

- **The VSCodeVim behaviour now works when VSCodeVim runs in another extension
  host** (`extensions.experimental.affinity`, also set up by extensions that
  depend on it). From there this extension could not see VSCodeVim, took it for
  absent, and so showed the popup in Normal mode and needed a second `Escape`
  to leave Insert mode. VSCodeVim is now detected by its command, which every
  host shares. Without VSCodeVim nothing changes.

## 0.20.1

- **No popup in Normal mode after a slow answer.** On numpy, the language
  server can take seconds; an `Escape` pressed meanwhile left Insert mode, and
  the answer then opened the popup in Normal mode (a second `Escape` was needed
  to close it). The mode is now checked again once the answer arrives. Without
  VSCodeVim nothing changes.

## 0.20.0

- **With VSCodeVim, the popup only shows in Insert mode.** In Normal mode the
  cursor passes through calls without opening anything; entering Insert inside
  a call opens it, and leaving Insert by any key closes it. The mode is read
  from the cursor style VSCodeVim sets per mode.
- `Escape` on the popup now reaches VSCodeVim even when it runs in another
  extension host (`extensions.experimental.affinity`).

## 0.19.2

- **`Escape` with VSCodeVim closes the popup and returns to Normal mode.** The
  popup's (and the `alt+h` hover's) `Escape` binding won the key over
  VSCodeVim's, so the popup closed but Vim stayed in Insert mode. The key is
  now handed on to Vim as well; in Normal mode it only closes the popup.

## 0.19.1

- Marketplace copy refreshed: the description and the README no longer
  advertise a one-key toggle.

## 0.19.0

- **`signatureHints.highlightActiveParameter`**, off by default. The argument
  under the cursor is no longer shown in bold on a highlighted band; on a line
  that is already syntax-coloured the band reads as noise. Set it to `true` to
  bring it back — the position is tracked either way, so it costs nothing.
- **Fixed the single blink when the popup first appeared.** Holding the provider
  lead re-registers, and re-registering cancels whatever the widget is showing —
  including the popup the `(` had just opened, since that keystroke reaches the
  handler too. The lead is now held only while the cursor is outside a call,
  which is where it is needed and where nothing can be cancelled: by the time `(`
  is typed the lead has already been taken during the name.


## 0.18.0

- **The built-in popup can no longer take over. The upstream query now identifies
  itself.** Everything that falls past this provider is answered by the language
  server and rendered raw, so the only request allowed through must be the
  extension's own — and until now it was recognised by guesswork.
  By cursor position (up to 0.16.0): the marker stays set for the whole round
  trip, seconds on numpy stubs, so every real request landing on that position
  was handed over. By trigger kind (0.17.0): the command hardcodes `Invoke`, but
  so does `editor.action.triggerParameterHints`, which this extension calls
  itself every time the cursor settles inside a call — so the fix missed the most
  common case, which is why nothing changed.
  `_executeSignatureHelpProvider` copies its third argument straight into the
  context it gives providers, so the query now carries a control character as its
  trigger character. Nothing else can produce it. Everything else is answered
  from the fetch already in flight, or from cache, and never handed over.
- `releases/signature-hints-0.15.0.vsix` is kept in the repository as the v1
  fallback.


## 0.17.0

- **Fixed the real cause of the built-in popup appearing: it was being handed
  the keystroke, not winning a race.** The re-entrancy guard identified our own
  upstream query by cursor position alone, and that query stays open for as long
  as the language server takes — seconds on numpy-sized stubs. Any *real* request
  landing on the same position during that window was waved through to the
  language server, which rendered it.
  This is what both previous symptoms were. Up to 0.15.0 the extension
  re-registered aggressively, which cancelled the intruding popup a moment after
  it appeared: that was the blink on every comma. 0.16.0 stopped re-registering
  when the lead was already proven, so the intruding popup simply stayed: that
  was the alternation. One bug, two faces.
  `_executeSignatureHelpProvider` hardcodes `triggerKind: 1`, while typing
  produces `TriggerCharacter` or `ContentChange`, so the kind separates the two
  for certain. A real request now carries on and is answered from the fetch
  already in flight for that call site — no second query, no fallthrough.
- A hard bound on nesting, in case that assumption is ever wrong.


## 0.16.0

- **Fixed: the popup blinked on every comma.** Holding the provider lead, added
  in 0.13.0, re-registered too eagerly — and re-registering cancels whatever the
  parameter hints widget is showing, because the model listens to the provider
  registry. Typing `,` inside `range(1, )` reaches the extension before VS Code's
  query for the new revision does, so the "are we in front" check read false for
  a moment and the popup was dismissed and immediately reopened. A successful
  render now vouches for the lead for 2s, which is exactly the situation where
  re-registering could only do harm: having rendered proves we were in front.
- `repository`, `bugs`, `homepage` and `icon` are set, so the Marketplace listing
  has a source link and the README's images resolve once the repository is
  pushed.

## 0.15.0

- **Security: a docstring could no longer make the editor fetch a URL.**
  `supportHtml` is on so the signature can be coloured, and it applies to the
  whole string — including documentation coming from whatever package is
  installed. VS Code's sanitizer permits `img`, `video` and `source` over
  `http`/`https`, so raw HTML in a docstring was live, reachable from a `.pyi`
  stub without anything being imported. Documentation now has `<` escaped, so the
  extension's own markup is the only live HTML in the popup.
- **The call-site scan is bounded in characters**, not just in lines: 30 lines of
  a minified file can be megabytes, and this runs on cursor movement.
- Declared `capabilities`: usable in untrusted and virtual workspaces. The
  extension runs no workspace code, spawns no process, opens no connection and
  writes no file.
- Added `SECURITY.md`.

## 0.14.0

- **Overloads taking the same arguments are shown once.** `range` really has two
  — one argument, or three — and both are kept. `np.array` and `np.zeros_like`
  have several that differ only in the *types* of their arguments, which is what
  the `...` stand for and exactly what compact mode exists to hide, so they were
  stacked as near-identical lines. They fold into one.
  The comparison is on argument names alone, so a required argument and one with
  a default count as the same argument. In `signatureStyle: "full"`, where the
  types are the point, the whole label is compared instead and nothing folds.
- **`signatureHints.maxOverloads` defaults to `0`** — no cap. With repeats folded
  away there is usually little left to cap, and hiding a real alternative behind
  `… 1 more` is worse than one extra line. Set a number to cap; the `… N more`
  line works as before.

## 0.13.0

- **Fixed for real: the built-in popup won whenever you typed at speed.** Two
  gaps, both in the same place. The cursor handler returned early when there was
  no call yet — so while typing `np.zeros_like`, the moment that decides
  everything, the provider order was never checked. And it was debounced by
  120ms, so during a fast burst it did not run at all before the `(` landed.
  Reacting cannot work here: `(` is a trigger character, so VS Code queries
  providers the instant it is typed, or the instant `Tab` accepts a completion
  ending in one, and whoever is in front at that moment answers. The lead is now
  held continuously — checked on every cursor move and every edit, including the
  ones spent typing a bare name — instead of being chased after it is lost.
  This is free where it matters: the check re-registers only when the chain has
  not reached us for the current revision, and a popup of ours is re-queried on
  every edit, so nothing happens at all while one is showing.

## 0.12.0

- **The built-in popup can no longer appear once this extension is reached.**
  `signatureHints.exclusive` (on by default). VS Code's provider chain stops at
  the first answer, so returning nothing hands the request to the language server
  — which is what produced the alternation: the same call rendered by this
  extension one keystroke and by Pylance the next. Nothing is shown instead.
  `enabled: false` still steps aside; that is its whole purpose.
- **Removed the order probe, which was racing against itself.** It identified its
  own request by cursor position — exactly where VS Code sends real ones — so a
  keystroke landing during a probe had its answer swallowed and the popup went
  blank or fell through. `wasCalledFor` already answers the same question
  exactly, from the document version, at no cost, so the probe is gone along with
  its throttle. Priority is reclaimed whenever the chain has not reached us for
  the current revision.

## 0.11.0

- **Fixed: spamming commas, or typing a call fast, brought the built-in popup
  back.** Both were the same mistake. The provider-order check was gated on
  whether the visible popup looked like ours, which is a guess, and it was
  throttled — so the extension would re-trigger without ever re-registering,
  which just asks the same provider again. Meanwhile every `,` is a trigger
  character, so each one handed the popup back to whoever was in front.
  There is an exact signal available instead: VS Code re-queries providers on
  every content change, so if we were last called at the document's current
  version, the chain reached us since that edit — and a provider that is not
  first is never called. That now decides when to check the order, past any
  throttle. It also keeps the check off the typing path: while we are in front
  the answer is already known, and no probe runs at all.

## 0.10.0

- **Fixed: accepting a completion left the built-in popup up.** Typing
  `np.random.rando` then `m(` quickly accepts the suggestion, which inserts
  `random()` in one edit and triggers parameter hints immediately. The extension
  believed the popup was already its own — it had rendered for that same call
  site before the deletion, and nothing invalidated that. Ownership is now
  dropped on every edit: if we are still in front, VS Code re-queries on the
  content change and we render again at once; if we are not, the record stays
  cleared and the foreign popup is replaced. That evidence also forces a fresh
  provider-order check past the usual throttle, since re-triggering without
  re-registering only asks the same provider again.
- **`Escape` now really keeps you in the notebook cell after `alt+h`.** The 0.8.1
  fix could not work: the hover hides itself from an editor `_onKeyDown` DOM
  listener that runs *before* the keybinding service resolves the key, so
  `editorHoverVisible` was already false when the `when` clause was evaluated.
  The extension sets its own context key instead, which it controls the lifetime
  of.
- **`Escape` on the popup is now remembered.** With the extension re-triggering
  more eagerly, a popup closed by hand had to stay closed: the call site is
  recorded as dismissed and left alone until the cursor leaves it.

## 0.9.0

- **The popup is replaced when it is not ours.** Being in front is not the same
  as being on screen: typing `(` makes VS Code trigger on the character, so a
  popup opened by whoever was in front at that instant stays up until something
  re-triggers it. Until now the extension only re-triggered when the cursor moved
  to a different call or when priority had to be reclaimed, so a stale built-in
  popup could sit there. The popup now carries the call it was built for, and one
  that is not ours gets replaced — at most once a second, so a language server
  with genuinely nothing to say does not turn into a loop. Pressing `Escape` on
  our own popup still keeps it closed.
- **`signatureHints.upstreamTimeoutMs`** (250ms). Numpy's ufunc stubs take
  seconds to resolve the first time. Past the deadline the answer remembered for
  that call is shown immediately and the fetch is left running, so the next
  keystroke has the fresh one. The highlight still follows the argument you are
  on, since that is counted from the call itself rather than asked for.
- Fixed a latent recursion guard bug: the guard was a flag, but two upstream
  fetches can now overlap at one position, and the first to finish would lift the
  guard from under the other. It counts instead. Only one fetch per call site runs
  at a time.

## 0.8.1

- **`Escape` closes the `alt+h` hover without leaving the notebook cell.**
  `HideHoverAction` has no default keybinding — the hover closes through a DOM
  listener inside the widget, which does not consume the key, so
  `notebook.cell.quitEdit` fired as well. The missing binding is now contributed
  under `editorHoverVisible && notebookEditorFocused`, scoped so `Escape` keeps
  its usual meaning everywhere else.

## 0.8.0

- **Provider order is now measured, not assumed.** 0.7.1 reclaimed priority based
  on how long ago our provider had last been called, which missed the case that
  matters: deleting and retyping `(` in `range()` makes VS Code trigger on the
  character itself, so whoever is in front at that instant answers, and a guess
  based on elapsed time says nothing about who that is.
  `provider.isFirst` runs the provider chain and watches whether we are reached —
  the only way to know, since the registry's order is not exposed and a provider
  that is not first is never called. The probe stops the chain at us, so it costs
  no language server query while we are winning. The check runs each time the
  cursor settles inside a call, at most once a second, and the popup is re-opened
  whenever the lead had to be taken back.

## 0.7.1

- **Fixed: the built-in popup took the lead back for good.** Winning the
  registration race was recorded as a permanent fact, so the backoff stopped
  after the first success and nothing ever reclaimed. But the Python extension
  restarts its language server — after resolving an interpreter, on
  configuration changes, when analysis settles — and every restart re-registers
  Pylance's provider as the newest, putting it back in front. From then on our
  provider was never called again.
  The win is now a timestamp, and priority is reclaimed when the cursor enters a
  call and we have not been reached for 5s. That moment is the one where
  re-registering is free: no popup is open for the registry change to cancel,
  and the trigger that follows is the one that reaches us.
- **`signatureHints.trace`** logs every call and how it ended. Losing the race
  and being reached but returning nothing look identical from the outside — both
  show the built-in popup — and this tells them apart. `Show Diagnostics` also
  reports the outcome tally and how long ago each language was served.

## 0.7.0

- **`signatureHints.reopenInsideCalls`** (on by default). VS Code starts
  parameter hints on `(` and `,` and afterwards only keeps them alive while they
  are already showing, so returning to `np.array(x|)` after leaving the call
  showed nothing, typing included. The cursor is now watched and the popup
  re-triggered on re-entry. Moving between arguments of the same call is left
  alone, so `Escape` stays respected.

## 0.6.0

- **Fixed: the built-in popup won the startup race.** Registering once at +2s was
  too early — Pylance registers when its language server finishes starting, which
  with large typed stubs is 20s or more, and whoever registers last wins.
  Registration now retries on a backoff for the first minute and stops as soon as
  its provider is actually reached, which is the only observable proof of having
  won. It also reclaims on every editor change, which is why switching tabs used
  to fix it by hand.
- `Show Diagnostics` reports which languages have been won.

## 0.5.0

- `alt+h` closes the parameter hints popup before opening the hover; the two
  widgets are anchored to the same place and were overlapping.
- `signatureHints.header` defaults to `"name"`. The header line cannot be
  removed — `.signature` is created unconditionally and costs ~13px whatever it
  holds — so it now carries the function name instead of nothing. The name is
  dropped from the colored signature in that case, so it is never shown twice.

## 0.4.0

- **Fixed: `signatureHints.enabled: false` hid the popup entirely** instead of
  restoring VS Code's built-in parameter hints. It returned an empty result,
  which is truthy and therefore stopped the provider chain before the language
  server was reached. It now returns nothing at all, so the chain falls through.
  `mode: "none"` is the setting that suppresses the popup.
- **The popup no longer blinks out while you type.** VS Code keeps the previous
  hints while a request is pending, but hides them when one resolves to nothing —
  which a language server loaded with typed stubs does now and then. The last
  good answer per call site is remembered for 30s and replayed instead.
- The active parameter can now be derived from the call itself, by counting
  commas at the call's own nesting level, for when a cached answer is used.
- `mode` defaults to `signature`: the popup stays one line and the documentation
  is `alt+h` away.
- `Show Diagnostics` reports upstream latency and the cache size.

## 0.3.0

- **`alt+h` now shows documentation** instead of toggling the extension. On a
  function name it is VS Code's own hover; inside a call's parentheses, where
  there is normally nothing to hover, the extension supplies the callee's
  documentation. Press it twice to focus the hover and scroll it from the
  keyboard. The toggle is still available as a command, just unbound.
- **One scrollable popup, no navigation buttons.** `overloads` defaults back to
  `"all"`: first signature at the top, other overloads below it, then the
  documentation. VS Code caps the widget at `max(editorHeight / 4, 250px)` and
  makes it scrollable, so nothing is lost by stacking.
- `maxDocLines` defaults to `0` — the docstring is no longer cropped.
- `maxOverloads` defaults to `10`.

## 0.2.0

- **Compact signatures.** `signatureHints.signatureStyle` defaults to `compact`:
  parameter names and defaults only, no type annotations and no return type —
  `print(*values, sep=" ", end="\n", file=None, flush=False)`. Typed stubs from
  numpy, pandas, matplotlib and scikit-learn are unreadable at 440px otherwise.
  `full` restores the server's label.
- The signature now starts with the called function's name, so
  `signatureHints.header` defaults to `"none"`.
- `signatureHints.mode` defaults to `"both"` — signature with the docstring
  underneath.
- `signatureHints.overloads` defaults to `"active"`: one signature line, with the
  built-in navigation for the rest.
- **`signatureHints.maxDocLines`** (default `12`) caps the docstring. Shorter
  content is also what keeps the popup from being flipped away from the cursor.
- Docstring line breaks and indentation are preserved; the widget collapses
  whitespace, so they are emitted as `<br>` / `&nbsp;` or markdown hard breaks.
- **Exclusions are keyed by language**: `{"python": ["print"]}`, with `*` for all
  languages. A flat array still works. Ships excluding `print` in Python.

## 0.1.0

Initial release.

- Signature rendered with syntax colors taken from the active color theme,
  including built-in themes, installed themes and `editor.tokenColorCustomizations`.
- Active parameter shown bold on a highlighted background.
- Per-call exclusions via glob patterns (`signatureHints.exclude`).
- Display modes: `signature`, `doc`, `both`, `none`.
- Overloads stacked together, or one at a time with the built-in navigation.
- `alt+h` toggle, persisted to user settings.
- Python and Jupyter notebook cells supported, plus any other language with a
  signature help provider.
