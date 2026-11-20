import {
  mountShortcutSettings,
  type MarkdownEditor,
} from "../../../packages/editor/src/component/index.js";
import { defaultEditorShortcuts } from "../../../packages/editor/src/components/commands.js";

type ShortcutPlatform = "mac" | "windows";

export function bindShortcuts(editor: MarkdownEditor): () => void {
  const dialog = document.querySelector<HTMLDialogElement>("#shortcut-dialog")!;
  const trigger = document.querySelector<HTMLButtonElement>("#open-shortcuts")!;
  const search = document.querySelector<HTMLInputElement>("#shortcut-search")!;
  const platformInput = document.querySelector<HTMLSelectElement>("#shortcut-platform")!;
  const formHost = document.querySelector<HTMLElement>("#shortcuts")!;
  const status = document.querySelector<HTMLElement>("#shortcut-storage-status")!;
  const commands = editor.commands;
  let form: ReturnType<typeof mountShortcutSettings> | undefined;
  let platform: ShortcutPlatform = /Mac|iPhone|iPad/u.test(navigator.platform) ? "mac" : "windows";
  let switching = false;
  const platformStorage = "jot-demo.shortcut-platform";
  const storageKey = () => `jot-demo.shortcuts.${platform === "mac" ? "mac" : "other"}`;

  try {
    const savedPlatform = localStorage.getItem(platformStorage);
    if (savedPlatform === "mac" || savedPlatform === "windows") platform = savedPlatform;
  } catch { /* Storage may be disabled. The selected keymap still works. */ }
  usePlatform(platform);

  function usePlatform(next: ShortcutPlatform): void {
    switching = true;
    platform = next;
    platformInput.value = next;
    const defaults = Object.fromEntries(defaultEditorShortcuts(next === "mac")
      .map(binding => [binding.id, binding.key]));
    try {
      const stored = localStorage.getItem(storageKey());
      const overrides: unknown = JSON.parse(stored ?? "{}");
      if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides) ||
          Object.values(overrides).some(key => key !== null && typeof key !== "string")) {
        throw new Error("无效的快捷键配置");
      }
      commands.setShortcutDefaults(defaults, overrides as Record<string, string | null>, next);
      status.textContent = currentOverrides() === "{}" ? "正在使用默认快捷键。" : "已载入此浏览器保存的快捷键。";
    } catch {
      commands.setShortcutDefaults(defaults, {}, next);
      status.textContent = "无法载入本地配置，正在使用默认快捷键。";
    }
    switching = false;
  }

  function currentOverrides(): string {
    const active = new Map(commands.shortcuts.map(binding => [binding.id, binding.key]));
    return JSON.stringify(Object.fromEntries(commands.shortcutSettings.flatMap(binding => {
      const key = active.get(binding.id) ?? null;
      return key === (binding.key ?? null) ? [] : [[binding.id, key]];
    })));
  }

  function filterRows(): void {
    const query = search.value.trim().toLocaleLowerCase();
    for (const row of formHost.querySelectorAll<HTMLElement>(".jot-shortcut-settings__row")) {
      const input = row.querySelector("input");
      row.hidden = !`${row.textContent} ${input?.name ?? ""} ${input?.value ?? ""}`
        .toLocaleLowerCase().includes(query);
    }
  }

  const unsubscribe = commands.subscribe(() => {
    if (switching) return;
    const overrides = currentOverrides();
    const hasOverrides = overrides !== "{}";
    try {
      if (hasOverrides) localStorage.setItem(storageKey(), overrides);
      else localStorage.removeItem(storageKey());
      status.textContent = hasOverrides ? "已保存到此浏览器。" : "正在使用默认快捷键。";
    } catch {
      status.textContent = "浏览器无法保存，改键仅本次有效。";
    }
    // 表单自身收到同一个通知后会重画行。
    queueMicrotask(filterRows);
  });

  search.addEventListener("input", filterRows);
  platformInput.addEventListener("change", () => {
    form?.dispose();
    usePlatform(platformInput.value === "mac" ? "mac" : "windows");
    form = mountShortcutSettings(formHost, commands);
    filterRows();
    try { localStorage.setItem(platformStorage, platform); }
    catch { status.textContent = "浏览器无法保存所选键位方案。"; }
  });
  trigger.addEventListener("click", () => {
    form?.dispose();
    form = mountShortcutSettings(formHost, commands);
    search.value = "";
    dialog.showModal();
    search.focus();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    form?.dispose();
    form = undefined;
    // close 事件晚于原生对话框恢复焦点。用户已经回到正文时，应保留新的输入位置。
    if (document.activeElement === document.body || dialog.contains(document.activeElement)) trigger.focus();
  });
  return () => {
    unsubscribe();
    form?.dispose();
  };
}
