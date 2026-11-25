# Browser Benchmarks

**English** · [简体中文](README.zh-CN.md)

Production browser benchmark suite measuring real `MarkdownEditor` Live Preview, CodeMirror 6, and Rust/Wasm Web Worker performance in headless Chromium. Each sample creates a fresh editor and Worker instance with offline synthetic payloads.

## Running Benchmarks

From the repository root:

```sh
# Full default suite (~1 MiB mixed Markdown, 1 warmup + 5 measured samples)
pnpm run benchmark

# Custom payload size, scenario, and output path (skipping rebuild)
pnpm run benchmark --no-build --scenario cursor-insert --bytes 4194304 --samples 3 --output dist/benchmark-reports/cursor-4m.json

# Quick smoke run
pnpm run benchmark --no-build --bytes 65536 --samples 1 --output dist/benchmark-reports/smoke.json
```

Set `CHROME_BIN` to point to a specific Chrome/Chromium executable. Reports are written to `dist/benchmark-reports/browser.json` by default and include raw samples, median/max timings, browser metadata, and the Wasm binary hash.

## Scenarios

| Scenario | What It Measures |
| --- | --- |
| **Open** | Creates the editor with the initial ~1 MiB document and measures from editor creation. |
| **Single character insert** | Types one character into an already-open, fully parsed ~1 MiB document. |
| **Scroll** | Dispatches real mouse wheel events on an open document and verifies viewport scroll and newly mounted content. |
| **Bulk insert** | Sends a single trusted `Input.insertText` payload into an empty editor. |
| **Paste** | Dispatches a synthetic `ClipboardEvent` containing the full payload through CodeMirror's paste pipeline (excluding OS clipboard overhead). |
| **Prepend (cursor insert)** | Prepends a second ~1 MiB payload at the start of an already-parsed ~1 MiB document and simulates an immediate `input.settled()` + `confirmedValue` save round-trip. |
| **Drag & drop** | Dispatches a browser drag-and-drop sequence via CDP with the full payload. |

## Metrics & Validation

- `visibleMs` (**Time to Visible Frame**): Elapsed time until target content renders across two consecutive animation frames (measured from the first observed frame).
- `confirmedMs` (**Time to Confirmed Text**): Elapsed time until the Rust/Wasm Worker commits the revision and `editor.confirmedValue` is ready to persist.
- `parsedMs` (**Full-Document Parse Complete**): Elapsed time until background incremental syntax analysis completes for the entire document.
- `afterConfirmMs`: Delta between `confirmedMs` and `parsedMs` (`0` when both resolve together).

Every sample checks the visible viewport and compares the editor text and `confirmedValue` with the expected result. The prepend scenario also checks a Rust snapshot and reads back the saved file. See [Benchmark Results](../README.md#browser-benchmarks).
