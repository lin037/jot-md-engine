import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const standalone = process.argv.includes("--standalone");
const packageDirectory = resolve(root, standalone ? "dist/release" : "dist/packages");
run("node", ["scripts/release/pack-editor.mjs", ...(standalone ? ["--standalone"] : [])], root);
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "manifest.json"), "utf8"));
const protocol = manifest.packages.find((item) => item.name === "@jot-md/editor-protocol");
const editor = manifest.packages.find((item) => item.name === "@jot-md/editor");
if (editor === undefined || (standalone ? manifest.packages.length !== 1 : protocol === undefined)) {
  throw new Error("packed package manifest incomplete");
}
const packages = standalone ? [editor] : [protocol, editor];

const consumer = mkdtempSync(resolve(tmpdir(), "jot-editor-consumer-"));
try {
  writeFileSync(resolve(consumer, "package.json"), JSON.stringify({
    name: "jot-editor-artifact-consumer",
    private: true,
    type: "module",
  }, null, 2));
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    resolve(root, ".tmp/npm-cache"),
    ...packages.map(pkg => resolve(packageDirectory, pkg.filename)),
  ], consumer);
  if (standalone && existsSync(resolve(consumer, "node_modules/@jot-md/editor-protocol"))) {
    throw new Error("Standalone installation unexpectedly needs an external protocol package");
  }
  const entries = packages.flatMap(({ name }) => {
    const directory = resolve(consumer, "node_modules", name);
    const installed = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    if (installed.license !== "MIT" || readFileSync(resolve(directory, "LICENSE"), "utf8") !== readFileSync(resolve(root, "LICENSE"), "utf8")) {
      throw new Error(`${name} is missing the project license`);
    }
    return Object.keys(installed.exports).map((subpath) => name + subpath.slice(1));
  });
  writeFileSync(resolve(consumer, "consumer.ts"), `
${entries.filter(entry => !entry.endsWith(".css")).map((entry, i) =>
  `import type * as PublicEntry${i} from ${JSON.stringify(entry)};`).join("\n")}
import { MarkdownEditor, mountShortcutSettings, type EditorLayoutStyle, type EditorTheme, type MarkdownEditorOptions } from "@jot-md/editor";
import { EditorDocumentSession, type AdapterEffect } from "@jot-md/editor/adapter";
import { EditorCommandRegistry } from "@jot-md/editor/commands";
import { TABLE_COMMAND } from "@jot-md/editor/table";
import { createKaTeXRenderer, type KaTeXRendererOptions } from "@jot-md/editor/math";
import { createLazyKaTeXRenderer } from "@jot-md/editor/math/lazy";
import { createMermaidPlugin, type MermaidPluginOptions } from "@jot-md/editor/mermaid";
import { createHeadingFoldPlugin } from "@jot-md/editor/heading-fold";
import { CodeMirrorSource } from "@jot-md/editor/source";
import { EditorEventObserver } from "@jot-md/editor/observability";
import { EditorSurface } from "@jot-md/editor/preview";
import { bootstrapEditorWorker } from "@jot-md/editor/worker";

const editorConstructor: typeof MarkdownEditor = MarkdownEditor;
const workerBootstrap: typeof bootstrapEditorWorker = bootstrapEditorWorker;
const connectWorker = (endpoint: DedicatedWorkerGlobalScope) =>
  bootstrapEditorWorker({ endpoint, loadWasm: () => import("@jot-md/editor/wasm") });
const documentId = "consumer" as MarkdownEditorOptions["session"]["documentId"];
const options = null as unknown as MarkdownEditorOptions;
const layout: EditorLayoutStyle = { fontSize: 18, metrics: { paragraphLineHeight: 30, listMinContentWidth: 120 } };
const theme: EditorTheme = { colors: { text: "#222", selection: null }, layout };
const setTheme = (editor: MarkdownEditor): Promise<void> => editor.setTheme(theme);
const ownsProjection = (session: EditorDocumentSession, effect: AdapterEffect, owner: symbol): boolean => session.ownsProjection(effect, owner);
const initialTheme: EditorTheme | undefined = options.theme;
void layout;
void setTheme;
void ownsProjection;
void initialTheme;
void mountShortcutSettings;
void editorConstructor;
void workerBootstrap;
void connectWorker;
void documentId;
void options;
void EditorDocumentSession;
void EditorCommandRegistry;
void TABLE_COMMAND;
const mathOptions: KaTeXRendererOptions = { throwOnError: false };
void createKaTeXRenderer(mathOptions);
void createLazyKaTeXRenderer(mathOptions);
const mermaidOptions = null as unknown as MermaidPluginOptions;
void createMermaidPlugin;
void createHeadingFoldPlugin({ enabled: false });
void mermaidOptions;
void CodeMirrorSource;
void EditorEventObserver;
void EditorSurface;
`, "utf8");
  writeFileSync(resolve(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["consumer.ts"],
  }, null, 2));
  run(resolve(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer);
  writeFileSync(resolve(consumer, "resolve.mjs"), `
import { existsSync, readFileSync } from "node:fs";

const entries = ${JSON.stringify(entries)};
for (const entry of entries) {
  const resolved = import.meta.resolve(entry);
  if (resolved.includes("/src/")) throw new Error(entry + " resolved to source: " + resolved);
  if (!existsSync(new URL(resolved))) throw new Error(entry + " resolved to a missing artifact");
  console.log(entry + " -> " + resolved);
}
for (const entry of entries.filter((candidate) => !candidate.endsWith(".css"))) {
  await import(entry);
}
const coreCss = readFileSync(new URL(import.meta.resolve("@jot-md/editor/core.css")), "utf8");
const mathCssUrl = new URL(import.meta.resolve("@jot-md/editor/math.css"));
const mathCss = readFileSync(mathCssUrl, "utf8");
const combinedCss = readFileSync(new URL(import.meta.resolve("@jot-md/editor/styles.css")), "utf8");
if (coreCss.includes("@font-face") || coreCss.includes("fonts/")) {
  throw new Error("core.css unexpectedly includes font assets");
}
if (!mathCss.includes(".katex") || !mathCss.includes("@font-face")) {
  throw new Error("math.css is missing KaTeX styles or font declarations");
}
if (combinedCss !== coreCss + "\\n" + mathCss) {
  throw new Error("styles.css no longer matches the compatible combined entry");
}
const fontPaths = mathCss.split("fonts/").slice(1).map((suffix) => suffix.split(/[)'\"]/u)[0]);
for (const fontPath of fontPaths) {
  if (!existsSync(new URL("fonts/" + fontPath, mathCssUrl))) {
    throw new Error("math.css references an unpacked font: " + fontPath);
  }
}
const rootMath = await import("@jot-md/editor");
const dedicatedMath = await import("@jot-md/editor/math");
if (rootMath.createKaTeXRenderer !== dedicatedMath.createKaTeXRenderer) {
  throw new Error("math subpath must retain the original root renderer identity");
}
const lazyMath = await import("@jot-md/editor/math/lazy");
if (rootMath.createLazyKaTeXRenderer !== lazyMath.createLazyKaTeXRenderer) {
  throw new Error("lazy math subpath must retain the root renderer identity");
}
const dedicatedMermaid = await import("@jot-md/editor/mermaid");
if (rootMath.createMermaidPlugin !== dedicatedMermaid.createMermaidPlugin) {
  throw new Error("mermaid subpath must retain the root plugin identity");
}
const dedicatedHeadingFold = await import("@jot-md/editor/heading-fold");
if (rootMath.createHeadingFoldPlugin !== dedicatedHeadingFold.createHeadingFoldPlugin) {
  throw new Error("heading-fold subpath must retain the root plugin identity");
}
let mermaidInstalled = true;
try { import.meta.resolve("mermaid"); } catch { mermaidInstalled = false; }
if (mermaidInstalled) throw new Error("the core package must not install Mermaid for an unused optional plugin");
`, "utf8");
  run("node", ["resolve.mjs"], consumer);
  copyFileSync(resolve(root, "scripts/release/verify-packaged-worker.mjs"), resolve(consumer, "worker-test.mjs"));
  run("node", ["worker-test.mjs"], consumer);
  console.log(`ok - packed consumer verified in ${consumer}`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${String(result.status)}`);
  }
}
