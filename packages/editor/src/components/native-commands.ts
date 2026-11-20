import type { EditorCommand, EditorShortcut } from "../core/commands/index.js";

/** Declarative host intents; input, palette and user keybindings share these IDs. */
const definitions = [
  ["command.palette", "命令面板", "编辑器", "查找和执行命令", "Mod-Shift-p", false],
  ["shortcut.settings", "快捷键设置", "编辑器", "查看、修改或禁用快捷键", undefined, false],
  ["search.open", "搜索", "搜索", "搜索全文，Enter 下一项，Shift-Enter 上一项", "Mod-f"],
  ["search.replace", "搜索和替换", "搜索", "替换当前项或全部匹配", "Mod-Shift-h"],
  ["search.next", "下一个匹配", "搜索", "循环定位下一个匹配", "F3"],
  ["search.previous", "上一个匹配", "搜索", "循环定位上一个匹配", "Shift-F3"],
  ["search.replace-next", "替换当前匹配", "搜索", "替换后继续查找"],
  ["search.replace-all", "替换全部", "搜索", "对 Markdown 源码执行，可用一次撤销恢复"],
  ["document.goto-line", "跳转到行", "导航", "按源码行号定位", "Mod-Alt-g"],
  ["selection.next-occurrence", "选中下一个相同文本", "编辑", "增加下一个匹配到选区", "Mod-d"],
  ["history.undo", "撤销", "编辑", "撤销上一次编辑", "Mod-z"],
  ["history.redo", "重做", "编辑", "重做上一次撤销", "Mod-Shift-z"],
  ["toolbar.open-heading", "选择标题级别", "工具栏", "打开标题选择器", undefined, false],
  ["toolbar.open-table", "选择表格尺寸", "工具栏", "打开行列选择器", undefined, false],
  ["toolbar.open-more", "更多格式和插入", "工具栏", "打开扩展工具菜单", undefined, false],
  ["editor.exit-block", "在当前块后继续编辑", "导航", "离开表格、代码、公式等块，在后方段落继续", "Mod-Enter"],
  ["editor.insert-before", "在当前块前继续编辑", "导航", "定位或创建前方段落", "Mod-Shift-Enter"],
  ["mode.source", "切换到源码模式", "视图", "编辑完整 Markdown 语法", undefined, false],
  ["mode.live-preview", "切换到即时预览", "视图", "在原生行上编辑渲染内容", "Mod-e", false],
  ["mode.preview", "切换到预览", "视图", "查看只读渲染结果", undefined, false],
] as const;

export const nativeCommands: readonly EditorCommand[] = definitions.map(([id, title, category, description, , requiresInput]) => ({
  id, title, category, description,
  requiresInput: requiresInput !== false,
  run: () => ({ action: id, userEvent: `command.${id}` }),
}));
export const nativeShortcuts: readonly EditorShortcut[] = definitions.flatMap((definition) =>
  definition[4] === undefined ? [] : [{ id: definition[0], command: definition[0], key: definition[4] }]);
