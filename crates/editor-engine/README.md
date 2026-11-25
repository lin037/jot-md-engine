# editor-engine

**English** · [简体中文](README.zh-CN.md)

Core Rust engine powering Jot: stores Markdown source in a Rope buffer, maintains document revisions, performs incremental syntax analysis, and generates viewport-scoped render projections. Can run natively or inside WebAssembly via `editor-wasm`.

## Module Map

| Module | Responsibility |
| --- | --- |
| `src/document/` | Document lifecycle, transaction application, snapshots, projections, and analysis status |
| `src/text/`, `src/position/` | `crop::Rope` buffer, per-line original EOL tracking, and UTF-16 ↔ byte offset conversion |
| `src/transaction/` | Analysis task queue, reprioritization, cancellation, and budget slicing |
| `src/syntax/` | Syntax tree, built-in profiles/extensions, full parse, local rewrites, and incremental invalidation |
| `src/syntax/block/`, `src/syntax/inline/` | Block rules (paragraphs, headings, lists, tables, quotes, fences, math) and inline rules |
| `src/projection/` | Revision-tagged slices for root blocks, table rows/columns, code/quote lines, and headings |
| `src/snapshot/` | Line-ending-preserving snapshots for a given revision |
| `src/bin/md-inspect.rs` | CLI tool to inspect the syntax tree, ranges, and parse timings of any Markdown file |

All text ranges use UTF-16 half-open `[from, to)` offsets. See [Markdown Dialect](../../docs/guides/markdown.md) and [Wire Protocol](../../docs/architecture/protocol.md).

## Testing & CLI

```sh
# Run unit tests plus syntax, incremental, and integration suites
cargo test -p editor-engine

# Inspect how a Markdown file parses
cargo run -p editor-engine --bin md-inspect -- path/to/example.md
```
