import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from "../scripts/browser/support/browser-test-utils.mjs";
import { largeInputFixture } from "../scripts/browser/support/large-input-fixture.mjs";

const { values } = parseArgs({
  options: {
    bytes: { type: "string", default: "1048576" },
    samples: { type: "string", default: "5" },
    scenario: { type: "string" },
    output: { type: "string", default: "dist/benchmark-reports/browser.json" },
    "no-build": { type: "boolean" },
  },
});
const scenarios = ["open", "typing", "replace", "scroll", "paste-paragraph", "find-next", "undo", "redo", "insert", "paste", "drop", "cursor-insert"];
const stressScenarios = ["replace-all-fences", "replace-all-text", "replace-all-dense"];
const supported = [...scenarios, ...stressScenarios];
if (values.scenario !== undefined) assert(supported.includes(values.scenario), `--scenario must be one of ${supported.join(", ")}`);
const samples = Number(values.samples);
const bytes = Number(values.bytes);
assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be a positive integer");
assert(Number.isSafeInteger(bytes) && bytes >= 16384, "--bytes must be at least 16384");
const output = resolve(values.output);
const { source, sections } = values.scenario === "replace-all-dense"
  ? { source: "a".repeat(bytes), sections: 0 } : largeInputFixture(bytes);
if (!values["no-build"]) {
  const build = spawnSync("pnpm", ["run", "benchmark:build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const port = Number(process.env.JOT_BENCH_PORT ?? 4174);
const debugPort = Number(process.env.JOT_BENCH_DEBUG_PORT ?? 9334);
const viewport = { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false };
const origin = `http://127.0.0.1:${port}/`;
const debuggerUrl = `http://127.0.0.1:${debugPort}`;
const assets = resolve("dist/benchmark/assets");
const wasm = readdirSync(assets).filter(file => file.endsWith(".wasm"));
assert.equal(wasm.length, 1, "expected one Wasm asset in the benchmark build");
const profile = mkdtempSync(resolve(tmpdir(), "jot-browser-benchmark-"));
const report = {
  suite: "jot-browser-v1",
  generatedAt: new Date().toISOString(),
  environment: {
    platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
    memoryBytes: totalmem(), node: process.version, viewport,
    vite: JSON.parse(readFileSync("node_modules/vite/package.json", "utf8")).version,
    wasmSha256: sha256(readFileSync(resolve(assets, wasm[0]))),
  },
  input: { requestedBytes: bytes, bytes: Buffer.byteLength(source), utf16: source.length, sections, sha256: sha256(source) },
  samples,
  warmupsPerScenario: 1,
  scenarios: [],
};
let server, chrome, client;
try {
  server = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "preview", "--config",
    "benchmarks/vite.config.mjs", "--port", String(port), "--strictPort"], { stdio: "inherit" });
  await waitForHttp(origin, 15_000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), [
    "--headless=new", "--no-first-run", "--disable-background-networking",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, origin,
  ], { stdio: "ignore" });
  await waitForHttp(debuggerUrl + "/json/version", 15_000);
  const { Browser: browser } = await fetch(debuggerUrl + "/json/version").then(response => response.json());
  report.environment.browser = browser;
  const pages = await fetch(debuggerUrl + "/json/list").then(response => response.json());
  client = await connectCdp(pages.find(page => page.type === "page" && page.url === origin).webSocketDebuggerUrl);
  await client.command("Emulation.setDeviceMetricsOverride", viewport);
  await waitForEvaluation(client, "typeof window.benchmark === 'object'", 15_000);
  // 一次性装载样本，浏览器与 Node 之间传送样本文本不计入页面指标。
  await client.evaluate(`window.fixture=${JSON.stringify(source)};true`);

  for (const name of values.scenario ? [values.scenario] : scenarios) {
    const scenario = { name, measurements: [] };
    report.scenarios.push(scenario);
    for (let i = 0; i <= samples; i++) {
      await client.evaluate(`benchmark.prepare(${JSON.stringify(name)}, fixture)`);
      const start = performance.now();
      if (name === "insert" || name === "typing" || name === "replace") {
        await client.command("Input.insertText", { text: name === "insert" ? source : "字" });
      } else if (name === "scroll") {
        await client.command("Input.dispatchMouseEvent", { type: "mouseWheel", x: 440, y: 300, deltaX: 0, deltaY: 4800 });
      } else if (["find-next", "undo", "redo"].includes(name)) {
        await client.evaluate("benchmark.runCommand();true");
      } else if (name === "paste" || name === "paste-paragraph") {
        await client.evaluate("benchmark.paste();true");
      } else if (stressScenarios.includes(name)) {
        await client.evaluate("benchmark.replaceAll();true");
      } else if (name === "cursor-insert") {
        await client.evaluate("benchmark.insertAtCursor();true");
      } else if (name === "drop") {
        const data = { items: [{ mimeType: "text/plain", data: source }], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await client.command("Input.dispatchDragEvent", { type, x: 20, y: 21, data });
        }
      }
      const commandMs = name === "open" ? undefined : performance.now() - start;
      const timing = await client.evaluate("benchmark.finish()");
      for (const ms of [timing.visibleMs, timing.confirmedMs, timing.parsedMs, timing.afterConfirmMs, commandMs].filter(value => value !== undefined)) {
        assert(Number.isFinite(ms) && ms >= 0, `${name} returned an invalid duration`);
      }
      assert(Number.isFinite(timing.visibleMs), `${name} did not report a visible frame`);
      assert(timing.mountedLines > 0 && timing.mountedLines < 500, `${name} mounted ${timing.mountedLines} lines`);
      if (i > 0) scenario.measurements.push({ ...timing, commandMs });
      await client.evaluate("benchmark.dispose()");
    }
    scenario.summary = Object.fromEntries(Object.keys(scenario.measurements[0])
      .filter(key => scenario.measurements[0][key] !== undefined)
      .map(key => [key, summarize(scenario.measurements.map(sample => sample[key]))]));
    console.log(JSON.stringify({ scenario: name, ...scenario.summary }));
  }
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log(`Benchmark report: ${output}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    max: sorted.at(-1),
  };
}
