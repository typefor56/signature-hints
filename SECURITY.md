# Security notes

Audited at v0.15.0 against VS Code 1.131.0. This file records what the extension
is able to do, what it deliberately cannot, and the two things that were fixed
because of the audit.

## What it touches

| | |
|---|---|
| Network | none — no `http`, `fetch`, `WebSocket`, no telemetry |
| Processes | none — no `child_process`, `exec`, `spawn` |
| Dynamic code | none — no `eval`, no `new Function` |
| Filesystem writes | none |
| Filesystem reads | colour theme JSON only, under `extension.extensionPath` of installed theme extensions |
| Settings written | `signatureHints.*` and, once and only if the user accepts the prompt, `editor.parameterHints.enabled` |
| Runtime dependencies | `jsonc-parser` (VS Code's own JSONC parser), 0 advisories |

Declared in `capabilities`: usable in untrusted and virtual workspaces, since
none of the above depends on trusting the workspace.

## The interesting surface

The extension writes HTML into `SignatureInformation.documentation`, which VS
Code renders as markdown. That is the whole trick, and it is where the risk is.

**`isTrusted` stays `false`.** VS Code only adds `command:` to the allowed link
protocols for trusted markdown:

```js
allowedLinkProtocols: { override: e.type === 0 ? [...a, Y.command] : a }
```

So no rendered content can invoke a VS Code command. This is load-bearing —
never set `isTrusted` on these strings.

**`supportHtml` is `true`, and it applies to the whole string.** It has to be, or
the coloured signature would be escaped into visible tag soup. But the same
string also carries the documentation, which comes from whatever package happens
to be installed. VS Code's sanitizer permits `img`, `video` and `source`, and:

```js
allowedMediaProtocols: { override: [http, https, data, file, …] }
```

A docstring containing `<img src="https://…">` would therefore have made the
editor fetch a URL as you typed a call to that function — no code execution, but
an unsolicited outbound request, and reachable from a `.pyi` stub alone without
anything ever being imported. **Fixed in 0.15.0**: `formatDocumentation` escapes
`<` in documentation, so the extension's own markup is the only live HTML in the
popup. Plain-text docstrings were already fully escaped.

Markdown image syntax (`![](https://…)`) is *not* neutralised, and is not
specific to this extension — the built-in popup renders docstring markdown the
same way. Note that `signatureHints.mode` defaults to `signature`, so
documentation is not rendered in the popup at all unless you ask for it.

**`alt+h` forwards the language server's own hover objects unchanged**, keeping
whatever `isTrusted` the server set. That is the same content you get by hovering
with the mouse, so it adds no surface.

## Denial of service

`resolveCall` runs on cursor movement and scans up to 30 lines. Thirty lines is
not a bound on characters — a minified file can hold megabytes on one line.
**Fixed in 0.15.0**: the window is capped at 20 000 characters, keeping the tail.

Other bounds worth keeping: the signature cache is capped at 50 entries with a
30s TTL, one upstream request runs per call site, and the re-entrancy guard is a
counter so overlapping fetches cannot lift it from under each other — that last
one prevents unbounded recursion through `executeSignatureHelpProvider`.

Glob patterns in `signatureHints.exclude` are compiled to regular expressions.
They come from the user's own settings and expand to `[^.]*` / `.*`, which cannot
nest into a catastrophic backtracking pattern.

## Before publishing

Nothing outstanding in the manifest. `repository`, `bugs`, `homepage` and `icon`
are set, so `vsce` rewrites the README's relative image links to
`raw.githubusercontent.com` on its own — those resolve only once the repository
has actually been pushed.
