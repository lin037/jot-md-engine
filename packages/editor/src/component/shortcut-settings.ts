import { editorI18nAt, type EditorI18n } from "../core/i18n.js";
import { ShortcutError } from "../core/commands/registry.js";
import type { EditorCommandRegistry } from "../core/commands/index.js";

/** Optional, framework-neutral keybinding form. Persistence belongs to the host. */
export function mountShortcutSettings(
  root: HTMLElement,
  commands: EditorCommandRegistry,
  i18n: EditorI18n = editorI18nAt(root),
): { dispose(): void } {
  const document = root.ownerDocument;
  const deviceIsMac = /Mac|iPhone|iPad/u.test(document.defaultView?.navigator.platform ?? "");
  const form = document.createElement("form");
  form.className = "jot-shortcut-settings";
  const release = i18n.scope(form);
  const fields = document.createElement("div");
  const help = document.createElement("p");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const save = document.createElement("button");
  save.type = "submit";
  i18n.bind(save, "textContent", "Save shortcuts");
  const reset = document.createElement("button");
  reset.type = "button";
  i18n.bind(reset, "textContent", "Restore defaults");
  const inputs = new Map<string, HTMLInputElement>();
  const render = () => {
    const mac = commands.shortcutPlatform === undefined ? deviceIsMac : commands.shortcutPlatform === "mac";
    i18n.bind(help, "textContent", mac
      ? "Use hyphens, e.g. Control-Shift-p. Mod is Command (⌘), Alt is Option (⌥). Leave blank to disable."
      : "Use hyphens, e.g. Ctrl-Shift-p. Mod is Ctrl. Leave blank to disable.");
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
      const phrase = commands.command(binding.command)?.title ?? binding.command;
      i18n.bind(title, "textContent", phrase);
      const input = document.createElement("input");
      input.type = "text";
      input.name = binding.id;
      const key = active.get(binding.id);
      if (key !== undefined) input.value = input.defaultValue = displayShortcut(key, mac);
      i18n.bind(input, "aria-label", phrase);
      i18n.bind(input, "placeholder", "Unassigned");
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
      i18n.bind(error, "textContent", "Saved");
    } catch (cause) {
      if (cause instanceof ShortcutError) i18n.bind(error, "textContent", cause.phrase, ...cause.values);
      else i18n.bind(error, "textContent", cause instanceof Error ? cause.message : String(cause));
    }
  });
  reset.addEventListener("click", () => {
    commands.resetShortcuts();
    i18n.bind(error, "textContent", "Defaults restored");
  });
  form.append(help, fields, error, save, reset);
  root.append(form);
  render();
  const unsubscribe = commands.subscribe(render);
  return { dispose() { unsubscribe(); release(); form.remove(); } };
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
