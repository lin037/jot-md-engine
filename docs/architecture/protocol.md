# Wire Protocol

**English** · [简体中文](../zh-CN/architecture/protocol.md)

The main thread, Web Worker, and Rust/Wasm engine communicate using Protocol **v1**, defined symmetrically in Rust (`crates/editor-protocol`) and TypeScript (`packages/editor-protocol`). When using `MarkdownEditor`, this protocol is handled automatically; the details below apply if you build a custom session or host endpoint.

**Sources**: [crates/editor-protocol/src/lib.rs](../../crates/editor-protocol/src/lib.rs) · [packages/editor-protocol/src/index.ts](../../packages/editor-protocol/src/index.ts)

## Request & Response Envelopes

Every request carries `protocolVersion`, `requestId`, `generation`, and a typed `body`:

```json
{
  "protocolVersion": 1,
  "requestId": 1,
  "generation": 1,
  "body": {
    "type": "handshake",
    "clientName": "example",
    "clientVersion": "0.1.0"
  }
}
```

- **Request ID partitioning**: Main-thread requests use `0x00000000`–`0x7fffffff`; Worker background requests use `0x80000000`–`0xffffffff`.
- **Session & version identifiers**: `documentId` identifies a logical document, `generation` distinguishes separate open lifecycles, and `revision` tracks committed edits within a lifecycle.

| Request `body.type` | Response `body.type` | Purpose |
| --- | --- | --- |
| `handshake` | `handshake-ack` | Negotiate protocol capabilities and engine version |
| `open-document` | `document-opened` | Submit initial text and `syntaxProfile`, receiving initial `revision` and `analysis` |
| `apply-transaction` | `transaction-committed` | Apply an atomic batch of edits at `baseRevision`, returning a `DocumentPatch` and optional projection |
| `project` | `projection-ready` | Fetch `RenderNode` slices for a range or child index window |
| `get-snapshot` | `snapshot-ready` | Retrieve normalized text and per-line `lineEndings` for a `revision` |
| `schedule-analysis`, `reprioritize-analysis`, `process-analysis-queue`, `cancel-analysis`, `get-analysis-status` | `analysis-state-changed` | Control and inspect budgeted background syntax analysis |
| `close-document` | `document-closed` | Release document state in the engine |

Failed requests return a `failure` body with a structured `error.code`, `error.recoverable`, and (on revision conflicts) expected vs. actual revisions.

## Coordinates & Transactions

- **UTF-16 half-open ranges**: Every range `[from, to)` counts UTF-16 code units in the LF-normalized document (for example, in `A😀B` with length 4, replacing the emoji uses `[1, 3)`). Endpoints must never split a UTF-16 surrogate pair.
- **Line endings**: `open-document` accepts LF, CRLF, and CR and records per-line endings separately; `edits` inside `apply-transaction` must contain LF-only `insert` strings.
- **Atomic transactions**: All `edits` in a transaction share one `baseRevision`, are sorted by start offset, and must be non-overlapping. The engine either commits the entire transaction and advances `revision`, or rejects it without mutating document state.

## Asynchronous Analysis & Viewport Windows

Text confirmation is independent of syntax analysis. The Worker returns `transaction-committed` immediately and advances parsing asynchronously across budget slices:

- `AnalysisState` reports `"pending"` (with `confirmedRanges`), `"complete"`, `"cancelled"`, or `"failed"`.
- Viewport hints reprioritize pending ranges around what the user is currently viewing.
- Projections represent only the requested slice; source-backed render nodes carry `sourceRange` so the host slices text directly from its local copy. Both `generation` and `revision` must match before applying a projection patch.
