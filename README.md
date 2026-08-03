# Signature Hints

Parameter hints that behave. Theme-matched syntax highlighting on the signature,
per-function exclusions, a choice of signature / doc / both, and a one-key toggle.

Built for Python and Jupyter notebooks first; it works for any language that has
a signature help provider.

## What it does

| | Built-in parameter hints | Signature Hints |
|---|---|---|
| Syntax coloring | none, one flat color | full, from your active color theme |
| Silence a function | impossible | `signatureHints.exclude: ["print"]` |
| Signature vs docs | always both | `signature` / `doc` / `both` / `none` |
| Turn it off | dig through settings | `alt+h` |
| Overloads | one at a time, 1/2 navigation | all stacked, or one at a time |

The colors are read from the color theme you actually have active — including
themes that ship inside VS Code, themes you installed, and any
`editor.tokenColorCustomizations` you layered on top. Switch theme and the popup
follows, no reload.

## Requirements

The popup is VS Code's own parameter hints widget, so
`editor.parameterHints.enabled` must be `true`. If it is off, the extension
offers to turn it on the first time it starts.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `signatureHints.enabled` | `true` | Master switch, bound to `alt+h`. |
| `signatureHints.mode` | `"signature"` | `signature`, `doc`, `both`, `none`. |
| `signatureHints.exclude` | `[]` | Calls that never show a popup. |
| `signatureHints.overloads` | `"all"` | `all` stacks every overload; `active` shows one with 1/2 navigation. |
| `signatureHints.maxOverloads` | `5` | Cap when stacking. |
| `signatureHints.header` | `"name"` | Content of the plain header line: `none`, `name`, `name+count`. |
| `signatureHints.colors` | `"theme"` | `off` disables coloring. |
| `signatureHints.monospace` | `true` | Render the signature in the editor font. |
| `signatureHints.languages` | `["*"]` | Language ids to take over. |

Everything except `languages` is language-overridable, so you can scope it:

```jsonc
"signatureHints.mode": "signature",
"[python]": {
  "signatureHints.mode": "both",
  "signatureHints.exclude": ["print", "len", "logging.*"]
}
```

### Exclusions

Patterns are globs, tested against both the bare name and the qualified name.
`*` does not cross dots; `**` does.

```jsonc
"signatureHints.exclude": [
  "print",           // also matches builtins.print
  "logging.*",       // logging.info, logging.debug
  "np.random.*",
  "torch.**"         // any depth
]
```

`Signature Hints: Exclude Call at Cursor` adds whatever you are inside to the list.

## Commands

| Command | Key |
|---|---|
| Signature Hints: Toggle | `alt+h` |
| Signature Hints: Cycle Mode | — |
| Signature Hints: Exclude Call at Cursor | — |
| Signature Hints: Reclaim Provider Priority | — |
| Signature Hints: Show Diagnostics | — |

## Cosmetic notes

VS Code always reserves a plain, uncolored header line above the documentation
area, and extensions cannot style or remove it. `signatureHints.header: "none"`
leaves it empty — about 12px with a separator rule — while `"name"` fills it with
the called function's name.

With `monospace` on, VS Code draws a background pill behind the signature. To
remove it:

```jsonc
"workbench.colorCustomizations": { "textCodeBlock.background": "#00000000" }
```

## How it works

The extension registers its own signature help provider, asks the real language
server (Pylance, tsserver, rust-analyzer…) for the signature, and re-renders it
as colored HTML into the widget's `documentation` field — the one part of the
built-in popup that goes through VS Code's markdown renderer.

Two consequences worth knowing:

- **Provider order.** VS Code orders equally-scored providers newest-first, so the
  extension re-registers itself after startup, when extensions change, and when
  you first open a new language. If a language server restarts and takes the lead
  back, run `Signature Hints: Reclaim Provider Priority`.
- **HTML in the popup is not a contractual API.** It is the behavior of VS Code's
  shared markdown sanitizer, which allows `color`, `background-color` and
  `border-radius` on `<span>`. Verified against VS Code 1.131. If a future release
  tightens it, set `signatureHints.colors: "off"` until the extension is updated.

## Development

```sh
npm install
npm run compile   # or: npm run watch
```

Press `F5` for an Extension Development Host. `npm run package` builds the `.vsix`.
