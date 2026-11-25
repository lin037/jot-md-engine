# editor-wasm

**English** · [简体中文](README.zh-CN.md)

WebAssembly bindings and multi-document request routing for `editor-engine`. `EditorHost` validates protocol versions, isolates open document lifecycles by `documentId` and `generation`, and routes envelopes to `EditorDocument`.

On `wasm32` targets, `wasm-bindgen` exports `WasmEditorHost` with a synchronous `handle(requestEnvelope)` method invoked inside the Web Worker:

```ts
const host = new WasmEditorHost();
const response = host.handle(requestEnvelope);
```

## Testing & Building

```sh
# Run native host integration tests (handshake, transactions, UTF-16 ranges, projections)
cargo test -p editor-wasm

# Rebuild Wasm bindings for the demo app (from repository root)
pnpm run wasm:demo
```

See [Wire Protocol](../../docs/architecture/protocol.md) for message structure and revision guarantees.
