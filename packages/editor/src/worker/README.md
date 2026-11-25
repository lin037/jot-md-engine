# Worker Runtime (`packages/editor/src/worker`)

**English** · [简体中文](README.zh-CN.md)

The Web Worker entry hosts the Rust/Wasm engine off the main thread:

- `bootstrap.ts`: Buffers incoming messages while the Wasm binary loads, initializes `WasmEditorHost`, hands queued requests to `runtime.ts`, and connects subsequent message handling. See the [Package Guide](../../README.md#2-create-the-web-worker-entry) for setup examples.
- `analysis-pump.ts`: Schedules at most one `process-analysis-queue` step per tick while background analysis remains `pending`, stopping automatically if the document closes, the session changes, or the target shifts.
- **Request ID partitioning & fatal errors**: Main-thread requests occupy `0x00000000`–`0x7fffffff` while Worker-initiated updates use `0x80000000`–`0xffffffff`. Unrecoverable failures emit `editor-worker-fatal` so the main-thread session can reject pending requests cleanly.
