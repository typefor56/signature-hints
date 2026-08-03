# Signature Hints

Parameter hints that behave. Theme-matched syntax highlighting on the signature,
per-function exclusions, a choice of signature / doc / both, and a one-key toggle.

Built for Python and Jupyter notebooks first; it works for any language that has
a signature help provider.

## What it does

| | Built-in parameter hints | Signature Hints |
|---|---|---|
| Syntax coloring | none, one flat color | full, from your active color theme |
| Signature shown | whatever the stub says, annotations and all | names and defaults only |
| Silence a function | impossible | `signatureHints.exclude` |
| Signature vs docs | always both | `signature` / `doc` / `both` / `none` |
| Turn it off | dig through settings | `alt+h` |
| Overloads | one at a time, 1/2 navigation | all stacked, or one at a time |

### Compact signatures

Typed stubs are written for type checkers, not for reading. Pylance reports:

```
(*values: object, sep: str | None = " ", end: str | None = "\n",
 file: SupportsWrite[str] | None = None, flush: Literal[False] = False) -> None
```

which wraps to five lines in a 440px popup. `signatureHints.signatureStyle`
defaults to `compact`, which keeps the part you were actually looking for:

```
print(*values, sep=" ", end="\n", file=None, flush=False)
```

This matters most for the scientific stack — numpy, pandas, matplotlib,
scikit-learn — whose annotations (`_ArrayLike`, `_OrderKACF`,
`_SupportsArrayFunc | None`) are longer than the parameter names they describe.
Set it to `full` to get the server's label verbatim.

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
| `signatureHints.mode` | `"both"` | `signature`, `doc`, `both`, `none`. |
| `signatureHints.signatureStyle` | `"compact"` | `compact` keeps names and defaults; `full` keeps annotations too. |
| `signatureHints.exclude` | `{"python": ["print"]}` | Calls that never show a popup. |
| `signatureHints.maxDocLines` | `12` | Lines of docstring before truncating; `0` for all of it. |
| `signatureHints.overloads` | `"active"` | `active` shows one with 1/2 navigation; `all` stacks them. |
| `signatureHints.maxOverloads` | `5` | Cap when stacking. |
| `signatureHints.header` | `"none"` | Content of the plain header line: `none`, `name`, `name+count`. |
| `signatureHints.colors` | `"theme"` | `off` disables coloring. |
| `signatureHints.monospace` | `true` | Render the signature in the editor font. |
| `signatureHints.languages` | `["*"]` | Language ids to take over. |

Everything except `languages` is language-overridable, so you can scope it:

```jsonc
"signatureHints.mode": "signature",
"[python]": {
  "signatureHints.mode": "both",
  "signatureHints.maxDocLines": 20
}
```

### Exclusions

`print` is a Python builtin and `console.log` is not, so exclusions are keyed by
language id. `*` applies to every language.

```jsonc
"signatureHints.exclude": {
  "python": [
    "print",         // also matches builtins.print
    "logging.*",     // logging.info, logging.debug
    "np.random.*",
    "torch.**"       // any depth
  ],
  "javascript": ["console.*"],
  "*": ["assert"]
}
```

Patterns are globs, tested against both the bare name and the qualified name.
`*` does not cross dots; `**` does. A flat array still works and applies to
every language.

`Signature Hints: Exclude Call at Cursor` adds whatever you are inside to the
list, under the current file's language.

## Commands

| Command | Key |
|---|---|
| Signature Hints: Toggle | `alt+h` |
| Signature Hints: Cycle Mode | — |
| Signature Hints: Exclude Call at Cursor | — |
| Signature Hints: Reclaim Provider Priority | — |
| Signature Hints: Show Diagnostics | — |

## Size and placement

The popup's width is fixed by VS Code's own stylesheet:

```css
.parameter-hints-widget > .phwrapper { max-width: 440px }
```

That is a hard cap. No VS Code setting exposes it and extensions cannot inject
workbench CSS, so **width is not adjustable** — only the amount of content is.
That is the lever this extension gives you, and it is the one that matters:
shortening the content is also what keeps the popup next to your cursor, because
VS Code flips a tall widget above the line and pins it to the viewport edge.

If the popup is taller than you want, or drifts away from the cursor when you
scroll:

| Setting | Effect |
|---|---|
| `signatureHints.signatureStyle: "compact"` | Usually turns five wrapped lines into one. |
| `signatureHints.maxDocLines` | Lower it — `4` keeps only the summary. |
| `signatureHints.mode: "signature"` | Drop the docstring entirely. |
| `signatureHints.overloads: "active"` | One signature instead of a stack. |

If you truly need a wider popup, the only route is a workbench CSS injector such
as *Custom CSS and JS Loader*, overriding `.phwrapper`'s `max-width`. That
patches VS Code's own files and breaks on update; it is outside what an
extension can do.

## Cosmetic notes

VS Code always reserves a plain, uncolored header line above the documentation
area, and extensions cannot style or remove it. `signatureHints.header` defaults
to `"none"`, which leaves it empty — about 12px with a separator rule — because
the colored signature already starts with the function name. `"name"` fills it
instead.

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
