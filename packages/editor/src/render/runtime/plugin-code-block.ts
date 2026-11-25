import { editorI18nAt } from "../../core/i18n.js";
import type { RenderNode } from "@jot-md/editor-protocol";
import { numberAttribute, rangeAttribute } from "../../components/common/dom-renderer.js";
import { quotePrefix } from "../../components/common/quote-prefix.js";
import type { ResolvedCodeBlockRenderer } from "../../plugins/registry.js";
import type { RenderComponent, RenderRuntime } from "./dom-runtime.js";

/** The async renderer is a view of confirmed source, never another editor. */
export class PluginCodeBlock implements RenderComponent {
  readonly #host: HTMLElement;
  readonly #runtime: RenderRuntime;
  readonly #resolved: ResolvedCodeBlockRenderer;
  #node: RenderNode;
  #abort: AbortController | undefined;
  #epoch = 0;
  #disposed = false;
  #source: string | undefined;

  constructor(node: RenderNode, host: HTMLElement, runtime: RenderRuntime, resolved: ResolvedCodeBlockRenderer) {
    this.#node = node;
    this.#host = host;
    this.#runtime = runtime;
    this.#resolved = resolved;
    queueMicrotask(() => { if (!this.#disposed) this.#render(); });
  }

  update(node: RenderNode): void {
    const previous = this.#node;
    this.#node = node;
    if (node.contentVersion !== previous.contentVersion ||
        Number(node.sourceRange.from) !== Number(previous.sourceRange.from) ||
        Number(node.sourceRange.to) !== Number(previous.sourceRange.to) ||
        numberAttribute(node, "quoteDepth") !== numberAttribute(previous, "quoteDepth")) this.#render();
  }

  dispose(): void {
    this.#disposed = true;
    this.#epoch += 1;
    this.#abort?.abort();
  }

  invalidateLayout(): void {
    if (!this.#disposed && this.#resolved.renderer.rerenderOnLayout === true) this.#render(true);
  }

  #render(force = false): void {
    const range = rangeAttribute(this.#node, "contentRange");
    if (range === undefined) return;
    const text = this.#runtime.options.session.adapter.text.text;
    const from = Number(range.from), to = Number(range.to);
    if (from < 0 || to < from || to > text.length) return;
    const source = quotedCodeContent(text.slice(from, to), numberAttribute(this.#node, "quoteDepth") ?? 0);
    if (!force && source === this.#source) return;
    const preserve = force && source === this.#source && this.#host.dataset["jotPluginState"] === "ready";
    this.#source = source;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const epoch = ++this.#epoch;
    const commit = (rendered: Node) => {
      if (this.#disposed || abort.signal.aborted || epoch !== this.#epoch) return;
      if (rendered === null || typeof rendered !== "object" || typeof rendered.nodeType !== "number") {
        throw new Error("plugin renderer must return a DOM Node");
      }
      this.#host.replaceChildren(rendered);
      this.#host.dataset["jotPluginState"] = "ready";
      this.#host.removeAttribute("aria-busy");
    };
    const fail = (error: unknown) => {
      if (this.#disposed || abort.signal.aborted || epoch !== this.#epoch) return;
      this.#fallback(source, "图表无法渲染，显示源码");
      this.#host.dataset["jotPluginState"] = "error";
      this.#host.removeAttribute("aria-busy");
      const status = this.#host.querySelector<HTMLElement>(".jot-plugin-block__status");
      if (status !== null) status.title = error instanceof Error ? error.message : String(error);
    };
    try {
      const result = this.#resolved.renderer.render({
        source,
        language: this.#resolved.language,
        document: this.#host.ownerDocument,
        element: this.#host,
        signal: abort.signal,
        nodeId: this.#node.id,
        cacheScope: this.#runtime,
      });
      if (result !== null && typeof result === "object" && "then" in result) {
        if (preserve) this.#host.setAttribute("aria-busy", "true");
        else this.#fallback(source, "正在渲染图表…");
        void Promise.resolve(result).then(commit).catch(fail);
      } else commit(result as Node);
    } catch (error) {
      fail(error);
    }
  }

  #fallback(source: string, message: string): void {
    const document = this.#host.ownerDocument;
    const status = document.createElement("div");
    status.className = "jot-plugin-block__status";
    editorI18nAt(this.#runtime.options.root).bind(status, "textContent", message);
    const pre = document.createElement("pre");
    pre.className = "jot-plugin-block__source";
    pre.textContent = source;
    this.#host.replaceChildren(status, pre);
    this.#host.dataset["jotPluginState"] = "loading";
    this.#host.setAttribute("aria-busy", "true");
  }
}

/** Strip only the Rust-confirmed enclosing markers, preserving literal `>` in code. */
function quotedCodeContent(source: string, depth: number): string {
  if (depth <= 0 || !source.includes("\n")) return source;
  return source.split("\n").map((line, index) => {
    // contentRange starts after the opening quote prefixes on the first row.
    if (index === 0) return line;
    const prefix = quotePrefix(line, 0, depth);
    return prefix?.depth === depth ? line.slice(prefix.to) : line;
  }).join("\n");
}
