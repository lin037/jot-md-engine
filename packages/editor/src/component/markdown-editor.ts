import type { EditorSelection, Revision, TextRange } from "@jot-md/editor-protocol";
import {
  DEFAULT_EDITOR_BUDGETS,
  EditorDocumentSession,
  EditorTransactionCoordinator,
  type AdapterEffect,
  type EditorDocumentSessionOptions,
  type TransactionBuilder,
} from "../adapter/index.js";
import {
  CodeMirrorSource,
  type CodeMirrorSourceOptions,
} from "../hosts/source/codemirror-source.js";
import { createDefaultEditorCommandRegistry } from "../components/commands.js";
import { EditorCommandRegistry, type TableInsertionSize } from "../core/commands/index.js";
import { replaceTableCell as createTableCellEdit } from "../components/table/source.js";
import type { TableCommandExecutor } from "../components/table/commands.js";
import {
  LivePreviewController,
  type LivePreviewOptions,
} from "../hosts/live-preview/index.js";
import {
  EditorSurface,
  type EditorSurfaceMode,
  type EditorSurfaceOptions,
} from "../hosts/preview/surface.js";
import type { TableLayoutSnapshot } from "../components/table/layout.js";
import {
  EditorEventObserver,
  type EditorEventObserverOptions,
} from "../observability/index.js";
import { installMarkdownEditorStyles } from "./styles.js";
import { mountEditorCommandUI } from "./command-palette.js";
import type { EditorSearchQuery } from "../hosts/source/search.js";
import { safeUtf16Offset } from "../components/common/render-utils.js";
import { applyEditorTypography, validateEditorLayoutStyle, type EditorLayoutStyle } from "../layout/pretext/options.js";
import { applyEditorThemeColors, validateEditorTheme, type EditorTheme } from "./theme.js";
import { EditorPluginRegistry, type MarkdownEditorPlugin } from "../plugins/registry.js";
import { HeadingFoldController } from "../hosts/folding/heading-fold.js";

export type MarkdownEditorMode =
  | "source"
  | "pretext"
  | "preview"
  | "split"
  | "live-preview";

export interface MarkdownEditorOptions {
  readonly root: HTMLElement;
  readonly session: EditorDocumentSessionOptions;
  readonly mode?: MarkdownEditorMode;
  /** `mode` 为 `split` 时显示在 Source 旁边的 Surface，默认是 Preview。 */
  readonly surfaceMode?: EditorSurfaceMode;
  readonly input?: Omit<
    CodeMirrorSourceOptions,
    "root" | "session" | "transactions" | "onError" | "commands"
  >;
  /** 未指定时使用内置的编辑、格式、块结构和表格命令。 */
  readonly commands?: EditorCommandRegistry;
  /** 让命令面板打开宿主提供的快捷键设置。 */
  readonly openShortcutSettings?: () => void;
  /** Trusted optional plugins, scoped to this editor instance. */
  readonly plugins?: readonly MarkdownEditorPlugin[];
  readonly surface?: Omit<
    EditorSurfaceOptions,
    "root" | "session" | "mode" | "active" | "onError" | "pluginRegistry" | "headingFolds"
  >;
  /** CodeMirror Live Preview 的可见投影、部件与性能边界。 */
  readonly livePreview?: LivePreviewOptions;
  /** 事务级组件观测；原始 wire 旁路仍属于 advanced API。 */
  readonly observability?: EditorEventObserverOptions;
  readonly installStyles?: boolean;
  /** Initial colors and geometry are applied before either host opens. */
  readonly theme?: EditorTheme;
  readonly onError?: (error: unknown) => void;
}

export interface MarkdownEditorCommandOptions {
  /** Keep the current viewport when invoking an edit from external UI. */
  readonly preserveViewport?: boolean;
}

/**
 * Framework-neutral, ready-to-mount editor component. Lower-level session,
 * input and rendering objects remain public for hosts that need custom UI.
 */
