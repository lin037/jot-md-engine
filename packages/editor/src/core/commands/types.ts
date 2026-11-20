import type {
  BlockMetadata,
  EditorSelection,
  TextEdit,
  TransactionOrigin,
} from "@jot-md/editor-protocol";

export interface TableInsertionSize {
  /** Number of visible rows, including the header. */
  readonly rows: number;
  readonly columns: number;
}

/**
 * 与具体输入控件无关的命令上下文。源码和选区都是 UTF-16 偏移，因而可以被
 * CodeMirror、菜单、命令面板和未来的扩展 SDK 复用。
 */
export interface EditorCommandContext {
  readonly source: string;
  readonly selection: EditorSelection;
  /** Rust-confirmed root at the selection head for this exact source snapshot. */
  readonly block?: BlockMetadata | undefined;
  /** CodeMirror 多选数量；未由非 CodeMirror 宿主提供时按单一选区处理。 */
  readonly selectionCount?: number;
  readonly tableSize?: TableInsertionSize;
}

/** 一个命令要提交的源码变更与可选的新选区。 */
export interface EditorCommandResult {
  /** A host action shares the registry/shortcut path without manufacturing edits. */
  readonly action?: string;
  readonly edits?: readonly TextEdit[];
  readonly selection?: EditorSelection;
  readonly origin?: TransactionOrigin;
  /** 写入事务观测流的稳定事件名，例如 input.table.insert-row。 */
  readonly userEvent: string;
}

/** 命令本身不依赖 DOM、CodeMirror 或某个页面。 */
export interface EditorCommand {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly description?: string;
  /** Input commands reveal the editing surface before execution from component UI. */
  readonly requiresInput?: boolean;
  run(context: EditorCommandContext): EditorCommandResult | undefined;
}

/**
 * 默认按键只声明“按什么键执行哪个命令”。宿主负责把它适配到具体输入系统，
 * 并在命令返回 undefined 时把事件交给后续默认按键处理。
 */
export interface EditorShortcut {
  readonly id: string;
  readonly key: string;
  readonly command: string;
}
