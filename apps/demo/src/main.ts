import type { DocumentId } from "../../../packages/editor-protocol/src/index.js";
import { MarkdownEditor, createHeadingFoldPlugin,
  type MarkdownEditorMode } from "../../../packages/editor/src/component/index.js";
import { createLazyKaTeXRenderer } from "../../../packages/editor/src/components/math/lazy-katex.js";
import { displayShortcut } from "../../../packages/editor/src/component/shortcut-settings.js";
import { createMermaidPlugin } from "../../../packages/editor/src/plugins/mermaid.js";
import { createToolbarPlugin } from "../../../packages/editor/src/plugins/toolbar.js";
import logo from "../../../docs/assets/jot.svg?url";
import { bindRuntimePanel } from "./runtime-panel.js";
import { sample } from "./sample.js";
import { bindShortcuts } from "./shortcuts.js";
import { bindStyleLab } from "./style-lab.js";
import { loadMermaid } from "./mermaid-loader.js";
import "katex/dist/katex.min.css";
import "./style.css";

document.querySelector<HTMLImageElement>("#brand-logo")!.src = logo;
document.querySelector<HTMLLinkElement>("#app-icon")!.href = logo;

const root = document.querySelector<HTMLElement>("#editor-root")!;
const mode = document.querySelector<HTMLSelectElement>("#mode")!;
const dataset = document.querySelector<HTMLSelectElement>("#sample")!;
const font = document.querySelector<HTMLSelectElement>("#font")!;
const theme = document.querySelector<HTMLButtonElement>("#theme")!;
const codeWrap = document.querySelector<HTMLSelectElement>("#code-wrap")!;
const mermaid = document.querySelector<HTMLInputElement>("#mermaid")!;
const headingFold = document.querySelector<HTMLInputElement>("#heading-fold")!;
const editorToolbar = document.querySelector<HTMLInputElement>("#editor-toolbar")!;
const load = document.querySelector<HTMLButtonElement>("#load")!;
const insert = document.querySelector<HTMLButtonElement>("#insert")!;
const status = document.querySelector<HTMLElement>("#status")!;
const shortcutsButton = document.querySelector<HTMLButtonElement>("#open-shortcuts")!;
const fonts = {
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", STSong, "Noto Serif CJK SC", SimSun, serif',
  mono: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
} as const;
let textPending = false;
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const editor = new MarkdownEditor({
  root,
  mode: "live-preview",
  openShortcutSettings: () => shortcutsButton.click(),
  plugins: [
    createMermaidPlugin({
      enabled: true, load: loadMermaid, theme: "base",
      themeVariables(host) {
        const style = getComputedStyle(host);
        const color = (name: string) => style.getPropertyValue(name).trim();
        return {
          darkMode: document.documentElement.dataset["theme"] === "dark",
          background: color("--paper"),
          primaryColor: color("--control-hover"),
          primaryTextColor: color("--ink"),
          primaryBorderColor: color("--accent"),
          secondaryColor: color("--quote"),
          tertiaryColor: color("--code"),
          textColor: color("--ink"),
          lineColor: color("--muted"),
          clusterBkg: color("--surround"),
          clusterBorder: color("--rule-strong"),
          edgeLabelBackground: color("--paper"),
          fontFamily: fonts.sans,
          fontSize: "17px",
        };
      },
    }),
    createHeadingFoldPlugin(),
    createToolbarPlugin({ enabled: editorToolbar.checked }),
  ],
  session: {
    endpoint: worker,
    documentId: "demo" as DocumentId,
    generation: 1,
    source: sample("article"),
    syntaxProfile: {
      id: "default", version: 1,
      enabledExtensions: [{ id: "commonmark-fence-language", version: "1.0.0" }],
    },
  },
  input: { onInputTransaction: () => {
    textPending = editor.value !== editor.confirmedValue;
    updateStatus();
  } },
  surface: { renderMath: createLazyKaTeXRenderer(), table: { mode: "adaptive" } },
  theme: {
    colors: {
      background: "var(--paper)", text: "var(--ink)", muted: "var(--muted)",
      codeBackground: "var(--code)", link: "var(--accent)", quote: "var(--ink)",
      quoteBackground: "var(--quote)", quoteBorder: "var(--rule-strong)",
      searchMatch: "var(--match)", searchCurrent: "var(--match-current)",
      selection: "var(--selection)",
    },
    layout: {
      fontFamily: fonts.sans,
      fontSize: 17,
      metrics: {
        tableToolbarHeight: 32,
      },
    },
  },
  onError: reportError,
});
const disposeShortcuts = bindShortcuts(editor);
bindStyleLab();
const runtime = bindRuntimePanel(editor, root);
const inspector = document.querySelector<HTMLElement>("#inspector")!;
const stylePanel = document.querySelector<HTMLElement>("#style-panel")!;
const performancePanel = document.querySelector<HTMLElement>("#performance-panel")!;
const styleButton = document.querySelector<HTMLButtonElement>("#open-style")!;
const performanceButton = document.querySelector<HTMLButtonElement>("#open-performance")!;
const commandsButton = document.querySelector<HTMLButtonElement>("#open-commands")!;
const documentSize = document.querySelector("#document-size")!;
const fontSize = document.querySelector<HTMLInputElement>("#font-size")!;
let panel: "style" | "performance" | undefined;

