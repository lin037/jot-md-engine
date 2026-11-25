# @jot-md/editor-protocol

**English** · [简体中文](README.zh-CN.md)

Internal workspace package defining TypeScript wire types and protocol constants shared between the Jot main-thread adapter, Web Worker runtime, and Rust/Wasm engine (`crates/editor-protocol`). Current protocol version: **1**.

> **Looking for the editor package?** Install [`@jot-md/editor`](../editor/README.md), which already bundles this protocol internally. This package is private to the monorepo and only needed when developing from source or implementing custom protocol endpoints.

## Example

```ts
import { PROTOCOL_VERSION, type RequestEnvelope } from "@jot-md/editor-protocol";

const request: RequestEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  requestId: 1,
  generation: 1,
  body: { type: "handshake", clientName: "notes", clientVersion: "0.1.0" },
};
```

## Protocol Conventions

- **Coordinates**: All text ranges use half-open `[from, to)` UTF-16 code-unit offsets in the LF-normalized document.
- **Sessions & Revisions**: `generation` distinguishes document lifecycles; `revision` identifies a committed text state in the engine. `DocumentTransaction` carries edits, selection, and history intent.
- **Incremental Analysis & Projections**: `AnalysisState` reports background parsing progress, confirmed ranges, or failures. `RenderPatch` delivers `RenderNode` windows for the requested viewport or child slice.
- **Request ID Partitioning**: Main-thread requests use `0x00000000`–`0x7fffffff`; Worker background requests use `0x80000000`–`0xffffffff`.

For full wire format details, see [Wire Protocol](../../docs/architecture/protocol.md).
