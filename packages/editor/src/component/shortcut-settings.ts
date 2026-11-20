import type { EditorCommandRegistry } from "../core/commands/index.js";

/** Optional, framework-neutral keybinding form. Persistence belongs to the host. */
export function mountShortcutSettings(
  root: HTMLElement,
  commands: EditorCommandRegistry,
): { dispose(): void } {
  const document = root.ownerDocument;
  const deviceIsMac = /Mac|iPhone|iPad/u.test(document.defaultView?.navigator.platform ?? "");
  const form = document.createElement("form");
  form.className = "jot-shortcut-settings";
  const fields = document.createElement("div");
  const help = document.createElement("p");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "保存快捷键";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "恢复默认";
  const inputs = new Map<string, HTMLInputElement>();
  const render = () => {
    const mac = commands.shortcutPlatform === undefined ? deviceIsMac : commands.shortcutPlatform === "mac";
    help.textContent = mac
      ? "用连字符连接，例如 Control-Shift-p。Mod 对应 Command（⌘），Alt 对应 Option（⌥）。留空可禁用。"
      : "用连字符连接，例如 Ctrl-Shift-p。Mod 对应 Ctrl。留空可禁用。";
    // Saving by Enter notifies the registry while focus is still in a field.
    // Only restore a field this form owned; external editor/search inputs and
    // the persistent Save/Reset buttons must retain their own focus.
    const focused = [...inputs].find(([, input]) => input === document.activeElement);
    const selection = focused === undefined ? undefined : {
      start: focused[1].selectionStart,
      end: focused[1].selectionEnd,
      direction: focused[1].selectionDirection,
    };
    inputs.clear();
    fields.replaceChildren();
    const active = new Map(commands.shortcuts.map(binding => [binding.id, binding.key]));
    for (const binding of commands.shortcutSettings) {
      const label = document.createElement("label");
      label.className = "jot-shortcut-settings__row";
      const title = document.createElement("span");
      title.textContent = commands.command(binding.command)?.title ?? binding.command;
      const input = document.createElement("input");
      input.type = "text";
      input.name = binding.id;
      const key = active.get(binding.id);
      if (key !== undefined) input.value = input.defaultValue = displayShortcut(key, mac);
      input.setAttribute("aria-label", title.textContent);
      input.placeholder = "未绑定";
      label.append(title, input);
      fields.append(label);
      inputs.set(binding.id, input);
    }
    const replacement = focused === undefined ? undefined : inputs.get(focused[0]);
    if (replacement !== undefined && selection !== undefined) {
      replacement.focus({ preventScroll: true });
      if (selection.start !== null && selection.end !== null) {
        replacement.setSelectionRange(selection.start, selection.end, selection.direction ?? "none");
      }
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const active = new Map(commands.shortcuts.map(binding => [binding.id, binding.key]));
      commands.configureShortcuts(Object.fromEntries([...inputs].map(([id, input]) => {
        const label = input.value.trim();
        // Saving another field must not pin an untouched Mod binding to
        // Command or Ctrl.
        return [id, label === "" ? null : input.defaultValue === label ? active.get(id)! : parseShortcutLabel(label)];
      })));
      error.textContent = "已保存";
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    }
  });
  reset.addEventListener("click", () => {
    commands.resetShortcuts();
    error.textContent = "已恢复默认";
  });
  form.append(help, fields, error, save, reset);
  root.append(form);
  render();
  const unsubscribe = commands.subscribe(render);
  return { dispose() { unsubscribe(); form.remove(); } };
}

export function displayShortcut(key: string, mac: boolean): string {
  const parts = key.split(/-(?!$)/u);
  const base = parts.pop()!;
  const modifiers = parts.map(part => {
    switch (part.toLowerCase()) {
      case "mod": return mac ? "Command" : "Ctrl";
      case "cmd": case "meta": case "m": return mac ? "Command" : "Meta";
      case "alt": case "a": return mac ? "Option" : "Alt";
      case "ctrl": case "control": case "c": return mac ? "Control" : "Ctrl";
      case "shift": case "s": return "Shift";
      default: return part;
    }
  });
  return [...modifiers, mac && base === "Backspace" ? "Delete（⌫）" :
    mac && base === "Delete" ? "Forward Delete（⌦）" : base].join("-");
}

function parseShortcutLabel(label: string): string {
  const parts = label.split(/-(?!$)/u);
  const base = parts.pop()!;
  const modifiers = parts.map(part => {
    switch (part.toLowerCase()) {
      case "option": return "Alt";
      case "command": return "Meta";
      default: return part;
    }
  });
  // CodeMirror 用小写字母匹配由 Shift 产生的大写按键。
  const key = base === "Delete（⌫）" ? "Backspace" :
    base === "Forward Delete（⌦）" ? "Delete" :
    /^[A-Z]$/u.test(base) ? base.toLowerCase() : base;
  return [...modifiers, key].join("-");
}
