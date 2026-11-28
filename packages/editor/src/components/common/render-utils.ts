import type {
  RenderNode,
  TextEdit,
  TextRange,
} from "@jot-md/editor-protocol";
import {
  numberAttribute,
  type ImageMetadataResolver,
  type ImageMetadata,
} from "./dom-renderer.js";
import { cachedImageMetadata } from "./image-metadata.js";

export function domDepth(element: HTMLElement, root: HTMLElement): number {
  let depth = 0;
  let current: HTMLElement | null = element;
  while (current !== null && current !== root) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

export function isRevisionMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("REVISION_MISMATCH:");
}

export async function tolerateStaleProjection<T>(
  request: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await request();
  } catch (error) {
    if (isRevisionMismatch(error)) return undefined;
    throw error;
  }
}

export function mapOffsetThroughEdits(
  offset: number,
  edits: readonly TextEdit[],
): number {
  let delta = 0;
  for (const edit of edits) {
    const from = Number(edit.range.from);
    const to = Number(edit.range.to);
    if (offset < from) break;
    if (offset <= to) return from + delta;
    delta += edit.insert.length - (to - from);
  }
  return offset + delta;
}

export function renderNodeKey(node: RenderNode): string {
  return `${node.id}:${renderNodeShapeKey(node)}`;
}

/**
 * 只描述 DOM 外壳。content version 有意不参与：同一逻辑节点的新版本必须原地
 * 更新。会改变实际 HTML 标签的属性仍属于结构身份。
 */
export function renderNodeShapeKey(node: RenderNode): string {
  return node.kind === "heading"
    ? `heading:h${numberAttribute(node, "level") ?? 1}`
    : node.kind;
}

export { replacesMostDocument } from "../../adapter/edit-batch.js";

type RtlScrollType = "negative" | "default" | "reverse";
const rtlScrollTypes = new WeakMap<Document, RtlScrollType>();

/** 将浏览器相关的 RTL scrollLeft 值转换为物理左偏移。 */
export function logicalScrollLeft(element: HTMLElement): number {
  const view = element.ownerDocument.defaultView;
  const direction = view === null ? "ltr" : view.getComputedStyle(element).direction;
  if (direction !== "rtl") return Math.max(0, element.scrollLeft);
  const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
  const type = getRtlScrollType(element.ownerDocument);
  if (type === "negative") return Math.max(0, Math.min(maximum, maximum + element.scrollLeft));
  if (type === "reverse") return Math.max(0, Math.min(maximum, element.scrollLeft));
  return Math.max(0, Math.min(maximum, maximum - element.scrollLeft));
}

export function setLogicalScrollLeft(element: HTMLElement, value: number): void {
  const view = element.ownerDocument.defaultView;
  const direction = view === null ? "ltr" : view.getComputedStyle(element).direction;
  const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
  const target = Math.max(0, Math.min(maximum, value));
  if (direction !== "rtl") {
    element.scrollLeft = target;
    return;
  }
  const type = getRtlScrollType(element.ownerDocument);
  element.scrollLeft = type === "negative"
    ? target - maximum
    : type === "reverse"
      ? target
      : maximum - target;
}

function getRtlScrollType(document: Document): RtlScrollType {
  const cached = rtlScrollTypes.get(document);
  if (cached !== undefined) return cached;
  const host = document.createElement("div");
  const content = document.createElement("div");
  host.dir = "rtl";
  host.style.cssText = "position:absolute;inline-size:4px;block-size:1px;overflow:scroll;visibility:hidden;";
  content.style.cssText = "inline-size:8px;block-size:1px;";
  host.append(content);
  (document.body ?? document.documentElement).append(host);
  const initial = host.scrollLeft;
  let type: RtlScrollType;
  if (initial > 0) type = "default";
  else {
    host.scrollLeft = 1;
    type = host.scrollLeft === 0 ? "negative" : "reverse";
  }
  host.remove();
  rtlScrollTypes.set(document, type);
  return type;
}

export function isInlineOwner(kind: string): boolean {
  return [
    "paragraph",
    "heading",
    "table-cell",
    "emphasis",
    "strong",
    "strikethrough",
    "link",
    "image",
  ].includes(kind);
}

export function stamp(
  element: HTMLElement,
  id: string,
  kind: string,
  range: TextRange,
): void {
  element.dataset["jotNodeId"] = id;
  element.dataset["jotKind"] = kind;
  element.dataset["jotSourceFrom"] = String(range.from);
  element.dataset["jotSourceTo"] = String(range.to);
}

export function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveSurfaceImageMetadata(
  resolver: ImageMetadataResolver | undefined,
  source: string,
  document: Document,
): ImageMetadata | undefined {
  return resolver?.(source) ?? cachedImageMetadata(document, source);
}

export function safeUtf16SliceEnd(
  source: string,
  requestedEnd: number,
  rangeEnd: number,
): number {
  if (requestedEnd <= 0 || requestedEnd >= rangeEnd) return requestedEnd;
  const previous = source.charCodeAt(requestedEnd - 1);
  const next = source.charCodeAt(requestedEnd);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? Math.min(rangeEnd, requestedEnd + 1)
    : requestedEnd;
}

/**
 * 把 DOM/CodeMirror 的 UTF-16 光标偏移限制在当前文本，并避免落在 surrogate
 * pair 中间。Rust 的 TextBuffer 以 UTF-16 对外通信，但内部切片仍要求字符边界。
 */
export function safeUtf16Offset(
  source: string,
  requested: number,
  assoc: -1 | 1 = 1,
): number {
  let offset = Number.isFinite(requested)
    ? Math.max(0, Math.min(source.length, Math.trunc(requested)))
    : 0;
  const previous = source.charCodeAt(offset - 1);
  const next = source.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff &&
      next >= 0xdc00 && next <= 0xdfff) {
    offset += assoc < 0 ? -1 : 1;
  }
  return offset;
}

export function pretextContentSignature(node: RenderNode): string {
  if (node.content.type !== "structured") return node.content.type;
  return `structured:${node.content.children.map((child) => [
    child.id,
    child.kind,
    child.contentVersion,
    child.content.type,
  ].join("/")).join(",")}`;
}

export function isAtScrollEnd(element: HTMLElement, tolerance = 2): boolean {
  const maximum = element.scrollHeight - element.clientHeight;
  return maximum > tolerance && maximum - element.scrollTop <= tolerance;
}

export function scrollElementToEnd(element: HTMLElement): void {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

export function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}


export function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function nextLayoutFrame(root: HTMLElement): Promise<void> {
  const view = root.ownerDocument.defaultView;
  if (view === null || view === undefined) return Promise.resolve();
  return new Promise((resolve) => view.requestAnimationFrame(() => resolve()));
}
