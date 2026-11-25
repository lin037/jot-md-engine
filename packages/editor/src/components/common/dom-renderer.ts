import { editorI18nAt, type EditorI18n } from "../../core/i18n.js";
import type {
  RenderNode,
  RenderValue,
  TextRange,
} from "@jot-md/editor-protocol";
import { listDisplayIndentCss } from "../../layout/list-geometry.js";
import { cachedImageMetadata, rememberImageMetadata } from "./image-metadata.js";

/** 浏览器侧可复用的图片几何元数据；Rust 不负责读取网络资源。 */
export interface ImageMetadata {
  readonly width?: number;
  readonly height?: number;
  readonly aspectRatio?: number;
}

export type ImageMetadataResolver = (source: string) => ImageMetadata | undefined;

export interface DomRenderContext {
  readonly i18n?: EditorI18n;
  readonly document: Document;
  readonly mode: EffectiveRenderMode;
  readonly sourceForRange: (range: TextRange) => string;
  readonly onDeferred: (node: RenderNode, host: HTMLElement) => void;
  readonly mountChild?: (node: RenderNode) => HTMLElement;
  readonly resolveImageSrc?: (destination: string) => string | undefined;
  readonly resolveImageMetadata?: ImageMetadataResolver;
  readonly renderMath?: (
    latex: string,
    display: boolean,
    document: Document,
  ) => Node;
  readonly onLink?: (url: string, event: MouseEvent) => void;
}

export type EffectiveRenderMode = "source" | "preview";

export function imageAspectRatioFromMetadata(
  metadata: ImageMetadata | undefined,
): number | undefined {
  if (metadata?.aspectRatio !== undefined &&
      Number.isFinite(metadata.aspectRatio) && metadata.aspectRatio > 0) {
    return metadata.aspectRatio;
  }
  const dimensions = imageDimensionsFromMetadata(metadata);
  return dimensions === undefined ? undefined : dimensions.width / dimensions.height;
}

export function imageDimensionsFromMetadata(
  metadata: ImageMetadata | undefined,
): { width: number; height: number } | undefined {
  const width = positiveImageDimension(metadata?.width);
  const height = positiveImageDimension(metadata?.height);
  return width === undefined || height === undefined ? undefined : { width, height };
}

export function renderAttribute(
  node: RenderNode,
  name: string,
): RenderValue | undefined {
  return node.attributes.find((attribute) => attribute.name === name)?.value;
}

export function stringAttribute(node: RenderNode, name: string): string | undefined {
  const value = renderAttribute(node, name);
  return value?.type === "string" ? value.value : undefined;
}

export function numberAttribute(node: RenderNode, name: string): number | undefined {
  const value = renderAttribute(node, name);
  return value?.type === "number" ? value.value : undefined;
}

export function numbersAttribute(node: RenderNode, name: string): readonly number[] {
  const value = renderAttribute(node, name);
  return value?.type === "numbers" ? value.value : [];
}

export function booleanAttribute(node: RenderNode, name: string): boolean | undefined {
  const value = renderAttribute(node, name);
  return value?.type === "boolean" ? value.value : undefined;
}

export function rangeAttribute(node: RenderNode, name: string): TextRange | undefined {
  const value = renderAttribute(node, name);
  return value?.type === "range" ? value.value : undefined;
}

export function stringsAttribute(node: RenderNode, name: string): readonly string[] {
  const value = renderAttribute(node, name);
  return value?.type === "strings" ? value.value : [];
}

