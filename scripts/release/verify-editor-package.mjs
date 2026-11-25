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
const packageDirectory = resolve(root, "dist/release");
run("node", ["scripts/release/pack-editor.mjs"], root);
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "manifest.json"), "utf8"));
const [editor] = manifest.packages;
if (manifest.packages.length !== 1 || editor.name !== "@lin037/jot-md-engine") {
  throw new Error("Expected the public editor package in the release manifest");
}

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
    resolve(packageDirectory, editor.filename),
  ], consumer);
  if (existsSync(resolve(consumer, "node_modules/@jot-md/editor-protocol"))) {
    throw new Error("Standalone installation unexpectedly needs an external protocol package");
  }
  const directory = resolve(consumer, "node_modules", editor.name);
  const installed = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  if (installed.license !== "MIT" || readFileSync(resolve(directory, "LICENSE"), "utf8") !== readFileSync(resolve(root, "LICENSE"), "utf8")) {
    throw new Error(`${editor.name} is missing the project license`);
  }
  const entries = Object.keys(installed.exports).map(subpath => editor.name + subpath.slice(1));
  writeFileSync(resolve(consumer, "consumer.ts"), `
${entries.filter(entry => !entry.endsWith(".css")).map((entry, i) =>
  `import type * as PublicEntry${i} from ${JSON.stringify(entry)};`).join("\n")}
import { MarkdownEditor, mountShortcutSettings, type EditorHistorySnapshot, type EditorLayoutStyle, type EditorTheme, type EditorTranslations, type MarkdownEditorOptions, type SaveEditorImage, type ConfirmedDocumentChange } from "@lin037/jot-md-engine";
import { EditorDocumentSession, type AdapterEffect } from "@lin037/jot-md-engine/adapter";
import { EditorCommandRegistry } from "@lin037/jot-md-engine/commands";
import { TABLE_COMMAND } from "@lin037/jot-md-engine/table";
import { createKaTeXRenderer, type KaTeXRendererOptions } from "@lin037/jot-md-engine/math";
import { createLazyKaTeXRenderer } from "@lin037/jot-md-engine/math/lazy";
import { createMermaidPlugin, type MermaidPluginOptions } from "@lin037/jot-md-engine/mermaid";
import { createHeadingFoldPlugin } from "@lin037/jot-md-engine/heading-fold";
import { createToolbarPlugin, type ToolbarOptions } from "@lin037/jot-md-engine/toolbar";
import { mountOutline, createOutlinePlugin, type OutlineOptions } from "@lin037/jot-md-engine/outline";
import { CodeMirrorSource } from "@lin037/jot-md-engine/source";
import { EditorEventObserver } from "@lin037/jot-md-engine/observability";
import { EditorSurface } from "@lin037/jot-md-engine/preview";
import { bootstrapEditorWorker } from "@lin037/jot-md-engine/worker";

const editorConstructor: typeof MarkdownEditor = MarkdownEditor;
const workerBootstrap: typeof bootstrapEditorWorker = bootstrapEditorWorker;
const connectWorker = (endpoint: DedicatedWorkerGlobalScope) =>
  bootstrapEditorWorker({ endpoint, loadWasm: () => import("@lin037/jot-md-engine/wasm") });
const documentId = "consumer" as MarkdownEditorOptions["session"]["documentId"];
const options = null as unknown as MarkdownEditorOptions;
const layout: EditorLayoutStyle = { fontSize: 18, metrics: { paragraphLineHeight: 30, listMinContentWidth: 120 } };
const theme: EditorTheme = { colors: { text: "#222", selection: null }, layout };
const setTheme = (editor: MarkdownEditor): Promise<void> => editor.setTheme(theme);
const ownsProjection = (session: EditorDocumentSession, effect: AdapterEffect, owner: symbol): boolean => session.ownsProjection(effect, owner);
const initialTheme: EditorTheme | undefined = options.theme;
const translations: EditorTranslations = { fr: { Bold: "Gras" } };
function localize(editor: MarkdownEditor, panel: HTMLElement) {
  editor.setLocale("auto");
  const language: string = editor.locale;
  return { language, settings: mountShortcutSettings(panel, editor.commands, editor.i18n) };
}
void localize;
function reopenEditor(editor: MarkdownEditor, options: MarkdownEditorOptions): MarkdownEditor {
  const history: EditorHistorySnapshot | undefined = editor.captureHistory();
  return new MarkdownEditor({ ...options, history, locale: "fr", translations });
}
void layout;
void setTheme;
void ownsProjection;
void initialTheme;
void reopenEditor;
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
const toolbar: ToolbarOptions = {
  enabled: false,
  className: "consumer-toolbar",
  groups: [["format.bold", "toolbar.open-table"]],
  renderIcon: (id, document) => id === "format.bold" ? document.createTextNode("B") : undefined,
};
void createToolbarPlugin(toolbar);
const outlineOptions: OutlineOptions = { label: "Contents", rowHeight: 28 };
const bindSidebar = (sidebar: HTMLElement, editor: MarkdownEditor) => mountOutline(sidebar, editor, outlineOptions).dispose;
const outlinePlugin = (container: HTMLElement) => createOutlinePlugin({ ...outlineOptions, container, enabled: false });
const setOutlineShortcut = (editor: MarkdownEditor) => editor.commands.configureShortcuts({ "focus.outline": "Mod-Shift-8" });
const bindPanelFocus = (editor: MarkdownEditor, panel: HTMLElement) => editor.registerFocusTarget("focus.properties", panel);
void bindSidebar;
void outlinePlugin;
void setOutlineShortcut;
void bindPanelFocus;
const runExternalButton = (editor: MarkdownEditor) =>
  editor.canEdit && editor.executeCommand("format.bold", undefined, { preserveViewport: true });
void runExternalButton;
const saveImage: SaveEditorImage = file => ({ destination: "./images/" + file.name });
function bindInputs(editor: MarkdownEditor) {
  const stop = editor.onDocumentChange((change: ConfirmedDocumentChange) => void change.revision);
  const stopCommand = editor.onCommandExecuted(event => void event.id);
  if (editor.canExecuteCommand("insert.image")) editor.insertImage({ destination: "./chart.png", alt: "chart" });
  return () => { stop(); stopCommand(); };
}
void saveImage;
void bindInputs;
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
const coreCss = readFileSync(new URL(import.meta.resolve("@lin037/jot-md-engine/core.css")), "utf8");
const mathCssUrl = new URL(import.meta.resolve("@lin037/jot-md-engine/math.css"));
const mathCss = readFileSync(mathCssUrl, "utf8");
const combinedCss = readFileSync(new URL(import.meta.resolve("@lin037/jot-md-engine/styles.css")), "utf8");
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
const rootMath = await import("@lin037/jot-md-engine");
const dedicatedMath = await import("@lin037/jot-md-engine/math");
if (rootMath.createKaTeXRenderer !== dedicatedMath.createKaTeXRenderer) {
  throw new Error("math subpath must retain the original root renderer identity");
}
const lazyMath = await import("@lin037/jot-md-engine/math/lazy");
if (rootMath.createLazyKaTeXRenderer !== lazyMath.createLazyKaTeXRenderer) {
  throw new Error("lazy math subpath must retain the root renderer identity");
}
const dedicatedMermaid = await import("@lin037/jot-md-engine/mermaid");
if (rootMath.createMermaidPlugin !== dedicatedMermaid.createMermaidPlugin) {
  throw new Error("mermaid subpath must retain the root plugin identity");
}
const dedicatedHeadingFold = await import("@lin037/jot-md-engine/heading-fold");
if (rootMath.createHeadingFoldPlugin !== dedicatedHeadingFold.createHeadingFoldPlugin) {
  throw new Error("heading-fold subpath must retain the root plugin identity");
}
const { createToolbarPlugin } = await import("@lin037/jot-md-engine/toolbar");
if (createToolbarPlugin().id !== "toolbar" || createToolbarPlugin({ enabled: false }).enabled !== false) {
  throw new Error("the toolbar subpath must export an optional editor plugin");
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
