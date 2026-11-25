import { editorI18nAt } from "../../core/i18n.js";
import { ImageInput } from "./image-input.js";
import { sourceSnapshot } from "../shared/source-snapshot.js";
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { ParseContext } from "@codemirror/language";
import {
  Annotation,
  ChangeSet,
  Compartment,
  EditorSelection as CodeMirrorSelection,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";

import type {
  DocumentId,
  EditorSelection,
  HistoryIntent,
  TextEdit,
  TransactionOrigin,
  Utf16Offset,
} from "@jot-md/editor-protocol";
import {
  range,
  singleTextEdit,
  type EditorDocumentSession,
  type EditorTransactionCoordinator,
} from "../../adapter/index.js";
import { createDefaultEditorCommandRegistry } from "../../components/commands.js";
import { EditorCommandRegistry, type EditorCommandExecution, type EditorCommandResult, type EditorImage, type SaveEditorImage, type TableInsertionSize } from "../../core/commands/index.js";
import { completeCodeFence, markdownEditingKeymap } from "./markdown-keymap.js";
import { engineSynchronization, requestedOrigin, sourceReadOnlyFilter,
  synchronizedFromEngine } from "./synchronization.js";
import {
  closeSearchPanel,
  executeSourceAction,
  findNext,
  findPrevious,
  getSourceSearchQuery,
  openSourceSearch,
  replaceAll,
  replaceNext,
  sourceSearch,
  updateSourceSearch,
  type EditorSearchQuery,
} from "./search.js";

const requestedUserEvent = Annotation.define<string>();
// This is only a path-selection threshold. It never truncates input: large
// non-composition text skips the browser's expensive contenteditable mutation
// and is applied through CodeMirror's ordinary transaction instead.
const LARGE_NATIVE_INSERT_UNITS = 16_384;
// Lezer fragments are reuse hints, not the editor's authoritative syntax.
// Keep a bounded selection when repeated edits leave many overlapping old
// parse trees alive. The parser already in progress keeps its original hints;
// only subsequent parses use the smaller cache.
const MAX_MARKDOWN_REUSE_FRAGMENTS = 8;

declare const historySnapshotBrand: unique symbol;

/** In-memory undo and redo history for a single document. */
export interface EditorHistorySnapshot {
  readonly [historySnapshotBrand]: never;
}

const capturedHistories = new WeakMap<EditorHistorySnapshot, {
  readonly documentId: DocumentId;
  readonly source: string;
  readonly history: unknown;
}>();
const historyInitializer = new Compartment();

export interface CodeMirrorSourceOptions {
  readonly root: HTMLElement;
  readonly session: EditorDocumentSession;
  readonly transactions: EditorTransactionCoordinator;
  readonly saveImage?: SaveEditorImage;
  readonly extensions?: readonly Extension[];
  readonly lineWrapping?: boolean;
  /** Complete a standalone opening code fence on Enter. Defaults to true. */
  readonly autoCloseCodeFences?: boolean;
  readonly readOnly?: boolean;
  readonly history?: EditorHistorySnapshot | undefined;
  /** 未传入时使用 MarkdownEditor 的内置表格命令与快捷键。 */
  readonly commands?: EditorCommandRegistry;
  /** Host actions share the same command registry as source edit commands. */
  readonly canHandleAction?: (action: string) => boolean;
  readonly onCommandExecuted?: (event: EditorCommandExecution) => void;
  readonly onCommandAction?: (action: string) => boolean;
  /** 已接受的本地 CodeMirror 修改，此时 Rust 还未确认。 */
  readonly onInputTransaction?: (event: CodeMirrorInputTransaction) => void;
  readonly onError?: (error: unknown) => void;
}

export interface CodeMirrorInputTransaction {
  readonly version: number;
  readonly origin: TransactionOrigin;
  readonly userEvent: string;
  readonly compositionId?: string;
  readonly edits: readonly TextEdit[];
  readonly selectionBefore: EditorSelection;
  readonly selectionAfter: EditorSelection;
}

export interface EditorCommandExecutionOptions {
  /** 命令没有显式返回目标选区时保留原选区；显式结果选区始终优先。 */
  readonly preserveSelection?: boolean;
  readonly tableSize?: TableInsertionSize;
  readonly taskMarkerFrom?: number;
  readonly images?: readonly EditorImage[];
  readonly imageSource?: "api" | "paste" | "picker";
  /** Map the live selection when an asynchronous action finishes away from it. */
  readonly retainCurrentSelection?: boolean;
  readonly preserveViewport?: boolean;
}

interface DesiredInputState {
  readonly source: string;
  readonly selectionBefore: EditorSelection;
  readonly selectionAfter: EditorSelection;
  readonly visibleRanges: readonly ReturnType<typeof range>[];
  readonly origin: TransactionOrigin;
  readonly history: HistoryIntent;
  readonly userEvent: string;
  readonly compositionId?: string;
  readonly version: number;
}

/**
 * CodeMirror 持有浏览器输入、IME、选区和本地历史。Rust 仍是 confirmed text/Markdown
 * 的权威；这个桥接层把 CodeMirror 的乐观状态串行化为精确 revision 事务。
 */
export class CodeMirrorSource {
  readonly view: EditorView;
  readonly #options: Omit<CodeMirrorSourceOptions, "history">;
  readonly #commands: EditorCommandRegistry;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeCommands: () => void;
  readonly #unsubscribeLocale: () => void;
  readonly #editable = new Compartment();
  readonly #imageInput?: ImageInput;
  readonly #commandBindings = new Compartment();
  #desired: DesiredInputState;
  #syncing: Promise<void> | undefined;
  #disposed = false;
  #version = 0;
  #compositionSequence = 0;
  #compositionId: string | undefined;
  #compositionActive = false;
  #compositionCommitPending = false;
  #compositionCommitTimer: ReturnType<typeof setTimeout> | undefined;
  #quoteRequest: { key: string; done: Promise<void> } | undefined;
  #pendingBase: string;
  #pendingChanges: ChangeSet;

  constructor({ history: historySnapshot, ...options }: CodeMirrorSourceOptions) {
    this.#options = options;
    const i18n = editorI18nAt(options.root);
    this.#commands = options.commands ?? createDefaultEditorCommandRegistry();
    if (options.saveImage) {
      this.#imageInput = new ImageInput(options.saveImage, (entry, images) => {
        const live = this.view.state.selection;
        return this.executeCommand("insert.image", protocolSelection(entry.from, entry.to), {
          images, imageSource: entry.source,
          retainCurrentSelection: live.ranges.length !== 1 || live.main.from !== entry.from || live.main.to !== entry.to,
          preserveViewport: true,
        });
      }, () => this.#compositionActive || this.#compositionCommitPending, options.onError ?? (error => console.error(error)));
    }
    const source = options.session.adapter.text.text;
    this.#pendingBase = source;
    this.#pendingChanges = ChangeSet.empty(source.length);
    const initialSelection = protocolSelection(0, 0);
    this.#desired = {
      source,
      selectionBefore: initialSelection,
      selectionAfter: initialSelection,
      visibleRanges: [range(0, source.length)],
      origin: "system",
      history: { type: "ignore" },
      userEvent: "input.initialize",
      version: 0,
    };
    const extensions: Extension[] = [
      history(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      sourceReadOnlyFilter,
      EditorState.phrases.of(i18n.phrases),
      sourceSearch(),
      this.#commandBindings.of(keymap.of(this.#commandKeymap())),
      keymap.of([
        { key: "Enter", run: view => options.autoCloseCodeFences !== false &&
          !this.#compositionActive && !this.#compositionCommitPending && completeCodeFence(view, options.session.adapter) },
        ...markdownEditingKeymap,
        indentWithTab,
        ...defaultKeymap,
        // Document undo/redo belong to the configurable command registry.
        // Keep only CodeMirror's separate selection-history commands here.
        ...historyKeymap.filter((binding) =>
          (binding.run !== undo || this.#commands.command("history.undo") === undefined) &&
          (binding.run !== redo || this.#commands.command("history.redo") === undefined)),
      ]),
      markdown({
        addKeymap: false,
        extensions: {
          wrap: (parse, _input, fragments) => {
            const context = ParseContext.get();
            if (context?.fragments === fragments && fragments.length > MAX_MARKDOWN_REUSE_FRAGMENTS) {
              const step = (fragments.length - 1) / (MAX_MARKDOWN_REUSE_FRAGMENTS - 1);
              context.fragments = Array.from({ length: MAX_MARKDOWN_REUSE_FRAGMENTS },
                (_, index) => fragments[Math.floor(index * step)]!);
            }
            return parse;
          },
        },
      }),
      this.#editable.of([
        EditorState.readOnly.of(options.readOnly ?? false),
        EditorView.editable.of(!(options.readOnly ?? false)),
      ]),
      EditorView.domEventHandlers({
        paste: event => this.pasteImages(event),
        beforeinput: (event, view) => {
          const input = event as InputEvent;
          if (this.#disposed || view.state.readOnly || this.#compositionActive ||
              this.#compositionCommitPending || view.composing || input.isComposing ||
              !input.isTrusted || !input.cancelable || input.inputType !== "insertText" ||
              input.data === null || input.data.length < LARGE_NATIVE_INSERT_UNITS) return false;
          // CM documents unreliable preventDefault on Chrome Android. Keep
          // that platform on its native path until a real-device test can
          // establish that interception cannot duplicate text.
          if (/Android/i.test(view.dom.ownerDocument.defaultView?.navigator.userAgent ?? "")) return false;
          input.preventDefault();
          view.dispatch({
            ...view.state.replaceSelection(input.data),
            userEvent: "input.type",
            scrollIntoView: true,
          });
          return true;
        },
        compositionstart: () => {
          this.#beginComposition();
          return false;
        },
        compositionend: () => {
          this.#finishComposition();
          if (this.#imageInput) setTimeout(() => this.#imageInput?.drain(this.view), 0);
          return false;
        },
      }),
      EditorView.updateListener.of(update => {
        this.#imageInput?.update(update);
        this.#accept(update);
        if (update.selectionSet || update.startState.readOnly !== update.state.readOnly) this.#loadSelectedQuoteRow(update.view);
      }),
      ...(options.lineWrapping === false ? [] : [EditorView.lineWrapping]),
      ...(options.extensions ?? []),
    ];
    const snapshot = historySnapshot && capturedHistories.get(historySnapshot);
    const restoreHistory = snapshot?.documentId === options.session.adapter.documentId && snapshot.source === source;
    if (restoreHistory) {
      extensions.unshift(historyInitializer.of(historyField.init(() => snapshot.history)));
    }
    let state = EditorState.create({ doc: source, extensions });
    if (restoreHistory) {
      // Keep the restored field value without retaining the initializer and its snapshot.
      state = state.update({
        effects: historyInitializer.reconfigure([]),
        annotations: isolateHistory.of("full"),
      }).state;
    }
    this.view = new EditorView({ parent: options.root, state });
    this.#unsubscribe = options.session.subscribe((effect) => {
      // Analysis and projection effects never change confirmed source. A
      // full CM Text flatten/compare for each background slice turns opening
      // a large document into repeated O(document-size) main-thread work.
      if (this.#disposed) return;
      if (effect.documentPatch !== undefined && this.#syncing === undefined) {
        this.#replaceFromEngine(options.session.adapter.text.text, effect.appliedEdits);
      }
      if (effect.documentPatch || effect.analysisUpdate) this.#loadSelectedQuoteRow(this.view);
    });
    this.#unsubscribeLocale = i18n.subscribe(() => {
      // CodeMirror creates the native go-to-line labels once per open dialog.
      const panel = this.view.dom.querySelector(".cm-goto-line");
      if (panel) {
        const caption = panel.querySelector("label")?.firstChild;
        if (caption?.nodeType === 3) caption.textContent = i18n.t("Go to line") + ": ";
        const submit = panel.querySelector("button[type=submit]");
        if (submit) submit.textContent = i18n.t("go");
        panel.querySelector(".cm-dialog-close")?.setAttribute("aria-label", i18n.t("close"));
      }
    });
    this.#unsubscribeCommands = this.#commands.subscribe(() => {
      if (!this.#disposed) this.view.dispatch({
        effects: this.#commandBindings.reconfigure(keymap.of(this.#commandKeymap())),
      });
    });
  }

  get value(): string {
    return sourceSnapshot(this.view);
  }

  /** Capture the undo and redo stacks against the current source text. */
  captureHistory(): EditorHistorySnapshot | undefined {
    this.#assertLive();
    const { state } = this.view;
    if (undoDepth(state) === 0 && redoDepth(state) === 0) return undefined;
    const snapshot = Object.freeze({}) as EditorHistorySnapshot;
    capturedHistories.set(snapshot, {
      documentId: this.#options.session.adapter.documentId,
      source: this.value,
      history: state.field(historyField),
    });
    return snapshot;
  }

  get canPickImageFiles(): boolean { return this.#imageInput !== undefined; }

  /** Use the same image handler for mapped input surfaces with their own clipboard target. */
  pasteImages(event: ClipboardEvent): boolean {
    return !this.#disposed && !this.#compositionActive && !this.#compositionCommitPending &&
      (this.#imageInput?.paste(event, this.view) ?? false);
  }

  get commands(): EditorCommandRegistry {
    return this.#commands;
  }

  get searchQuery(): EditorSearchQuery {
    return getSourceSearchQuery(this.view);
  }

  openSearch(options: { readonly replace?: boolean } = {}): boolean {
    this.#assertLive();
    return openSourceSearch(this.view, options.replace);
  }

  closeSearch(): boolean {
    this.#assertLive();
    return closeSearchPanel(this.view);
  }

  setSearchQuery(query: EditorSearchQuery): void {
    this.#assertLive();
    updateSourceSearch(this.view, query);
  }

  findNext(): boolean {
    this.#assertLive();
    return findNext(this.view);
  }

  findPrevious(): boolean {
    this.#assertLive();
    return findPrevious(this.view);
  }

  replaceNext(): boolean {
    this.#assertLive();
    return replaceNext(this.view);
  }

  replaceAll(): boolean {
    this.#assertLive();
    return replaceAll(this.view);
  }

  focus(): void {
    this.#assertLive();
    this.view.focus();
  }

  setReadOnly(readOnly: boolean): void {
    this.#assertLive();
    this.view.dispatch({
      effects: this.#editable.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }

  setValue(source: string): void {
    this.#assertLive();
    // Replacing a document with the same text is not an edit. Besides
    // needlessly creating a Rust revision, a full replacement invalidates
    // mounted previews and loses their stable geometry and selection.
    if (source === sourceSnapshot(this.view) ||
        (source.includes("\r") && this.view.state.toText(source).eq(this.view.state.doc))) return;
    this.#imageInput?.cancel();
    this.replaceRange(0, this.view.state.doc.length, source, "api");
  }

  replaceRange(
    from: number,
    to: number,
    insert: string,
    origin: TransactionOrigin = "api",
    userEvent = "input.api",
  ): void {
    this.#assertLive();
    if (from < 0 || to < from || to > this.view.state.doc.length) {
      throw new RangeError(`invalid CodeMirror range ${from}..${to}`);
    }
    this.view.dispatch({
      changes: { from, to, insert },
      annotations: [
        requestedOrigin.of(origin),
        requestedUserEvent.of(userEvent),
        Transaction.userEvent.of(userEvent),
      ],
    });
  }

  /** 执行注册表中的纯命令；不适用时返回 false 并保留后续默认快捷键。 */
  executeCommand(
    id: string,
    selectionOverride?: EditorSelection,
    options: EditorCommandExecutionOptions = {},
  ): boolean {
    const prepared = this.#prepareCommand(id, selectionOverride, options);
    if (!prepared) return false;
    const { result, selection } = prepared;
    let handled: boolean;
    if (result.action === undefined) {
      handled = this.#applyEdits(id, result, selection, selectionOverride, options);
    } else if (result.action === "image.choose-file") {
      handled = this.#imageInput?.pick(this.view, selection) ?? false;
    } else {
      handled = executeSourceAction(this.view, result.action) ?? this.#options.onCommandAction?.(result.action) ?? false;
    }
    if (handled) this.#options.onCommandExecuted?.({ id, userEvent: result.userEvent });
    return handled;
  }

  /** Test the current context without dispatching a transaction or opening host UI. */
  canExecuteCommand(id: string, selectionOverride?: EditorSelection): boolean {
    const prepared = this.#prepareCommand(id, selectionOverride, {});
    if (!prepared) return false;
    const { action, edits } = prepared.result;
    const view = this.view;
    if (action === undefined) return !view.state.readOnly || !edits?.length;
    switch (action) {
      case "image.choose-file": return !!this.#imageInput && !view.state.readOnly;
      case "history.undo": return !view.state.readOnly && undoDepth(view.state) > 0;
      case "history.redo": return !view.state.readOnly && redoDepth(view.state) > 0;
      case "search.replace-next": case "search.replace-all":
        return !view.state.readOnly && getSourceSearchQuery(view).valid;
      case "search.next": case "search.previous": {
        const query = getSourceSearchQuery(view);
        return query.search.length === 0 || query.valid;
      }
      case "search.open": case "search.replace": case "document.goto-line": case "selection.next-occurrence": return true;
      default: return this.#options.canHandleAction?.(action) ?? this.#options.onCommandAction !== undefined;
    }
  }

  #prepareCommand(id: string, selectionOverride: EditorSelection | undefined, options: EditorCommandExecutionOptions) {
    this.#assertLive();
    const selection = selectionOverride ?? protocolSelection(
      this.view.state.selection.main.anchor,
      this.view.state.selection.main.head,
    );
    const view = this.view;
    const adapter = this.#options.session.adapter;
    if (selectionOverride && [selection.anchor, selection.head].some(offset =>
      !Number.isSafeInteger(offset) || offset < 0 || offset > view.state.doc.length)) return undefined;
    if ((id === "task.toggle-checked" || id === "list.renumber" || id === "format.task-list" || id === "insert.image") &&
        (view.composing || this.#compositionActive || this.#compositionCommitPending || view.state.readOnly)) return undefined;
    const result = this.#commands.execute(id, {
      // Host-only actions such as Find Next never need a flattened document.
      // Semantic edit commands still receive the same source string on demand.
      get source() { return sourceSnapshot(view); },
      phrase: message => view.state.phrase(message),
      get block() { return adapter.confirmedBlockAt(sourceSnapshot(view), Number(selection.head)); },
      blockAt(offset) {
        const root = adapter.confirmedBlockAt(sourceSnapshot(view), offset);
        if (root?.kind !== "block-quote") return root;
        const row = view.state.doc.lineAt(offset).number - view.state.doc.lineAt(root.sourceRange.from).number;
        const node = adapter.projection.nodeAt(root.id, "quote-lines", row);
        if (node?.content.type !== "structured") return root;
        return node.content.children[0] ?? node;
      },
      ...(options.taskMarkerFrom === undefined ? {} : { taskMarkerFrom: options.taskMarkerFrom }),
      selection,
      canPickImage: this.#imageInput !== undefined,
      ...(options.images === undefined ? {} : { images: options.images }),
      ...(options.imageSource === undefined ? {} : { imageSource: options.imageSource }),
      ...(options.tableSize === undefined ? {} : { tableSize: options.tableSize }),
      // 工具栏传入显式 anchor 表示用户已经选择了唯一命令目标；普通快捷键
      // 则必须保留 CodeMirror 的多选数量，交给命令前置条件判断。
      selectionCount: selectionOverride === undefined
        ? this.view.state.selection.ranges.length
        : 1,
    });
    return result === undefined ? undefined : { selection, result };
  }

  // Live Preview loads visible quote rows itself. Source and split views need
  // just the active row to distinguish a quoted list from code with list-like text.
  #loadSelectedQuoteRow(view: EditorView): void {
    if (view.state.readOnly || view.contentDOM.classList.contains("jot-live-preview-content")) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (!/^ {0,3}>/u.test(view.state.doc.sliceString(line.from, Math.min(line.from + 4, line.to)))) return;
    const { session } = this.#options;
    const root = session.adapter.confirmedBlockAt(sourceSnapshot(view), line.from);
    if (root?.kind !== "block-quote") return;
    const row = line.number - view.state.doc.lineAt(root.sourceRange.from).number;
    if (session.adapter.projection.nodeAt(root.id, "quote-lines", row)) return;
    const key = `${session.adapter.revision}:${root.id}:${row}`;
    if (this.#quoteRequest?.key === key) return;
    const done = session.project([{ parentId: root.id, axis: "quote-lines",
      window: { type: "index", from: row, toExclusive: row + 1 }, maxDepth: 0 }])
      .then(() => {}, error => { if (!this.#disposed) this.#options.onError?.(error); });
    this.#quoteRequest = { key, done };
  }

  #applyEdits(id: string, result: EditorCommandResult, selection: EditorSelection,
    selectionOverride: EditorSelection | undefined, options: EditorCommandExecutionOptions): boolean {
    const view = this.view;
    const edits = result.edits ?? [];
    if (this.view.state.readOnly && edits.length > 0) return false;
    if (edits.length === 0 && result.selection === undefined && selectionOverride === undefined) return true;
    if (selectionOverride === undefined && edits.length === 0 && result.userEvent !== "select.format.link" &&
        result.selection?.anchor === selection.anchor && result.selection.head === selection.head) return true;
    assertCommandEdits(edits, this.view.state.doc.length);
    const transaction = view.state.update({
      ...(edits.length === 0
        ? {}
        : {
            changes: edits.map((edit) => ({
              from: Number(edit.range.from),
              to: Number(edit.range.to),
              insert: edit.insert,
            })),
          }),
      ...(options.retainCurrentSelection === true || result.selection === undefined &&
        (selectionOverride === undefined || options.preserveSelection === true)
        ? {}
        : {
            selection: CodeMirrorSelection.range(
              Number(result.selection?.anchor ?? selection.anchor),
              Number(result.selection?.head ?? selection.head),
            ),
          }),
      scrollIntoView: options.preserveViewport !== true,
      annotations: [
        ...(["insert.image", "task.toggle-checked", "list.renumber"].includes(id) && edits.length ? [isolateHistory.of("full")] : []),
        requestedOrigin.of(result.origin ?? "keyboard"),
        requestedUserEvent.of(result.userEvent),
        Transaction.userEvent.of(result.userEvent),
      ],
    });
    if (edits.length > 0 && !transaction.docChanged) return false;
    view.dispatch(transaction);
    return true;
  }

  /** 将外部表格、搜索或工具条操作定位回唯一 source 选区。 */
  setSelection(anchor: number, head = anchor): void {
    this.#assertLive();
    if (
      !Number.isSafeInteger(anchor) ||
      !Number.isSafeInteger(head) ||
      anchor < 0 ||
      head < 0 || anchor > this.view.state.doc.length ||
      head > this.view.state.doc.length
    ) {
      throw new RangeError(`invalid CodeMirror selection ${anchor}..${head}`);
    }
    this.view.dispatch({
      selection: CodeMirrorSelection.range(anchor, head),
      scrollIntoView: true,
    });
  }

  async settled(): Promise<void> {
    if (this.#compositionCommitPending) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await this.#syncing;
    await this.#options.transactions.settled();
    await this.#quoteRequest?.done;
    if (this.#options.session.terminalError) throw this.#options.session.terminalError;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#compositionCommitTimer !== undefined) {
      clearTimeout(this.#compositionCommitTimer);
    }
    this.#imageInput?.cancel();
    this.#unsubscribe();
    this.#unsubscribeCommands();
    this.#unsubscribeLocale();
    this.view.destroy();
  }

  #accept(update: ViewUpdate): void {
    if (!update.docChanged || this.#disposed) return;
    if (update.transactions.some((transaction) =>
      transaction.annotation(synchronizedFromEngine) === true
    )) return;

    const compositionUpdate = this.#compositionActive ||
      this.#compositionCommitPending || update.view.composing ||
      update.transactions.some((transaction) =>
        transaction.isUserEvent("input.type.compose")
      );
    const origin = compositionUpdate ? "ime" : inputOrigin(update);
    const userEvent = requestedUserEventFromUpdate(update) ?? inputUserEvent(origin);
    if (origin === "ime") {
      this.#compositionId ??= `codemirror-composition-${++this.#compositionSequence}`;
    } else {
      this.#compositionId = undefined;
    }
    const nextSource = sourceSnapshot(update.view);
    const nextSelection = protocolSelection(update.state.selection.main.anchor,
      update.state.selection.main.head);
    const previousSelection = protocolSelection(
      update.startState.selection.main.anchor,
      update.startState.selection.main.head,
    );
    this.#version += 1;
    this.#pendingChanges = this.#pendingChanges.compose(update.changes);
    this.#desired = {
      source: nextSource,
      selectionBefore: previousSelection,
      selectionAfter: nextSelection,
      visibleRanges: update.view.visibleRanges.map((visible) => range(visible.from, visible.to)),
      origin,
      history: origin === "undo" || origin === "redo"
        ? { type: "ignore" }
        : {
            type: "record",
            group: this.#compositionId ?? userEvent,
          },
      userEvent,
      ...(this.#compositionId === undefined
        ? {}
        : { compositionId: this.#compositionId }),
      version: this.#version,
    };
    try {
      this.#options.onInputTransaction?.({
        version: this.#version,
        origin,
        userEvent,
        ...(this.#compositionId === undefined
          ? {}
          : { compositionId: this.#compositionId }),
        edits: codeMirrorChangesToTextEdits(update.changes),
        selectionBefore: previousSelection,
        selectionAfter: nextSelection,
      });
    } catch (error) {
      this.#options.onError?.(error);
    }
    if (!compositionUpdate) {
      this.#ensureSynchronized();
      if (origin === "ime") this.#compositionId = undefined;
    }
  }

  #beginComposition(): void {
    if (this.#compositionCommitTimer !== undefined) {
      clearTimeout(this.#compositionCommitTimer);
      this.#compositionCommitTimer = undefined;
    }
    this.#compositionActive = true;
    this.#compositionCommitPending = false;
    this.#compositionId ??= `codemirror-composition-${++this.#compositionSequence}`;
  }

  #finishComposition(): void {
    this.#compositionActive = false;
    this.#compositionCommitPending = true;
    if (this.#compositionCommitTimer !== undefined) {
      clearTimeout(this.#compositionCommitTimer);
    }
    // 浏览器可能在 compositionend 后立即派发最后一次 input。
    // 放到下一个 task 提交，使每次中间替换都归入带稳定 compositionId 的
    // 精确 revision 事务。
    this.#compositionCommitTimer = setTimeout(() => {
      this.#compositionCommitTimer = undefined;
      this.#compositionCommitPending = false;
      if (!this.#disposed) this.#ensureSynchronized();
      this.#compositionId = undefined;
    }, 0);
  }

  #ensureSynchronized(): void {
    // An earlier synchronization may finish while an IME is composing. Its
    // finally callback must not start a new drain until compositionend and
    // the browser's final input event have both been processed.
    if (this.#syncing !== undefined || this.#disposed || this.#options.session.terminalError ||
        this.#compositionActive || this.#compositionCommitPending) return;
    const run = this.#synchronizeLoop();
    this.#syncing = run.finally(() => {
      this.#syncing = undefined;
      if (!this.#disposed && !this.#pendingChanges.empty) this.#ensureSynchronized();
    });
    void this.#syncing.catch((error) => this.#options.onError?.(error));
  }

  async #synchronizeLoop(): Promise<void> {
    // A request already sent before composition uses its immutable snapshot,
    // but changes accumulated while awaiting it may include an uncommitted
    // candidate. Leave those changes queued until compositionend instead of
    // draining them into the confirmed Rust document.
    while (!this.#disposed && !this.#compositionActive && !this.#compositionCommitPending &&
        !this.#pendingChanges.empty) {
      const desired = this.#desired;
      const expectedBase = this.#pendingBase;
      const pendingChanges = this.#pendingChanges;
      this.#pendingBase = desired.source;
      this.#pendingChanges = ChangeSet.empty(desired.source.length);
      try {
        await this.#options.transactions.enqueue(({ source: confirmedSource }) => {
          const edits = confirmedSource === expectedBase
            ? codeMirrorChangesToTextEdits(pendingChanges)
            : singleTextEdit(
                confirmedSource,
                desired.source,
                Number(desired.selectionAfter.head),
              );
          if (edits.length === 0) throw new AlreadySynchronized();
          return {
            origin: desired.origin,
            edits,
            viewport: {
              visibleRanges: desired.visibleRanges,
              activeRange: range(
                Number(desired.selectionAfter.head),
                Number(desired.selectionAfter.head),
              ),
            },
            ...(confirmedSource === expectedBase
              ? { selectionBefore: desired.selectionBefore }
              : {}),
            selectionAfter: desired.selectionAfter,
            history: desired.history,
            metadata: {
              userEvent: desired.userEvent,
              ...(desired.compositionId === undefined
                ? {}
                : { compositionId: desired.compositionId }),
              correlationId: `codemirror-${desired.version}`,
            },
          };
        });
      } catch (error) {
        if (error instanceof AlreadySynchronized) continue;
        if (!this.#options.session.terminalError) this.#replaceFromEngine(this.#options.session.adapter.text.text);
        throw error;
      }
    }
  }

  #replaceFromEngine(source: string, appliedEdits?: readonly TextEdit[]): void {
    if (this.#disposed) return;
    const transaction = engineSynchronization(this.view.state, source, appliedEdits);
    if (transaction === undefined && this.#pendingChanges.empty) return;
    this.#version += 1;
    const next = transaction?.newSelection ?? this.view.state.selection;
    this.#desired = {
      ...this.#desired,
      source,
      selectionBefore: protocolSelection(this.view.state.selection.main.anchor, this.view.state.selection.main.head),
      selectionAfter: protocolSelection(next.main.anchor, next.main.head),
      version: this.#version,
    };
    this.#pendingBase = source;
    this.#pendingChanges = ChangeSet.empty(source.length);
    if (transaction !== undefined) this.view.dispatch(transaction);
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("CodeMirror source disposed");
  }

  #commandKeymap() {
    return this.#commands.shortcuts.map((shortcut) => ({
      key: shortcut.key,
      run: () => this.executeCommand(shortcut.command),
      ...(shortcut.command.startsWith("search.")
        ? { scope: "editor search-panel", preventDefault: true }
        : shortcut.command.startsWith("focus.") ? { scope: "editor search-panel" }
        : {}),
    }));
  }
}

