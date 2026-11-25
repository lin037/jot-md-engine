# editor-protocol

**English** · [简体中文](README.zh-CN.md)

Rust wire types for Jot Protocol **v1**, shared across the native engine, Wasm host, Web Worker, and TypeScript client. Text offsets use UTF-16 code units with half-open `[from, to)` ranges.

## Modules

| Path | Contents |
| --- | --- |
| `src/request.rs`, `src/response.rs` | Message envelopes and commands (handshake, open, transact, project, snapshot, analysis) |
| `src/common.rs`, `src/error.rs` | Protocol version, request ID ranges, document/revision IDs, syntax profiles, error codes |
| `src/transaction.rs` | Text edits, selections, EOL policies, and edit intents |
| `src/analysis.rs` | Analysis budgets, viewport priority ranges, progress, and cancellation |
| `src/projection.rs`, `src/diagnostic.rs` | Window queries, render nodes, patches, and diagnostic payloads |
| `tests/wire_shape.rs` | Serde field-name, enum-tag, and protocol-version contract tests |

When changing any wire field, keep TypeScript definitions in `packages/editor-protocol/` and [Wire Protocol](../../docs/architecture/protocol.md) in sync.

```sh
cargo test -p editor-protocol
```