function showPanel(next: typeof panel): void {
  const wasHidden = inspector.hidden;
  panel = next;
  inspector.hidden = next === undefined;
  stylePanel.hidden = next !== "style";
  performancePanel.hidden = next !== "performance";
  document.querySelector("#inspector-title")!.textContent = next === "performance" ? "运行数据" : "样式";
  styleButton.setAttribute("aria-expanded", String(next === "style"));
  performanceButton.setAttribute("aria-expanded", String(next === "performance"));
  runtime.setVisible(next === "performance");
  // 纸面可能只平移而没有变宽，固定滚动条仍需重新读取位置。
  if (wasHidden !== inspector.hidden) void editor.invalidateLayout().catch(reportError);
}

styleButton.addEventListener("click", () => {
  showPanel(panel === "style" ? undefined : "style");
  if (panel === "style") font.focus();
});
performanceButton.addEventListener("click", () => {
  showPanel(panel === "performance" ? undefined : "performance");
  if (panel === "performance") document.querySelector<HTMLButtonElement>("#load-large")!.focus();
});
function closePanel(): void {
  const trigger = panel === "performance" ? performanceButton : styleButton;
  showPanel(undefined);
  trigger.focus();
}
document.querySelector("#close-inspector")!.addEventListener("click", closePanel);
inspector.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.preventDefault();
    closePanel();
  }
});
document.querySelector("#load-large")!.addEventListener("click", () => {
  dataset.value = "text";
  load.click();
});
commandsButton.addEventListener("click", () => editor.openCommandPalette());
const commandHint = commandsButton.querySelector("kbd")!;
function updateCommandHint(): void {
  const binding = editor.commands.shortcuts.find(shortcut => shortcut.command === "command.palette");
  commandHint.hidden = binding === undefined;
  commandHint.textContent = binding === undefined ? "" : displayShortcut(binding.key, editor.commands.shortcutPlatform === "mac");
}
const unsubscribeCommandHint = editor.commands.subscribe(updateCommandHint);
updateCommandHint();
editor.subscribe(effect => {
  // 只有文本提交才能改变已确认正文。后台解析和滚动时无需再次比较整份文本。
  if (effect.documentPatch) textPending = editor.value !== editor.confirmedValue;
  if (effect.documentPatch || effect.analysis) updateStatus();
});
let modeRequest = 0;
mode.addEventListener("change", () => {
  const next = mode.value as MarkdownEditorMode;
  const request = ++modeRequest;
  insert.disabled = true;
  void (async () => {
    if (next === "split") await editor.setSurfaceMode("preview");
    if (request !== modeRequest) return;
    await editor.setMode(next);
    if (request === modeRequest) insert.disabled = next === "preview" || next === "pretext";
  })().catch(reportError);
});
let fontRequest = 0;
let fontTask = Promise.resolve();
font.addEventListener("change", () => {
  const family = fonts[font.value as keyof typeof fonts];
  if (family === undefined) return;
  const request = ++fontRequest;
  fontTask = fontTask.catch(() => {}).then(async () => {
    if (request === fontRequest) await editor.setLayoutStyle({ fontFamily: family });
  });
  void fontTask.catch(reportError);
});
fontSize.addEventListener("change", () => {
  const size = fontSize.valueAsNumber;
  if (!fontSize.checkValidity() || !Number.isFinite(size)) return;
  fontTask = fontTask.catch(() => {}).then(() => editor.setLayoutStyle({ fontSize: size }));
  void fontTask.catch(reportError);
});
let codeWrapRequest = 0;
codeWrap.addEventListener("change", () => {
  const value = codeWrap.value;
  if (value !== "wrap" && value !== "scroll") return;
  const request = ++codeWrapRequest;
  fontTask = fontTask.catch(() => {}).then(async () => {
    if (request === codeWrapRequest) await editor.setLayoutStyle({ codeBlockWrap: value });
  });
  void fontTask.catch(reportError);
});
theme.addEventListener("click", () => {
  const dark = document.documentElement.dataset["theme"] !== "dark";
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  theme.setAttribute("aria-pressed", String(dark));
  void editor.invalidateLayout().catch(reportError);
});
mermaid.addEventListener("change", () => {
  void editor.setPluginEnabled("mermaid", mermaid.checked).catch(reportError);
});
headingFold.addEventListener("change", () => {
  void editor.setPluginEnabled("heading-fold", headingFold.checked).catch(reportError);
});
editorToolbar.addEventListener("change", () => {
  void editor.setPluginEnabled("toolbar", editorToolbar.checked).catch(reportError);
});
load.addEventListener("click", () => {
  try { clearError(); editor.setValue(sample(dataset.value)); } catch (error) { reportError(error); }
});
insert.addEventListener("click", () => {
  try {
    clearError();
    const view = editor.input.view;
    // 与多行粘贴使用相同的输入事务，选区替换后光标落在新文本末尾。
    view.dispatch(view.state.replaceSelection(`\n${sample(dataset.value)}\n`), {
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    view.focus();
  } catch (error) { reportError(error); }
});
window.addEventListener("beforeunload", () => {
  disposeShortcuts();
  unsubscribeCommandHint();
  runtime.dispose();
  editor.dispose();
  worker.terminate();
});
void editor.open().then(() => {
  mode.disabled = font.disabled = codeWrap.disabled = load.disabled = insert.disabled = mermaid.disabled = headingFold.disabled = false;
  editorToolbar.disabled = false;
  styleButton.disabled = performanceButton.disabled = commandsButton.disabled = false;
  shortcutsButton.disabled = false;
  updateStatus();
}).catch(reportError);

function updateStatus(): void {
  if (status.hasAttribute("data-error")) return;
  const analysis = editor.session.adapter.analysis;
  const label = textPending ? "等待正文确认…"
    : analysis?.state === "complete" ? "正文已确认"
    : analysis?.state === "failed" ? "已确认 · 解析失败"
    : analysis?.state === "cancelled" ? "已确认 · 解析已取消"
    : "正文已确认 · 语法解析中";
  if (status.textContent !== label) status.textContent = label;
  const lines = `${editor.session.adapter.text.lineCount.toLocaleString()} 行`;
  if (documentSize.textContent !== lines) documentSize.textContent = lines;
}

function clearError(): void {
  delete status.dataset["error"];
}

function reportError(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.dataset["error"] = "true";
  console.error(error);
}
