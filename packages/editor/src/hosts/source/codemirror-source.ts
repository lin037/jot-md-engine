import { sourceSnapshot } from "../shared/source-snapshot.js";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
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
import { EditorCommandRegistry, type TableInsertionSize } from "../../core/commands/index.js";
import { engineSynchronization, requestedOrigin, sourceReadOnlyFilter,
  synchronizedFromEngine } from "./synchronization.js";
import {
  closeSearchPanel,
  executeSourceAction,
  findNext,
  findPrevious,
  getSearchQuery,
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

export interface CodeMirrorSourceOptions {
  readonly root: HTMLElement;
  readonly session: EditorDocumentSession;
  readonly transactions: EditorTransactionCoordinator;
  readonly extensions?: readonly Extension[];
  readonly lineWrapping?: boolean;
  readonly readOnly?: boolean;
  /** 未传入时使用 MarkdownEditor 的内置表格命令与快捷键。 */
  readonly commands?: EditorCommandRegistry;
  /** Host actions share the same command registry as source edit commands. */
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
  readonly #options: CodeMirrorSourceOptions;
  readonly #commands: EditorCommandRegistry;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeCommands: () => void;
  readonly #editable = new Compartment();
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
  #pendingBase: string;
  #pendingChanges: ChangeSet;

  constructor(options: CodeMirrorSourceOptions) {
    this.#options = options;
    this.#commands = options.commands ?? createDefaultEditorCommandRegistry();
    const source = options.session.adapter.text.text;
    this.#pendingBase = source;
    this.#pendingChanges = ChangeSet.empty(source.length);
    const initialSelection = selection(0, 0);
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
      sourceReadOnlyFilter,
      sourceSearch(),
      this.#commandBindings.of(keymap.of(this.#commandKeymap())),
      keymap.of([
        ...markdownKeymap,
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
          return false;
        },
      }),
      EditorView.updateListener.of((update) => this.#accept(update)),
      ...(options.lineWrapping === false ? [] : [EditorView.lineWrapping]),
      ...(options.extensions ?? []),
    ];
    this.view = new EditorView({
      parent: options.root,
      state: EditorState.create({ doc: source, extensions }),
    });
    this.#unsubscribe = options.session.subscribe((effect) => {
      // Analysis and projection effects never change confirmed source. A
      // full CM Text flatten/compare for each background slice turns opening
      // a large document into repeated O(document-size) main-thread work.
      if (effect.documentPatch === undefined || this.#syncing !== undefined || this.#disposed) return;
      this.#replaceFromEngine(options.session.adapter.text.text, effect.appliedEdits);
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

  get commands(): EditorCommandRegistry {
    return this.#commands;
  }

  get searchQuery(): EditorSearchQuery {
    return getSearchQuery(this.view.state);
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
    this.#assertLive();
    const selection = selectionOverride ?? protocolSelection(
      this.view.state.selection.main.anchor,
      this.view.state.selection.main.head,
    );
    const view = this.view;
    const adapter = this.#options.session.adapter;
    const result = this.#commands.execute(id, {
      // Host-only actions such as Find Next never need a flattened document.
      // Semantic edit commands still receive the same source string on demand.
      get source() { return sourceSnapshot(view); },
      get block() { return adapter.confirmedBlockAt(sourceSnapshot(view), Number(selection.head)); },
      selection,
      ...(options.tableSize === undefined ? {} : { tableSize: options.tableSize }),
      // 工具栏传入显式 anchor 表示用户已经选择了唯一命令目标；普通快捷键
      // 则必须保留 CodeMirror 的多选数量，交给命令前置条件判断。
      selectionCount: selectionOverride === undefined
        ? this.view.state.selection.ranges.length
        : 1,
    });
    if (result === undefined) return false;
    if (result.action !== undefined) {
      return executeSourceAction(this.view, result.action) ??
        this.#options.onCommandAction?.(result.action) ?? false;
    }
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
      ...(result.selection === undefined &&
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
    if (this.#options.session.terminalError) throw this.#options.session.terminalError;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#compositionCommitTimer !== undefined) {
      clearTimeout(this.#compositionCommitTimer);
    }
    this.#unsubscribe();
    this.#unsubscribeCommands();
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
  return selection(anchor, head);
}

function selection(anchor: number, head: number): EditorSelection {
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
