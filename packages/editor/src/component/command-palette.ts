import { editorI18nAt } from "../core/i18n.js";
import type { EditorCommandRegistry } from "../core/commands/index.js";
import { displayShortcut, mountShortcutSettings } from "./shortcut-settings.js";

/** One keyboard-accessible command directory; never edits or parses document text. */
export function mountEditorCommandUI(root: HTMLElement, options: {
  readonly commands: EditorCommandRegistry;
  readonly execute: (id: string) => boolean | Promise<boolean>;
  readonly focusEditor: () => void;
  readonly openShortcutSettings?: () => void;
}): { open(): void; openSettings(): void; dispose(): void } {
  const document = root.ownerDocument;
  const i18n = editorI18nAt(root);
  const deviceIsMac = /Mac|iPhone|iPad/u.test(document.defaultView?.navigator.platform ?? "");
  const overlay = document.createElement("div");
  overlay.className = "jot-command-overlay";
  overlay.hidden = true;
  const dialog = document.createElement("div");
  dialog.className = "jot-command-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const header = document.createElement("div");
  header.className = "jot-command-dialog__header";
  const title = document.createElement("strong");
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  i18n.bind(closeButton, "textContent", "Close · Esc");
  const body = document.createElement("div");
  const input = document.createElement("input");
  input.type = "search";
  i18n.bind(input, "placeholder", "Search commands by name or ID…");
  i18n.bind(input, "aria-label", "Search editor commands");
  const list = document.createElement("div");
  list.className = "jot-command-list";
  list.setAttribute("role", "listbox");
  i18n.bind(list, "aria-label", "Editor commands");
  const status = document.createElement("p");
  status.className = "jot-command-status";
  status.setAttribute("role", "status");
  let selected = 0;
  let matches = options.commands.commands;
  let settings: ReturnType<typeof mountShortcutSettings> | undefined;
  let mode: "palette" | "settings" = "palette";
  let disposed = false;
  const close = () => {
    overlay.hidden = true;
    settings?.dispose();
    settings = undefined;
    options.focusEditor();
  };
  const activate = (id: string) => {
    close();
    void Promise.resolve().then(() => options.execute(id)).then((handled) => {
      if (!handled && !disposed) {
        open();
        i18n.bind(status, "textContent", "Select the relevant content before running this command.");
      }
    }).catch((error: unknown) => {
      if (disposed) return;
      open();
      i18n.bind(status, "textContent", error instanceof Error ? error.message : "Command failed");
    });
  };
  const select = () => {
    for (const [index, item] of Array.from(list.children).entries()) {
      item.setAttribute("aria-selected", String(index === selected));
      if (index === selected) {
        input.setAttribute("aria-activedescendant", item.id);
        item.scrollIntoView({ block: "nearest" });
      }
    }
    if (matches.length === 0) input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    const platform = options.commands.shortcutPlatform;
    const mac = platform === undefined ? deviceIsMac : platform === "mac";
    const query = input.value.toLocaleLowerCase().trim();
    matches = options.commands.commands.map(command => i18n.command(command)).filter((command) =>
      `${command.title} ${command.id} ${command.category ?? ""} ${command.description ?? ""}`
        .toLocaleLowerCase().includes(query))
      .sort((left, right) => rank(left.title, left.id, query) - rank(right.title, right.id, query));
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    list.replaceChildren();
    for (const [index, command] of matches.entries()) {
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.id = `jot-command-${instance}-${index}`;
      item.setAttribute("role", "option");
      item.dataset["jotCommand"] = command.id;
      const label = document.createElement("span");
      label.textContent = command.title;
      const detail = document.createElement("small");
      detail.textContent = command.description ?? command.id;
      label.append(detail);
      const key = document.createElement("kbd");
      const binding = options.commands.shortcuts.find((binding) => binding.command === command.id);
      if (binding !== undefined) key.textContent = displayShortcut(binding.key, mac);
      item.append(label, key);
      item.addEventListener("click", () => activate(command.id));
      list.append(item);
    }
    i18n.bind(status, "textContent", matches.length === 0 ? "No matching commands" : "↑↓ Select · Enter Run · Esc Return to editor");
    select();
  };
  const instance = ++nextInstance;
  function open(): void {
    settings?.dispose();
    settings = undefined;
    mode = "palette";
    i18n.bind(title, "textContent", "Command palette");
    i18n.bind(dialog, "aria-label", "Editor command palette");
    body.replaceChildren(input, list, status);
    overlay.hidden = false;
    input.value = "";
    selected = 0;
    render();
    input.focus();
  }
  function openSettings(): void {
    if (options.openShortcutSettings !== undefined) {
      options.openShortcutSettings();
      return;
    }
    settings?.dispose();
    mode = "settings";
    i18n.bind(title, "textContent", "Keyboard shortcuts");
    i18n.bind(dialog, "aria-label", "Keyboard shortcuts");
    body.replaceChildren();
    overlay.hidden = false;
    settings = mountShortcutSettings(body, options.commands);
    body.querySelector<HTMLInputElement>("input")?.focus();
  }
  input.addEventListener("input", () => { selected = 0; render(); });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % Math.max(1, matches.length);
      select();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[selected];
      if (command !== undefined) activate(command.id);
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled):not([tabindex='-1'])"));
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (focusable.length > 0 && ((event.shiftKey && index <= 0) || (!event.shiftKey && index === focusable.length - 1))) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
      }
    }
  });
  closeButton.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  header.append(title, closeButton);
  dialog.append(header, body);
  overlay.append(dialog);
  root.append(overlay);
  const refresh = () => {
    if (!overlay.hidden && mode === "palette") render();
  };
  const unsubscribe = options.commands.subscribe(refresh);
  const stopLocale = i18n.subscribe(refresh);
  return { open, openSettings, dispose() { disposed = true; unsubscribe(); stopLocale(); settings?.dispose(); overlay.remove(); } };
}

let nextInstance = 0;

/** Exact names win over related actions such as inserting a row into a table. */
function rank(title: string, id: string, query: string): number {
  if (query.length === 0) return 0;
  const names = [title.toLocaleLowerCase(), id.toLocaleLowerCase()];
  if (names.some((name) => name === query)) return 0;
  if (names.some((name) => name.startsWith(query))) return 1;
  if (names.some((name) => name.includes(query))) return 2;
  return 3;
}
