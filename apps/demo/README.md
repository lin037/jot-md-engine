# Interactive Demo (`apps/demo`)

**English** · [简体中文](README.zh-CN.md)

Reference web application mounting `MarkdownEditor` in Live Preview and Split modes alongside the built-in outline, toolbar, heading folding, KaTeX math, Mermaid diagrams, shortcut customization, runtime language switching, and telemetry panel.

> **Live hosted demo**: [lin037.github.io/jot-md-engine](https://lin037.github.io/jot-md-engine/)

## Running Locally

After installing workspace prerequisites (see [Building from Source](../../README.md#building-from-source)), run from the repository root:

```sh
pnpm run demo:dev
```

Then open `http://127.0.0.1:4173/`.

## Commands

| Command | Description |
| --- | --- |
| `pnpm run demo:dev` | Build protocol/Wasm bindings and start the Vite dev server on `127.0.0.1:4173` |
| `pnpm run demo:build` | Produce a static bundle in `dist/demo/` (with relative `./` asset paths) |
| `pnpm run test:browser demo` | Run automated Chromium checks against the Demo (modes, Mermaid, 1 MiB mixed doc) |

For embedding `@jot-md/editor` in your own application, see the [Package Guide](../../packages/editor/README.md).