export function sanitizeUrl(value: string, image = false): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") ||
      trimmed.startsWith("../")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed, "https://jot.invalid/");
    const allowed = image
      ? ["http:", "https:", "data:", "blob:"]
      : ["http:", "https:", "mailto:", "tel:"];
    if (!allowed.includes(parsed.protocol)) return undefined;
    if (parsed.protocol === "data:" && !/^data:image\//i.test(trimmed)) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

export function linkNavigationAttributes(href: string): Readonly<Record<string, string>> {
  return { href, target: "_blank", rel: "noopener noreferrer" };
}

export function activateRenderedLink(anchor: HTMLAnchorElement, event: MouseEvent, onLink?: DomRenderContext["onLink"]): void {
  const url = sanitizeUrl(anchor.getAttribute("href") ?? "");
  if (event.defaultPrevented || url === undefined) return;
  event.preventDefault();
  if (onLink !== undefined) onLink(url, event);
  else anchor.ownerDocument.defaultView?.open(anchor.href, "_blank", "noopener,noreferrer");
}

/** 不使用 innerHTML 的安全协议 RenderNode 翻译器。 */
export class RenderNodeTranslator {
  mount(node: RenderNode, context: DomRenderContext): HTMLElement {
    if (context.mode === "source") return this.#source(node, context);

    const element = this.#semanticElement(node, context);
    if (node.kind === "link") this.#updateSemanticAttributes(element, node, context);
    stamp(element, node, "preview");
    this.#appendSemanticContent(element, node, context);
    return element;
  }

  /**
   * 更新现有兼容 DOM 外壳所属的状态。子节点协调交给 RenderRuntime，从而同时
   * 保留嵌套组件身份。
   */
  update(
    element: HTMLElement,
    node: RenderNode,
    context: DomRenderContext,
    reconcileChildren: (children: readonly RenderNode[]) => void,
  ): void {
    stamp(element, node, context.mode);
    this.#updateSemanticAttributes(element, node, context);
    if (node.kind === "task-marker") {
      if (element.tagName === "INPUT") {
        (element as HTMLInputElement).checked = booleanAttribute(node, "checked") === true;
      }
      return;
    }
    if (node.kind === "thematic-break" || node.kind === "hard-break" ||
        node.kind === "image") {
      return;
    }
    if (node.kind === "inline-code" || node.kind === "inline-math" || node.kind === "escaped-text") {
      const contentRange = rangeAttribute(node, "contentRange") ?? node.sourceRange;
      const source = context.sourceForRange(contentRange);
      if (node.kind === "inline-math" && context.renderMath !== undefined) {
        element.replaceChildren(context.renderMath(source, false, context.document));
      } else if (element.textContent !== source) {
        element.textContent = source;
      }
      return;
    }
    if (node.kind === "math-block" && node.content.type !== "deferred") {
      const contentRange = rangeAttribute(node, "contentRange") ?? node.sourceRange;
      const source = context.sourceForRange(contentRange);
      if (context.renderMath !== undefined) {
        element.replaceChildren(context.renderMath(source, true, context.document));
      } else if (element.textContent !== source) {
        element.textContent = source;
      }
      return;
    }
    switch (node.content.type) {
      case "source": {
        const text = context.sourceForRange(node.sourceRange);
        const source = node.kind === "source-line"
          ? text.replace(/\n$/u, "")
          : text;
        if (element.textContent !== source) element.textContent = source;
        delete element.dataset["jotDeferred"];
        break;
      }
      case "structured":
        reconcileChildren(node.content.children);
        delete element.dataset["jotDeferred"];
        break;
      case "deferred":
        element.dataset["jotDeferred"] = "true";
        context.onDeferred(node, element);
        break;
    }
  }

  #source(node: RenderNode, context: DomRenderContext): HTMLElement {
    const block = isBlockKind(node.kind);
    const element = context.document.createElement(block ? "pre" : "span");
    element.className = block ? "jot-source-block" : "jot-source-inline";
    const text = context.sourceForRange(node.sourceRange);
    if (block) {
      const code = context.document.createElement("code");
      code.textContent = text;
      element.append(code);
    } else {
      element.textContent = text;
    }
    stamp(element, node, "source");
    return element;
  }

  #semanticElement(node: RenderNode, context: DomRenderContext): HTMLElement {
    const document = context.document;
    switch (node.kind) {
      case "document":
        return document.createElement("div");
      case "blank-line": {
        const blank = document.createElement("div");
        blank.className = "jot-blank-line";
        blank.setAttribute("role", "presentation");
        return blank;
      }
      case "paragraph":
        return document.createElement("p");
      case "heading": {
        const level = Math.max(1, Math.min(6, numberAttribute(node, "level") ?? 1));
        return document.createElement(`h${level}` as keyof HTMLElementTagNameMap);
      }
      case "block-quote":
        return document.createElement("blockquote");
      case "list-item": {
        const item = document.createElement("div");
        item.className = "jot-list-item";
        item.setAttribute("role", "listitem");
        this.#updateListItemAttributes(item, node);
        return item;
      }
      case "table": {
        const wrapper = document.createElement("div");
        wrapper.className = "jot-table";
        wrapper.setAttribute("role", "table");
        return wrapper;
      }
      case "table-row": {
        const row = document.createElement("div");
        row.className = "jot-table-row";
        row.setAttribute("role", "row");
        return row;
      }
      case "table-cell": {
        const cell = document.createElement("div");
        cell.className = "jot-table-cell";
        cell.setAttribute(
          "role",
          booleanAttribute(node, "header") === true ? "columnheader" : "cell",
        );
        const alignment = stringAttribute(node, "alignment");
        if (alignment !== undefined) cell.dataset["align"] = alignment;
        return cell;
      }
      case "fenced-code": {
        const pre = document.createElement("div");
        pre.className = "jot-code";
        pre.setAttribute("role", "region");
        const language = stringAttribute(node, "language");
        if (language !== undefined) pre.dataset["language"] = language;
        return pre;
      }
      case "math-block": {
        const math = document.createElement("div");
        math.className = "jot-math jot-math-block";
        return math;
      }
      case "thematic-break":
        return document.createElement("hr");
      case "text":
      case "escaped-text":
        {
          const text = document.createElement("span");
          text.className = "jot-inline-text";
          return text;
        }
      case "soft-break": {
        const span = document.createElement("span");
        span.className = "jot-soft-break";
        return span;
      }
      case "hard-break":
        return document.createElement("br");
      case "emphasis":
        return document.createElement("em");
      case "strong":
        return document.createElement("strong");
      case "strikethrough":
        return document.createElement("del");
      case "task-marker": {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "jot-task-checkbox";
        checkbox.checked = booleanAttribute(node, "checked") === true;
        checkbox.disabled = true;
        (context.i18n ?? editorI18nAt(checkbox)).bind(checkbox, "aria-label", "Task status");
        return checkbox;
      }
      case "inline-code":
        return document.createElement("code");
      case "inline-math": {
        const math = document.createElement("span");
        math.className = "jot-math jot-math-inline";
        return math;
      }
      case "link":
        return document.createElement("a");
      case "image": {
        const image = document.createElement("img");
        image.className = "jot-image";
        this.#updateImageAttributes(image, node, context);
        return image;
      }
      case "source-line": {
        const line = document.createElement("div");
        line.className = "jot-source-line";
        line.setAttribute("role", "presentation");
        return line;
      }
      case "dirty-source": {
        const dirty = document.createElement("pre");
        dirty.className = "jot-dirty-source";
        return dirty;
      }
      default: {
        const element = document.createElement("div");
        element.className = "jot-unhandled-node";
        element.dataset["nodeType"] = node.kind;
        return element;
      }
    }
  }

  #updateSemanticAttributes(
    element: HTMLElement,
    node: RenderNode,
    context: DomRenderContext,
  ): void {
    switch (node.kind) {
      case "list-item":
        this.#updateListItemAttributes(element, node);
        break;
      case "table-cell": {
        element.setAttribute(
          "role",
          booleanAttribute(node, "header") === true ? "columnheader" : "cell",
        );
        const alignment = stringAttribute(node, "alignment");
        if (alignment === undefined) delete element.dataset["align"];
        else element.dataset["align"] = alignment;
        break;
      }
      case "fenced-code": {
        const language = stringAttribute(node, "language");
        if (language === undefined) delete element.dataset["language"];
        else element.dataset["language"] = language;
        break;
      }
      case "link": {
        const anchor = element as HTMLAnchorElement;
        const destination = stringAttribute(node, "destination");
        const safe = destination === undefined ? undefined : sanitizeUrl(destination);
        if (safe === undefined) {
          anchor.removeAttribute("href");
          anchor.removeAttribute("target");
          anchor.removeAttribute("rel");
          anchor.onclick = null;
        } else {
          for (const [name, value] of Object.entries(linkNavigationAttributes(safe))) {
            anchor.setAttribute(name, value);
          }
          anchor.onclick = context.onLink === undefined
            ? null
            : (event) => {
                event.preventDefault();
                context.onLink!(safe, event);
              };
        }
        const title = stringAttribute(node, "title");
        if (title === undefined) anchor.removeAttribute("title");
        else anchor.title = title;
        break;
      }
      case "image": {
        this.#updateImageAttributes(element, node, context);
        break;
      }
    }
  }

  #updateImageAttributes(
    element: HTMLElement,
    node: RenderNode,
    context: DomRenderContext,
  ): void {
    const image = element as HTMLImageElement;
    const destination = stringAttribute(node, "destination");
    const src = destination === undefined || context.resolveImageSrc === undefined
      ? destination : context.resolveImageSrc(destination);
    const localResource = context.resolveImageSrc !== undefined && src && /^(?:file|asset):\/\//iu.test(src);
    const safe = localResource ? src : src ? sanitizeUrl(src, true) : undefined;
    const metadata = context.resolveImageMetadata?.(destination ?? "") ??
      cachedImageMetadata(context.document, destination ?? "");
    // Reserve geometry before setting src. Reusing a mounted image must not
    // restart decode or erase dimensions recorded by its previous load.
    applyImageMetadata(image, metadata);
    image.onload = () => {
      const previous = cachedImageMetadata(context.document, destination ?? "");
      const intrinsic = rememberImageMetadata(image, destination ?? "");
      applyImageMetadata(image, context.resolveImageMetadata?.(destination ?? "") ?? intrinsic);
      if (intrinsic !== undefined && (previous?.width !== intrinsic.width || previous?.height !== intrinsic.height)) {
        const EventType = context.document.defaultView?.Event;
        if (EventType !== undefined) image.dispatchEvent(new EventType("jot-image-metadata", { bubbles: true }));
      }
    };
    if (safe === undefined) image.removeAttribute("src");
    else if (image.getAttribute("src") !== safe) image.setAttribute("src", safe);
    image.alt = stringAttribute(node, "alt") ?? "";
    const title = stringAttribute(node, "title");
    if (title === undefined) image.removeAttribute("title");
    else image.title = title;
  }

  #updateListItemAttributes(element: HTMLElement, node: RenderNode): void {
    const number = numberAttribute(node, "number");
    if (number === undefined) element.removeAttribute("value");
    else element.setAttribute("value", String(number));
    const marker = stringAttribute(node, "marker");
    if (marker === undefined) delete element.dataset["marker"];
    else element.dataset["marker"] = marker;
    const delimiter = stringAttribute(node, "delimiter");
    if (delimiter === undefined) delete element.dataset["delimiter"];
    else element.dataset["delimiter"] = delimiter;
    const indentColumns = numberAttribute(node, "indentColumns") ?? 0;
    const normalizedIndent = Math.max(0, indentColumns);
    const boundedIndent = listDisplayIndentCss(normalizedIndent, number === undefined ? 0 : String(number).length + 1);
    element.style.marginInlineStart = normalizedIndent === 0 ? "0ch" : boundedIndent;
    element.style.width = normalizedIndent === 0
      ? "100%"
      : `calc(100% - ${boundedIndent})`;
    element.style.maxWidth = "100%";
    element.style.boxSizing = "border-box";
    element.dataset["jotListIndent"] = String(normalizedIndent);
    element.dataset["jotListLevel"] = String(listLevelFromIndentColumns(normalizedIndent));
    const markerText = marker !== undefined ? "•" : (
      number === undefined ? undefined : `${number}${delimiter ?? "."}`
    );
    if (markerText === undefined) delete element.dataset["markerText"];
    else element.dataset["markerText"] = markerText;
  }

  #appendSemanticContent(
    element: HTMLElement,
    node: RenderNode,
    context: DomRenderContext,
  ): void {
    if (node.kind === "thematic-break" || node.kind === "hard-break" || node.kind === "task-marker") return;
    if (node.kind === "image") return;
    if (node.kind === "inline-code" || node.kind === "inline-math" || node.kind === "escaped-text") {
      const contentRange = rangeAttribute(node, "contentRange") ?? node.sourceRange;
      const source = context.sourceForRange(contentRange);
      if (node.kind === "inline-math" && context.renderMath !== undefined) {
        element.append(context.renderMath(source, false, context.document));
      } else {
        element.textContent = source;
      }
      return;
    }
    if (node.kind === "math-block" && node.content.type !== "deferred") {
      const contentRange = rangeAttribute(node, "contentRange") ?? node.sourceRange;
      const source = context.sourceForRange(contentRange);
      if (context.renderMath !== undefined) {
        element.append(context.renderMath(source, true, context.document));
      } else {
        element.textContent = source;
      }
      return;
    }
    switch (node.content.type) {
      case "source":
        {
          const text = context.sourceForRange(node.sourceRange);
          element.textContent = node.kind === "source-line"
            ? text.replace(/\n$/u, "")
            : text;
        }
        break;
      case "structured":
        for (const child of node.content.children) {
          element.append(context.mountChild?.(child) ?? this.mount(child, context));
        }
        break;
      case "deferred":
        element.dataset["jotDeferred"] = "true";
        context.onDeferred(node, element);
        break;
    }
  }
}