export class MarkdownEditor {
  readonly session: EditorDocumentSession;
  readonly transactions: EditorTransactionCoordinator;
  readonly commands: EditorCommandRegistry;
  readonly input: CodeMirrorSource;
  readonly livePreview: LivePreviewController;
  readonly surface: EditorSurface;
  readonly events: EditorEventObserver;
  readonly headingFolds: HeadingFoldController;
  readonly inputPane: HTMLElement;
  readonly surfacePane: HTMLElement;
  readonly #root: HTMLElement;
  readonly #initialRootLimit: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #unsubscribeEvents: () => void;
  readonly #commandUI: ReturnType<typeof mountEditorCommandUI>;
  readonly #plugins: EditorPluginRegistry;
  readonly #commandActions = new Map<string, () => boolean>();
  #mode: MarkdownEditorMode;
  #surfaceMode: EditorSurfaceMode;
  #opened = false;
  #opening: Promise<void> | undefined;
  #disposed = false;
  #readOnly: boolean;
  readonly #onFontsLoaded = (): void => {
    if (!this.#disposed && this.#opened) void this.invalidateLayout().catch((error) => this.#onError?.(error));
  };
  #modeTail: Promise<void> = Promise.resolve();
  readonly #onRootKeyDown = (event: KeyboardEvent): void => {
    if (!this.inputPane.hidden || event.isComposing || !this.#opened) return;
    const mac = /Mac|iPhone|iPad/u.test(this.#root.ownerDocument.defaultView?.navigator.platform ?? "");
    const binding = this.commands.shortcutForEvent(event, mac);
    if (binding === undefined) return;
    event.preventDefault();
    void this.#executeVisibleCommand(binding.command).catch((error) => this.#onError?.(error));
  };

  constructor(options: MarkdownEditorOptions) {
    this.#initialRootLimit = (options.session.budgets ?? DEFAULT_EDITOR_BUDGETS).interactive.maxBlocks;
    if (options.theme !== undefined) validateEditorTheme(options.root, options.theme);
    this.#plugins = new EditorPluginRegistry(options.plugins);
    const initialLayout = options.theme?.layout;
    const initialMetrics = initialLayout?.metrics;
    const livePretext = options.livePreview?.pretext ?? options.surface?.pretext;
    this.#readOnly = options.input?.readOnly ?? false;
    this.#root = options.root;
    this.#mode = options.mode ?? "split";
    this.#surfaceMode = options.surfaceMode ?? modeSurface(this.#mode);
    this.#onError = options.onError ?? options.session.onError;
    this.commands = options.commands ?? createDefaultEditorCommandRegistry(
      options.root.ownerDocument.defaultView?.navigator.platform,
    );
    this.events = new EditorEventObserver({
      ...options.observability,
      ...(options.observability?.onError === undefined && this.#onError !== undefined
        ? { onError: this.#onError }
        : {}),
    });
    const onProtocolEvent = options.session.onProtocolEvent;
    this.session = new EditorDocumentSession({
      ...options.session,
      onProtocolEvent: (event) => {
        this.events.acceptProtocol(event);
        onProtocolEvent?.(event);
      },
      ...(this.#onError === undefined ? {} : { onError: this.#onError }),
    });
    options.root.addEventListener("jot-image-metadata", this.#onFontsLoaded);
    options.root.addEventListener("jot-math-rendered", this.#onFontsLoaded);
    options.root.ownerDocument.fonts?.addEventListener("loadingdone", this.#onFontsLoaded);
    void options.root.ownerDocument.fonts?.ready.then(this.#onFontsLoaded);
    if (options.installStyles !== false) {
      installMarkdownEditorStyles(options.root.ownerDocument);
    }
    options.root.classList.add("jot-markdown-editor");
    options.root.toggleAttribute("data-jot-editor-read-only", this.#readOnly);
    applyEditorThemeColors(options.root, options.theme?.colors);
    if (initialMetrics?.paragraphLineHeight !== undefined) {
      options.root.style.setProperty("--jot-paragraph-line-height", `${initialMetrics.paragraphLineHeight}px`);
    }
    if (!options.root.hasAttribute("tabindex")) options.root.tabIndex = -1;
    this.inputPane = options.root.ownerDocument.createElement("div");
    this.inputPane.className = "jot-markdown-editor__input";
    this.surfacePane = options.root.ownerDocument.createElement("div");
    this.surfacePane.className = "jot-markdown-editor__surface";
    options.root.replaceChildren(this.inputPane, this.surfacePane);

    this.#unsubscribeEvents = this.session.subscribe((effect) => {
      this.events.acceptEffect(effect);
    });
    this.transactions = new EditorTransactionCoordinator(this.session);
    this.headingFolds = new HeadingFoldController(this.session, this.#onError);
    const tableCommandExecutor: TableCommandExecutor = (command, offset) =>
      this.#executeTableCommand(command, offset);
    this.livePreview = new LivePreviewController({
      session: this.session,
      commands: this.commands,
      pluginRegistry: this.#plugins,
      headingFolds: this.headingFolds,
      ...options.livePreview,
      ...(options.livePreview?.renderMath !== undefined
        ? {}
        : options.surface?.renderMath === undefined
        ? {}
        : { renderMath: options.surface.renderMath }),
      ...(options.livePreview?.onLink !== undefined
        ? {}
        : options.surface?.onLink === undefined
        ? {}
        : { onLink: options.surface.onLink }),
      ...(options.livePreview?.resolveImageMetadata !== undefined
        ? {}
        : options.surface?.resolveImageMetadata === undefined
        ? {}
        : { resolveImageMetadata: options.surface.resolveImageMetadata }),
      ...(options.livePreview?.pretext !== undefined
        ? {}
        : options.surface?.pretext === undefined
        ? {}
        : { pretext: options.surface.pretext }),
      ...(initialMetrics === undefined ? {} : { pretext: {
        ...livePretext, metrics: { ...livePretext?.metrics, ...initialMetrics },
      } }),
      ...(options.livePreview?.scrollbar !== undefined
        ? {}
        : options.surface?.scrollbar === undefined
        ? {}
        : { scrollbar: options.surface.scrollbar }),
      ...(options.livePreview?.table !== undefined
        ? {}
        : options.surface?.table === undefined
        ? {}
        : { table: options.surface.table }),
      ...(options.livePreview?.onTableCommand !== undefined
        ? {}
        : {
          onTableCommand: tableCommandExecutor,
        }),
      ...(options.livePreview?.onError !== undefined || this.#onError === undefined
        ? {}
        : { onError: this.#onError }),
    });
    const onInputTransaction = options.input?.onInputTransaction;
    const inputExtensions = [
      ...(options.input?.extensions ?? []),
      this.headingFolds.extension,
      this.livePreview.extension,
    ];
    this.input = new CodeMirrorSource({
      root: this.inputPane,
      session: this.session,
      transactions: this.transactions,
      commands: this.commands,
      ...options.input,
      extensions: inputExtensions,
      onInputTransaction: (event) => {
        this.events.acceptInput(event);
        onInputTransaction?.(event);
      },
      readOnly: true,
      onCommandAction: (action) => this.#commandAction(action) || options.input?.onCommandAction?.(action) === true,
      ...(this.#onError === undefined ? {} : { onError: this.#onError }),
    });
    if (initialLayout !== undefined) {
      applyEditorTypography(this.input.view.contentDOM, initialLayout);
      applyEditorTypography(this.surfacePane, initialLayout);
    }
    this.livePreview.attach(this.input.view);
    this.headingFolds.attach(this.input.view);
    const onSurfaceCommit = options.surface?.onCommit;
    this.surface = new EditorSurface({
      root: this.surfacePane,
      session: this.session,
      pluginRegistry: this.#plugins,
      headingFolds: this.headingFolds,
      ...options.surface,
      ...(initialMetrics === undefined ? {} : { pretext: {
        ...options.surface?.pretext,
        metrics: { ...options.surface?.pretext?.metrics, ...initialMetrics },
      } }),
      mode: this.#surfaceMode,
      active: surfaceVisible(this.#mode),
      ...(options.installStyles === false && options.surface?.installStyles === undefined
        ? { installStyles: false }
        : {}),
      ...(options.surface?.onTableCommand !== undefined
        ? {}
        : { onTableCommand: tableCommandExecutor }),
      ...(options.surface?.onTableCellFocus !== undefined
        ? {}
        : { onTableCellFocus: (offset) => this.#focusSourceAt(offset) }),
      ...(options.surface?.resolveSelectionAnchor !== undefined
        ? {}
        : {
          resolveSelectionAnchor: (fallback: number, tableRange: TextRange) => {
            const selection = this.input.view.state.selection.main;
            const from = Number(tableRange.from);
            const to = Number(tableRange.to);
            return selection.empty && selection.head >= from && selection.head <= to
              ? selection.head
              : fallback;
          },
        }),
      onCommit: (event) => {
        this.events.acceptSurfaceCommit(event);
        onSurfaceCommit?.(event);
      },
      ...(this.#onError === undefined ? {} : { onError: this.#onError }),
    });
    this.#applyVisibility();
    this.livePreview.setEnabled(this.#mode === "live-preview");
    this.#commandUI = mountEditorCommandUI(this.#root, {
      commands: this.commands,
      execute: (id) => this.#executeVisibleCommand(id),
      focusEditor: () => this.focus(),
      ...(options.openShortcutSettings === undefined ? {} : { openShortcutSettings: options.openShortcutSettings }),
    });
    this.#root.addEventListener("keydown", this.#onRootKeyDown);
    try { this.#plugins.activate(this); } catch (error) { this.dispose(); throw error; }
  }

  get mode(): MarkdownEditorMode {
    return this.#mode;
  }

  get surfaceMode(): EditorSurfaceMode {
    return this.#surfaceMode;
  }

  get canEdit(): boolean {
    return this.#opened && !this.#disposed && !this.inputPane.hidden && !this.input.view.state.readOnly;
  }

  /** 当前乐观的 CodeMirror 值。 */
  get value(): string {
    return this.input.value;
  }

  /** Rust 引擎最近一次确认的值。 */
  get confirmedValue(): string {
    return this.session.adapter.text.text;
  }

  get revision(): Revision {
    return this.session.adapter.revision;
  }

  async open(): Promise<void> {
    this.#assertLive();
    if (this.#opened) return;
    if (this.#opening !== undefined) return this.#opening;
    const opening = (async () => {
      await this.surface.open();
      // Source mode has no rendering host to request the initial parsed roots.
      // Subsequent analysis updates already deliver the newly parsed block metadata.
      if (this.#mode === "source") await this.session.projectRoot(0, this.#initialRootLimit);
      this.#opened = true;
      this.input.setReadOnly(this.#readOnly);
      this.livePreview.open();
      this.#root.setAttribute("data-jot-editor-ready", "");
    })();
    this.#opening = opening;
    try {
      await opening;
    } finally {
      this.#opening = undefined;
    }
  }

  setMode(mode: MarkdownEditorMode): Promise<void> {
    this.#assertLive();
    const task = this.#modeTail.then(async () => {
      if (this.#disposed || mode === this.#mode) return;
      this.#mode = mode;
      if (mode === "pretext" || mode === "preview") this.#surfaceMode = mode;
      this.#applyVisibility();
      this.livePreview.setEnabled(mode === "live-preview");
      const showSurface = surfaceVisible(mode);
      if (!showSurface) await this.surface.setActive(false);
      await this.surface.setMode(this.#surfaceMode);
      if (showSurface) await this.surface.setActive(true);
      if (this.#opened && showSurface) await this.surface.refresh();
    });
    this.#modeTail = task.catch((error) => {
      this.#onError?.(error);
    });
    return task;
  }

  setSurfaceMode(mode: EditorSurfaceMode): Promise<void> {
    this.#assertLive();
    const task = this.#modeTail.then(async () => {
      if (this.#disposed || mode === this.#surfaceMode) return;
      this.#surfaceMode = mode;
      if (this.#mode === "pretext" || this.#mode === "preview") this.#mode = mode;
      this.#applyVisibility();
      await this.surface.setMode(mode);
      if (this.#opened && !this.surfacePane.hidden) await this.surface.refresh();
    });
    this.#modeTail = task.catch((error) => {
      this.#onError?.(error);
    });
    return task;
  }

  setValue(source: string): void {
    this.#assertOpened();
    this.input.setValue(source);
  }

  setReadOnly(readOnly: boolean): void {
    this.#assertLive();
    this.#readOnly = readOnly;
    this.input.setReadOnly(!this.#opened || readOnly);
    this.#root.toggleAttribute("data-jot-editor-read-only", readOnly);
  }

  isPluginEnabled(id: string): boolean {
    this.#assertLive();
    return this.#plugins.isEnabled(id);
  }

  /** Enable or disable a registered plugin without changing the document. */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    this.#assertLive();
    if (this.#plugins.setEnabled(this, id, enabled, this.#onError) && this.#opened) {
      await this.invalidateLayout();
    }
  }

  /** 同步两种宿主的排版配置并清理离屏估算。已挂载的输入和预览外壳保留。 */
  async setLayoutStyle(style: EditorLayoutStyle): Promise<void> {
    validateEditorLayoutStyle(style);
    this.#assertLive();
    // Source 和 Live Preview 共用输入宿主。根节点也保存行高，切回 Source 时仍采用显式设置。
    if (style.metrics?.paragraphLineHeight !== undefined) {
      this.#root.style.setProperty("--jot-paragraph-line-height", `${style.metrics.paragraphLineHeight}px`);
    }
    await Promise.all([this.surface.invalidateLayout(style), this.livePreview.invalidateLayout(style)]);
  }

  /** 局部更新主题。整组颜色和尺寸校验成功后才写入，未提供的字段沿用当前配置。 */
  async setTheme(theme: EditorTheme): Promise<void> {
    this.#assertLive();
    validateEditorTheme(this.#root, theme);
    applyEditorThemeColors(this.#root, theme.colors);
    if (theme.layout !== undefined) await this.setLayoutStyle(theme.layout);
    else await this.invalidateLayout();
  }

  /** 字体加载或外部布局变化后，让两个宿主重新测量。固定行高和间距从 setLayoutStyle 设置。 */
  async invalidateLayout(): Promise<void> {
    this.#assertLive();
    await Promise.all([this.surface.invalidateLayout(), this.livePreview.invalidateLayout()]);
  }

  transact(builder: TransactionBuilder): Promise<AdapterEffect> {
    this.#assertLive();
    this.#assertOpened();
    return this.transactions.enqueue(builder);
  }

  /** 执行统一注册的命令；当前选区不满足命令前置条件时返回 false。 */
  executeCommand(id: string, anchor?: number, options: MarkdownEditorCommandOptions = {}): boolean {
    this.#assertOpened();
    return this.input.executeCommand(
      id,
      anchor === undefined ? undefined : selection(anchor),
      options,
    );
  }

  openCommandPalette(): void { this.#assertOpened(); this.#commandUI.open(); }

  /** Insert a Markdown table at the current selection using the registered command. */
  insertTable(size: TableInsertionSize, options: MarkdownEditorCommandOptions = {}): boolean {
    this.#assertOpened();
    return this.input.executeCommand("insert.table", undefined, { ...options, tableSize: size });
  }

  /** Route a registered command's host action to the UI that owns it. */
  registerCommandAction(action: string, handler: () => boolean): () => void {
    this.#assertLive();
    if (this.#commandActions.has(action)) throw new Error(`duplicate editor command action: ${action}`);
    this.#commandActions.set(action, handler);
    return () => {
      if (this.#commandActions.get(action) === handler) this.#commandActions.delete(action);
    };
  }

  async openSearch(options: { readonly replace?: boolean } = {}): Promise<boolean> {
    this.#assertOpened();
    if (this.inputPane.hidden) await this.setMode("live-preview");
    return this.input.openSearch(options);
  }

  get searchQuery(): EditorSearchQuery { return this.input.searchQuery; }
  setSearchQuery(query: EditorSearchQuery): void { this.#assertOpened(); this.input.setSearchQuery(query); }
  findNext(): boolean { this.#assertOpened(); return this.input.findNext(); }
  findPrevious(): boolean { this.#assertOpened(); return this.input.findPrevious(); }
  replaceNext(): boolean { this.#assertOpened(); return this.input.replaceNext(); }
  replaceAll(): boolean { this.#assertOpened(); return this.input.replaceAll(); }

  /** 当行有效时，在 UTF-16 源码偏移处替换一个表格 cell。 */
  replaceTableCell(offset: number, value: string): boolean {
    this.#assertOpened();
    const source = this.value;
    const block = this.session.adapter.confirmedBlockAt(source, offset);
    if (block?.kind !== "table") return false;
    const edit = createTableCellEdit(source, offset, value, block.sourceRange);
    if (edit === undefined) return false;
    this.input.replaceRange(
      Number(edit.range.from),
      Number(edit.range.to),
      edit.insert,
      "api",
    );
    return true;
  }

  tableLayout(tableId: string): TableLayoutSnapshot | undefined {
    this.#assertLive();
    return this.#mode === "live-preview"
      ? this.livePreview.tableLayout(tableId) : this.surface.tableLayout(tableId);
  }

  setTableColumnWidth(tableId: string, column: number, width: number): boolean {
    this.#assertLive();
    const surface = this.surface.setTableColumnWidth(tableId, column, width);
    const live = this.livePreview.setTableColumnWidth(tableId, column, width);
    return surface || live;
  }

  resetTableLayout(tableId: string): boolean {
    this.#assertLive();
    const surface = this.surface.resetTableLayout(tableId);
    const live = this.livePreview.resetTableLayout(tableId);
    return surface || live;
  }

  /** 按编辑器 Surface 的虚拟滚动轴设置绝对偏移。 */
  scrollToOffset(offset: number): void {
    this.#assertLive();
    this.surface.scrollToOffset(offset);
  }

  /** 将编辑器 Surface 定位到末尾，并在动态测量完成后保持末尾锚定。 */
  scrollToEnd(): void {
    this.#assertLive();
    this.surface.scrollToEnd();
  }

  subscribe(listener: (effect: AdapterEffect) => void): () => void {
    this.#assertLive();
    return this.session.subscribe(listener);
  }

  async settled(): Promise<void> {
    await this.input.settled();
    await this.#modeTail;
    await this.livePreview.settled();
    await this.surface.settled();
  }

  focus(): void {
    this.#assertOpened();
    if (this.inputPane.hidden) this.#root.focus();
    else this.input.focus();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#plugins.dispose(this.#onError);
    this.#commandActions.clear();
    this.#root.ownerDocument.fonts?.removeEventListener("loadingdone", this.#onFontsLoaded);
    this.#root.removeEventListener("jot-image-metadata", this.#onFontsLoaded);
    this.#root.removeEventListener("jot-math-rendered", this.#onFontsLoaded);
    this.#root.removeEventListener("keydown", this.#onRootKeyDown);
    this.#commandUI.dispose();
    this.headingFolds.dispose();
    this.livePreview.dispose();
    this.input.dispose();
    this.surface.dispose();
    this.#unsubscribeEvents();
    this.events.dispose();
    this.transactions.dispose();
    this.session.dispose();
    this.#root.replaceChildren();
    this.#root.classList.remove("jot-markdown-editor");
    delete this.#root.dataset["jotEditorMode"];
    delete this.#root.dataset["jotEditorReady"];
    delete this.#root.dataset["jotEditorReadOnly"];
    delete this.#root.dataset["jotSurfaceMode"];
  }

  #applyVisibility(): void {
    this.#root.dataset["jotEditorMode"] = this.#mode;
    this.#root.dataset["jotSurfaceMode"] = this.#surfaceMode;
    this.inputPane.hidden = this.#mode === "pretext" || this.#mode === "preview";
    this.surfacePane.hidden = !surfaceVisible(this.#mode);
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("Markdown editor disposed");
  }

  #commandAction(action: string): boolean {
    const handler = this.#commandActions.get(action);
    if (handler !== undefined) return handler();
    if (action === "heading-fold.toggle") {
      const active = this.#root.ownerDocument.activeElement;
      const id = active?.closest<HTMLElement>("[data-jot-fold-id]")?.dataset["jotFoldId"];
      void (id === undefined ? this.headingFolds.toggleAt(this.input.view.state.selection.main.head) : this.headingFolds.toggle(id))
        .catch((error) => this.#onError?.(error));
      return true;
    }
    if (action === "heading-fold.unfold-all") { this.headingFolds.unfoldAll(); return true; }
    if (action === "command.palette") { this.#commandUI.open(); return true; }
    if (action === "shortcut.settings") { this.#commandUI.openSettings(); return true; }
    if (action === "editor.exit-block" || action === "editor.insert-before") {
      return this.livePreview.exitBlock(action === "editor.insert-before" ? "before" : "after");
    }
    if (action === "mode.source" || action === "mode.live-preview" || action === "mode.preview") {
      const mode = action.slice(5) as MarkdownEditorMode;
      void this.setMode(mode).then(() => this.focus()).catch((error) => this.#onError?.(error));
      return true;
    }
    return false;
  }

  /** All component UI entry points obey the same command surface contract. */
  async #executeVisibleCommand(id: string): Promise<boolean> {
    const command = this.commands.command(id);
    if (command === undefined) return false;
    if (command.requiresInput !== false && this.inputPane.hidden) {
      await this.setMode("live-preview");
      if (this.#disposed) return false;
      this.focus();
    }
    return this.executeCommand(id);
  }

  #assertOpened(): void {
    this.#assertLive();
    if (!this.#opened) throw new Error("call MarkdownEditor.open() before editing");
  }

  #executeTableCommand(command: import("../components/table/commands.js").TableCommandId, offset: number): boolean {
    this.#assertOpened();
    return this.input.executeCommand(
      command,
      selection(offset),
    );
  }

  #focusSourceAt(offset: number): void {
    this.#assertOpened();
    this.input.setSelection(safeUtf16Offset(this.input.value, offset));
    this.input.focus();
  }
}

function selection(offset: number): EditorSelection {
  return {
    anchor: offset as EditorSelection["anchor"],
    head: offset as EditorSelection["head"],
  };
}

function modeSurface(mode: MarkdownEditorMode): EditorSurfaceMode {
  return mode === "pretext" ? "pretext" : "preview";
}

function surfaceVisible(mode: MarkdownEditorMode): boolean {
  return mode !== "source" && mode !== "live-preview";
}
