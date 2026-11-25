import { editorI18nAt, type EditorI18n } from "../../core/i18n.js";
import {
  TABLE_COMMAND,
  type TableCommandExecutor,
  type TableCommandId,
} from "./commands.js";

export interface TableToolbarOptions {
  readonly document: Document;
  readonly i18n?: EditorI18n;
  readonly tableId: string;
  readonly resolveAnchor: () => number;
  readonly execute: TableCommandExecutor;
  readonly canExecute?: (command: TableCommandId, anchor: number) => boolean;
}

/**
 * 表格操作工具条只负责声明按钮和转发命令，不直接读写 Markdown。
 * Preview、Live Preview 以及未来的扩展宿主都可以复用同一个 DOM 工厂。
 */
const refreshers = new WeakMap<HTMLElement, () => void>();
export function refreshTableToolbar(toolbar: HTMLElement): void { refreshers.get(toolbar)?.(); }

export function createTableToolbar(options: TableToolbarOptions): HTMLElement {
  const toolbar = options.document.createElement("div");
  const i18n = options.i18n ?? editorI18nAt(toolbar);
  toolbar.className = "jot-table-toolbar";
  toolbar.dataset["jotTableToolbar"] = "true";
  toolbar.dataset["jotTableId"] = options.tableId;
  toolbar.setAttribute("role", "toolbar");
  i18n.bind(toolbar, "aria-label", "Table actions");

  const refresh: Array<() => void> = [];
  for (const action of TABLE_TOOLBAR_ACTIONS) {
    const button = options.document.createElement("button");
    button.type = "button";
    button.className = "jot-table-toolbar__button";
    button.dataset["jotTableCommand"] = action.command;
    i18n.bind(button, "textContent", action.label);
    i18n.bind(button, "title", action.title);
    i18n.bind(button, "aria-label", action.title);
    // 保留当前编辑器焦点，避免点击工具条后 command 使用了错误的 selection。
    button.addEventListener("mousedown", (event) => event.preventDefault());
    refresh.push(() => { button.disabled = options.canExecute?.(action.command, options.resolveAnchor()) === false; });
    button.addEventListener("click", () => {
      const anchor = options.resolveAnchor();
      if (options.canExecute?.(action.command, anchor) !== false) options.execute(action.command, anchor);
      refreshTableToolbar(toolbar);
    });
    toolbar.append(button);
  }
  refreshers.set(toolbar, () => refresh.forEach(update => update()));
  refreshTableToolbar(toolbar);
  return toolbar;
}

export const TABLE_TOOLBAR_ACTIONS: readonly {
  readonly command: TableCommandId;
  readonly label: string;
  readonly title: string;
}[] = [
  {
    command: TABLE_COMMAND.insertRowBelow,
    label: "+ 行",
    title: "在当前行下方插入表格行",
  },
  {
    command: TABLE_COMMAND.deleteRow,
    label: "− 行",
    title: "删除当前表格行",
  },
  {
    command: TABLE_COMMAND.insertColumnAfter,
    label: "+ 列",
    title: "在当前列右侧插入表格列",
  },
  {
    command: TABLE_COMMAND.deleteColumn,
    label: "− 列",
    title: "删除当前表格列",
  },
  {
    command: TABLE_COMMAND.clearCell,
    label: "清空",
    title: "清空当前表格单元格",
  },
];