function applyImageMetadata(
  image: HTMLImageElement,
  metadata: ImageMetadata | undefined,
): void {
  const dimensions = imageDimensionsFromMetadata(metadata);
  if (dimensions !== undefined) {
    image.setAttribute("width", String(dimensions.width));
    image.setAttribute("height", String(dimensions.height));
  } else {
    image.removeAttribute("width");
    image.removeAttribute("height");
  }

  const aspectRatio = imageAspectRatioFromMetadata(metadata);
  if (aspectRatio === undefined) {
    image.style.height = "var(--jot-image-fallback-height, 220px)";
    image.style.removeProperty("aspect-ratio");
    delete image.dataset["jotImageAspectRatio"];
  } else {
    image.style.height = "auto";
    image.style.aspectRatio = String(aspectRatio);
    image.dataset["jotImageAspectRatio"] = String(aspectRatio);
  }
}

function positiveImageDimension(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Jot 保留精确的源码缩进列数。这里计算的显示层级只用于视觉辅助，源码缩进仍
 * 是权威值。
 */
export function listLevelFromIndentColumns(indentColumns: number): number {
  const normalized = Math.max(0, Math.floor(indentColumns));
  return normalized === 0 ? 0 : Math.max(1, Math.ceil(normalized / 2));
}

function stamp(
  element: HTMLElement,
  node: RenderNode,
  mode: EffectiveRenderMode,
): void {
  element.classList.add(`jot-md-${node.kind}`);
  element.dataset["jotNodeId"] = node.id;
  element.dataset["jotKind"] = node.kind;
  element.dataset["jotSourceFrom"] = String(node.sourceRange.from);
  element.dataset["jotSourceTo"] = String(node.sourceRange.to);
  element.dataset["jotContentVersion"] = String(node.contentVersion);
  element.dataset["jotMode"] = mode;
  const content = rangeAttribute(node, "contentRange");
  if (content === undefined) {
    delete element.dataset["jotSourceContentFrom"];
    delete element.dataset["jotSourceContentTo"];
  } else {
    element.dataset["jotSourceContentFrom"] = String(content.from);
    element.dataset["jotSourceContentTo"] = String(content.to);
  }
}

function isBlockKind(kind: string): boolean {
  return ![
    "text",
    "escaped-text",
    "soft-break",
    "hard-break",
    "emphasis",
    "strong",
    "strikethrough",
    "task-marker",
    "inline-code",
    "inline-math",
    "link",
    "image",
  ].includes(kind);
}
