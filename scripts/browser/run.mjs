import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const suites = {
  demo: [
    ["demo/browser-smoke.mjs"],
    ["demo/demo-paper-browser.mjs"],
    ["demo/editor-mermaid-viewport-browser.mjs"],
    ["demo/editor-mermaid-viewport-browser.mjs", "--preview"],
    ["demo/demo-large-mixed-browser.mjs"],
  ],
  interaction: [
    ["interaction/editor-interaction-browser.mjs"],
    ["interaction/editor-plugin-browser.mjs"],
    ["interaction/editor-heading-fold-browser.mjs"],
  ],
  layout: [
    ["layout/editor-structural-stability-browser.mjs"],
    ["layout/editor-scrollbar-browser.mjs"],
    ["layout/editor-metric-guard-browser.mjs"],
    ["layout/editor-boundary-audit-browser.mjs"],
  ],
  quote: [
    ["layout/quote/editor-blockquote-browser.mjs"],
    ["layout/quote/editor-quote-contract-browser.mjs"],
    ["layout/quote/editor-quote-navigation-browser.mjs"],
    ["layout/quote/editor-quote-adaptive-browser.mjs"],
  ],
};

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !Object.hasOwn(suites, args[0]))) {
  console.error("Usage: pnpm run test:browser [demo|interaction|layout|quote]");
  process.exit(1);
}

const selected = args.length === 0 ? Object.keys(suites) : args;
if (selected.includes("demo")) {
  run("pnpm", ["run", "demo:build"]);
} else {
  run("pnpm", ["run", "build:protocol"]);
  run("pnpm", ["run", "wasm:demo"]);
}

for (const suite of selected) {
  for (const [file, ...options] of suites[suite]) {
    run(process.execPath, [resolve("scripts/browser", file), ...options]);
  }
}

function run(command, args) {
  // 顺序运行。多个用例复用本地端口，也会写入固定的报告路径。
  const result = spawnSync(command, args, {
    stdio: "inherit",
    // Windows 上 pnpm 的命令入口通常由 cmd 提供。
    shell: command === "pnpm" && process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
