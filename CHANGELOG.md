# Changelog

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
