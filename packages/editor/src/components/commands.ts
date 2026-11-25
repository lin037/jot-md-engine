import { EditorCommandRegistry } from "../core/commands/index.js";
import { tableCommands, tableShortcuts } from "./table/commands.js";
import { formatCommands, formatShortcuts } from "./format-commands.js";
import { nativeCommands, nativeShortcuts } from "./native-commands.js";
import { blockCommands } from "./block-commands.js";

const macShortcutKeys: Readonly<Record<string, string>> = {
  "command.palette": "Ctrl-Shift-p",
  "search.replace": "Ctrl-Shift-h",
  "search.next": "Ctrl-g",
  "search.previous": "Ctrl-Shift-g",
  "document.goto-line": "Ctrl-Shift-l",
  "selection.next-occurrence": "Ctrl-Shift-d",
  "mode.live-preview": "Ctrl-Shift-e",
  "format.code": "Ctrl-Shift-c",
  "format.link": "Ctrl-Shift-k",
  "format.heading-1": "Ctrl-Shift-1",
  "format.heading-2": "Ctrl-Shift-2",
  "format.heading-3": "Ctrl-Shift-3",
  "format.heading-4": "Ctrl-Shift-4",
  "format.heading-5": "Ctrl-Shift-5",
  "format.heading-6": "Ctrl-Shift-6",
  "table.insert-row-below": "Ctrl-Shift-ArrowDown",
  "table.insert-column-after": "Ctrl-Shift-ArrowRight",
};

/** 每个 MarkdownEditor 默认使用一份独立注册表，便于宿主安全附加自定义命令。 */
export function createDefaultEditorCommandRegistry(
  platform = globalThis.navigator?.platform ?? "",
): EditorCommandRegistry {
  const mac = /Mac|iPhone|iPad/u.test(platform);
  return new EditorCommandRegistry([...tableCommands, ...formatCommands, ...blockCommands, ...nativeCommands],
    defaultEditorShortcuts(mac));
}

export function defaultEditorShortcuts(mac: boolean) {
  return [...tableShortcuts, ...formatShortcuts, ...nativeShortcuts,
    { id: "format.task-list", command: "format.task-list", key: "Ctrl-Shift-9" },
    { id: "task.toggle-checked", command: "task.toggle-checked", key: "Mod-Alt-Enter" },
  ].map((shortcut) => {
    const key = mac ? macShortcutKeys[shortcut.id] : undefined;
    return key === undefined ? shortcut : { ...shortcut, key };
  });
}
