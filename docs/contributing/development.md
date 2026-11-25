# Development & Testing

**English** · [简体中文](../zh-CN/contributing/development.md)

This guide covers the monorepo layout, test suites, and debugging tools for contributors working on Jot from source. See the [README](../../README.md#building-from-source) for initial toolchain prerequisites.

## Repository Layout

```text
.
├── crates/
│   ├── editor-engine/       Core Rust Rope buffer, incremental Markdown parser, and projections
│   ├── editor-protocol/     Rust wire types and serialization tests
│   └── editor-wasm/         wasm-bindgen host routing protocol requests to EditorDocument
├── packages/
│   ├── editor-protocol/     TypeScript wire types mirroring crates/editor-protocol
│   └── editor/              Browser editor package (adapter, hosts, components, worker)
├── apps/demo/               Interactive reference application
├── benchmarks/              Production browser benchmark harness
├── scripts/
│   ├── build/               Wasm build, asset generation, and dist cleanup scripts
│   ├── checks/              Architecture boundary check and TypeScript test runner
│   ├── release/             Release tarball packing and clean-install verification
│   └── browser/             Chromium suites (demo, interaction, layout, quote, diagnostics)
└── docs/                    Documentation (English default + docs/zh-CN/)
```

Generated artifacts live in `target/`, `dist/`, `.tmp/`, and `apps/*/src/generated` / `benchmarks/src/generated`.

## Running Checks & Tests

Run all commands from the repository root:

| Command | Scope |
| --- | --- |
| `cargo fmt --all -- --check` | Rust formatting check |
| `cargo clippy --workspace --all-targets -- -D warnings` | Rust lints (also test `--target wasm32-unknown-unknown`) |
| `cargo test --workspace` | Rust unit tests plus syntax, incremental, protocol, and Wasm host suites |
| `pnpm run build:protocol && pnpm run typecheck` | Build protocol types and typecheck all TypeScript packages |
| `pnpm run test:ts` | Enforce module dependency boundaries and run Node-based TypeScript tests |
| `pnpm run test:browser` | Run Chromium end-to-end suites (`demo`, `interaction`, `layout`, `quote`) |
| `pnpm run package:verify` | Build the package and check its exports and Worker in a clean project |
| `pnpm run benchmark` | Run production browser performance benchmarks |

## Targeted Tests & Diagnostics

### Rust Syntax & Incremental Tests

Run integration suites individually:

```sh
cargo test -p editor-engine --test syntax
cargo test -p editor-engine --test incremental
cargo test -p editor-engine --test integration
```

To inspect how Jot parses any Markdown file (including node tree, UTF-16 ranges, and parse timing), run the built-in `md-inspect` CLI:

```sh
cargo run -p editor-engine --bin md-inspect -- path/to/example.md
```

### Browser Suites

Run a single browser suite by name when iterating on specific areas:

```sh
pnpm run test:browser demo         # Demo modes, Mermaid viewport, and 1 MiB mixed doc
pnpm run test:browser interaction  # Keybindings, search, IME, lists, tables, plugins, folding
pnpm run test:browser layout       # Scrollbar, line-height parity, table geometry, stability
pnpm run test:browser quote        # Nested block quotes, selection, and navigation
```

Set `CHROME_BIN` if Chromium/Chrome is installed in a non-standard location. Do not rebuild protocol or Wasm assets while a browser suite is actively running, as the dev server watches generated outputs.

For stress-testing large documents, fuzzing search/pointer interactions, or auditing capacity, see the scripts in `scripts/browser/diagnostics/` (ensure `pnpm run build:protocol && pnpm run wasm:demo` have been run first).
