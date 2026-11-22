import type { RenderNode } from "@jot-md/editor-protocol";
import { rangeAttribute, stringAttribute } from "../components/common/dom-renderer.js";
import type { MarkdownEditor } from "../component/markdown-editor.js";

/** Plugins are trusted application code. They do not extend the Rust grammar. */
export interface MarkdownEditorPlugin {
  readonly id: string;
  /** A supplied plugin is enabled by default; set false for an opt-in UI. */
  readonly enabled?: boolean;
  /** Defaults to true. External controls can opt out of remeasuring the editor on toggle. */
  readonly affectsEditorLayout?: boolean;
  readonly codeBlocks?: readonly PluginCodeBlockRenderer[];
  /** Register commands or other editor capabilities and return their cleanup. */
  readonly activate?: (editor: MarkdownEditor) => void | (() => void);
}

export interface PluginCodeBlockRenderer {
  readonly languages: readonly string[];
  /** Larger source blocks retain ordinary, virtualized code rendering. */
  readonly maxSourceLength?: number;
  /** Re-render visible content when the host invalidates its layout/theme. */
  readonly rerenderOnLayout?: boolean;
  readonly render: (input: {
    readonly source: string;
    readonly language: string;
    readonly document: Document;
    readonly element: HTMLElement;
    readonly signal: AbortSignal;
    /** Stable identity within this rendering host; content can change. */
    readonly nodeId: string;
    /** Opaque identity of this host, for bounded per-host caches. */
    readonly cacheScope: object;
  }) => Node | Promise<Node>;
}

export interface ResolvedCodeBlockRenderer {
  readonly pluginId: string;
  readonly language: string;
  readonly renderer: PluginCodeBlockRenderer;
}

interface PluginEntry {
  readonly plugin: MarkdownEditorPlugin;
  enabled: boolean;
  cleanup: (() => void) | undefined;
}

/** Per-editor, deterministic registry; no plugin owns the Markdown source. */
export class EditorPluginRegistry {
  readonly #entries = new Map<string, PluginEntry>();
  readonly #languages = new Map<string, { entry: PluginEntry; renderer: PluginCodeBlockRenderer }>();

  constructor(plugins: readonly MarkdownEditorPlugin[] = []) {
    for (const plugin of plugins) {
      if (!plugin.id.trim() || this.#entries.has(plugin.id)) {
        throw new Error(`invalid or duplicate editor plugin id: ${plugin.id}`);
      }
      const entry: PluginEntry = { plugin, enabled: plugin.enabled !== false, cleanup: undefined };
      this.#entries.set(plugin.id, entry);
      for (const renderer of plugin.codeBlocks ?? []) {
        if (renderer.maxSourceLength !== undefined &&
            (!Number.isSafeInteger(renderer.maxSourceLength) || renderer.maxSourceLength < 1)) {
          throw new Error(`invalid code block size limit for plugin: ${plugin.id}`);
        }
        if (renderer.languages.length === 0) throw new Error(`plugin ${plugin.id} has no code block languages`);
        for (const language of renderer.languages) {
          const key = language.trim().toLowerCase();
          if (!key || this.#languages.has(key)) throw new Error(`invalid or duplicate plugin language: ${language}`);
          this.#languages.set(key, { entry, renderer });
        }
      }
    }
  }

  activate(editor: MarkdownEditor): void {
    try {
      for (const entry of this.#entries.values()) if (entry.enabled) this.#start(entry, editor);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  setEnabled(editor: MarkdownEditor, id: string, enabled: boolean, onError?: (error: unknown) => void): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new Error(`unknown editor plugin: ${id}`);
    if (entry.enabled === enabled) return false;
    if (enabled) {
      entry.enabled = true;
      try { this.#start(entry, editor); } catch (error) { entry.enabled = false; throw error; }
    } else {
      entry.enabled = false;
      const cleanup = entry.cleanup;
      entry.cleanup = undefined;
      try { cleanup?.(); } catch (error) { onError?.(error); }
    }
    return true;
  }

  isEnabled(id: string): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new Error(`unknown editor plugin: ${id}`);
    return entry.enabled;
  }

  affectsEditorLayout(id: string): boolean {
    return this.#entries.get(id)?.plugin.affectsEditorLayout !== false;
  }

  hasEnabledCodeBlocks(): boolean {
    for (const { entry } of this.#languages.values()) if (entry.enabled) return true;
    return false;
  }

  codeBlock(node: RenderNode): ResolvedCodeBlockRenderer | undefined {
    if (node.kind !== "fenced-code") return undefined;
    const language = stringAttribute(node, "language")?.toLowerCase();
    const candidate = language === undefined ? undefined : this.#languages.get(language);
    if (candidate === undefined || !candidate.entry.enabled || language === undefined) return undefined;
    const range = rangeAttribute(node, "contentRange");
    if (range === undefined || Number(range.from) < Number(node.sourceRange.from) ||
        Number(range.from) > Number(range.to) || Number(range.to) > Number(node.sourceRange.to) ||
        (candidate.renderer.maxSourceLength !== undefined &&
         Number(range.to) - Number(range.from) > candidate.renderer.maxSourceLength)) return undefined;
    return { pluginId: candidate.entry.plugin.id, language, renderer: candidate.renderer };
  }

  dispose(onError?: (error: unknown) => void): void {
    for (const entry of [...this.#entries.values()].reverse()) {
      const cleanup = entry.cleanup;
      entry.cleanup = undefined;
      try { cleanup?.(); } catch (error) { onError?.(error); }
    }
  }

  #start(entry: PluginEntry, editor: MarkdownEditor): void {
    const cleanup = entry.plugin.activate?.(editor);
    if (cleanup !== undefined && typeof cleanup !== "function") {
      throw new Error(`plugin ${entry.plugin.id} returned an invalid cleanup`);
    }
    entry.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}
