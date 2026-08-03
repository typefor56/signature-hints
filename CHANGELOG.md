# Changelog

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
