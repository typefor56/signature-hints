# Changelog

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
