# Changelog

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