class AlreadySynchronized extends Error {}

export function codeMirrorChangesToTextEdits(changes: ChangeSet): readonly TextEdit[] {
  const edits: TextEdit[] = [];
  changes.iterChanges((from, to, _insertedFrom, _insertedTo, inserted) => {
    edits.push({ range: range(from, to), insert: inserted.toString() });
  });
  return edits;
}

function protocolSelection(anchor: number, head: number): EditorSelection {
  return {
    anchor: anchor as Utf16Offset,
    head: head as Utf16Offset,
  };
}

function inputOrigin(update: ViewUpdate): TransactionOrigin {
  for (const transaction of update.transactions) {
    const requested = transaction.annotation(requestedOrigin);
    if (requested !== undefined) return requested;
    const userEvent = transaction.annotation(Transaction.userEvent);
    if (userEvent?.startsWith("input.table.paste") === true) return "paste";
    if (userEvent?.startsWith("input.table.compose") === true) return "ime";
    if (userEvent?.startsWith("input.table.") === true) return "keyboard";
    if (transaction.isUserEvent("undo")) return "undo";
    if (transaction.isUserEvent("redo")) return "redo";
    if (transaction.isUserEvent("input.paste")) return "paste";
    if (transaction.isUserEvent("input.drop")) return "drop";
    if (transaction.isUserEvent("input.type.compose")) return "ime";
  }
  return update.view.composing ? "ime" : "keyboard";
}

function inputUserEvent(origin: TransactionOrigin): string {
  switch (origin) {
    case "ime": return "input.type.compose";
    case "paste": return "input.paste";
    case "drop": return "input.drop";
    case "undo": return "undo";
    case "redo": return "redo";
    case "api": return "input.api";
    default: return "input.type";
  }
}

function requestedUserEventFromUpdate(update: ViewUpdate): string | undefined {
  for (const transaction of update.transactions) {
    const event = transaction.annotation(requestedUserEvent);
    if (event !== undefined) return event;
  }
  // Built-in source commands (search, paste, history) already describe their
  // intent. Preserve it in the engine transaction and observability stream.
  for (const transaction of update.transactions) {
    const event = transaction.annotation(Transaction.userEvent);
    if (event !== undefined) return event;
  }
  return undefined;
}

function assertCommandEdits(
  edits: readonly TextEdit[],
  length: number,
): void {
  let previous = 0;
  for (const edit of edits) {
    const from = Number(edit.range.from);
    const to = Number(edit.range.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < previous || to < from || to > length) {
      throw new RangeError("editor command produced invalid or overlapping edits");
    }
    previous = to;
  }
}
