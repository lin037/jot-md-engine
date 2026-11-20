import type {
  EditorCommand,
  EditorCommandContext,
  EditorCommandResult,
  EditorShortcut,
} from "./types.js";

/**
 * 命令与快捷键的单一注册表。它刻意不执行 DOM 事件：不同宿主只需把相同命令
 * 映射到自己的输入系统，语义变换和观测事件就不会分叉。
 */
export class EditorCommandRegistry {
  readonly #commands = new Map<string, EditorCommand>();
  readonly #shortcuts: EditorShortcut[] = [];
  readonly #defaults = new Map<string, EditorShortcut>();
  readonly #listeners = new Set<() => void>();
  #shortcutPlatform: "mac" | "windows" | undefined;

  constructor(
    commands: readonly EditorCommand[] = [],
    shortcuts: readonly EditorShortcut[] = [],
  ) {
    commands.forEach((command) => this.register(command));
    shortcuts.forEach((shortcut) => this.bind(shortcut));
  }

  get commands(): readonly EditorCommand[] {
    return [...this.#commands.values()];
  }

  get shortcuts(): readonly EditorShortcut[] {
    return this.#shortcuts.slice();
  }

  register(command: EditorCommand): this {
    if (this.#commands.has(command.id)) {
      throw new Error(`duplicate editor command: ${command.id}`);
    }
    this.#commands.set(command.id, command);
    this.#changed();
    return this;
  }

  /** Remove a plugin-owned command and its bindings when the plugin stops. */
  unregister(id: string): boolean {
    if (!this.#commands.delete(id)) return false;
    for (let index = this.#shortcuts.length - 1; index >= 0; index--) {
      if (this.#shortcuts[index]?.command === id) this.#shortcuts.splice(index, 1);
    }
    for (const [shortcutId, shortcut] of this.#defaults) {
      if (shortcut.command === id) this.#defaults.delete(shortcutId);
    }
    this.#changed();
    return true;
  }

  bind(shortcut: EditorShortcut): this {
    if (!this.#commands.has(shortcut.command)) {
      throw new Error(`shortcut ${shortcut.id} references an unknown command: ${shortcut.command}`);
    }
    if (this.#shortcuts.some((item) => item.id === shortcut.id)) {
      throw new Error(`duplicate editor shortcut: ${shortcut.id}`);
    }
    normalizedKeys(shortcut.key);
    this.#shortcuts.push(shortcut);
    this.#defaults.set(shortcut.id, shortcut);
    this.#changed();
    return this;
  }

  /** Subscribe to command/keymap changes; the caller owns unsubscription. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get defaultShortcuts(): readonly EditorShortcut[] {
    return [...this.#defaults.values()];
  }

  /** One editable shortcut slot per command, plus any additional named bindings. */
  get shortcutSettings(): readonly { readonly id: string; readonly command: string; readonly key?: string }[] {
    const defaults = this.defaultShortcuts;
    const configured = new Set(defaults.map((binding) => binding.command));
    return [...defaults, ...this.commands
      .filter((command) => !configured.has(command.id) && !this.#defaults.has(command.id))
      .map(({ id }) => ({ id, command: id }))];
  }

  get shortcutPlatform(): "mac" | "windows" | undefined {
    return this.#shortcutPlatform;
  }

  /** null disables a binding. Validate every override before changing any key. */
  configureShortcuts(overrides: Readonly<Record<string, string | null>>): void {
    const next = this.#resolveShortcuts(this.#shortcuts, this.#defaults, overrides, this.#shortcutPlatform);
    this.#shortcuts.splice(0, this.#shortcuts.length, ...next);
    this.#changed();
  }

  /** Switch defaults and saved overrides together so the input sees one keymap update. */
  setShortcutDefaults(
    keys: Readonly<Record<string, string>>,
    overrides: Readonly<Record<string, string | null>>,
    platform: "mac" | "windows",
  ): void {
    const defaults = new Map(this.#defaults);
    for (const [id, key] of Object.entries(keys)) {
      const binding = defaults.get(id);
      if (binding === undefined) throw new Error(`unknown editor shortcut: ${id}`);
      if (key.trim().length === 0) throw new Error(`empty key for shortcut: ${id}`);
      defaults.set(id, { ...binding, key: shortcutKey(key.trim(), platform) });
    }
    const baseline = this.#resolveShortcuts(defaults.values(), defaults, {});
    const next = this.#resolveShortcuts(baseline, defaults, overrides, platform);
    for (const [id, binding] of defaults) this.#defaults.set(id, binding);
    this.#shortcuts.splice(0, this.#shortcuts.length, ...next);
    this.#shortcutPlatform = platform;
    this.#changed();
  }

  resetShortcuts(): void {
    this.#shortcuts.splice(0, this.#shortcuts.length, ...this.#defaults.values());
    this.#changed();
  }

  #resolveShortcuts(
    active: Iterable<EditorShortcut>,
    defaults: ReadonlyMap<string, EditorShortcut>,
    overrides: Readonly<Record<string, string | null>>,
    platform?: "mac" | "windows",
  ): EditorShortcut[] {
    const next = new Map(Array.from(active, shortcut => [shortcut.id, shortcut]));
    for (const [id, key] of Object.entries(overrides)) {
      const command = defaults.get(id)?.command ?? this.#commands.get(id)?.id;
      if (command === undefined) throw new Error(`unknown editor shortcut: ${id}`);
      if (key === null) next.delete(id);
      else {
        if (key.trim().length === 0) throw new Error(`empty key for shortcut: ${id}`);
        normalizedKeys(key.trim());
        next.set(id, { id, command, key: shortcutKey(key.trim(), platform) });
      }
    }
    const keys = new Map<string, string>();
    for (const shortcut of next.values()) {
      for (const key of normalizedKeys(shortcut.key)) {
        const previous = keys.get(key);
        if (previous !== undefined && previous !== shortcut.id) {
          throw new Error(`快捷键冲突：${shortcut.key}（${previous} / ${shortcut.id}）`);
        }
        keys.set(key, shortcut.id);
      }
    }
    return [...next.values()];
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  command(id: string): EditorCommand | undefined {
    return this.#commands.get(id);
  }

  /** Same bindings are used by the input host, mapped widgets and component UI. */
  shortcutForEvent(input: {
    readonly key: string;
    readonly code?: string;
    readonly altKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
  }, mac = false): EditorShortcut | undefined {
    const modifiers = [input.altKey ? "alt" : "", input.ctrlKey ? "ctrl" : "",
      input.metaKey ? "meta" : "", input.shiftKey ? "shift" : ""].filter(Boolean).sort();
    const name = input.key === " " ? "space" : input.key.toLowerCase();
    const key = `${modifiers.join("-")}:${name}`;
    const platform = mac ? 1 : 0;
    const exact = this.#shortcuts.find((binding) => normalizedKeys(binding.key)[platform] === key);
    if (exact !== undefined) return exact;
    // Shift produces punctuation on the digit row (for example Shift+1 sends "!").
    // Match the base digit for modified shortcuts, as the CodeMirror keymap does.
    const digit = input.shiftKey && (input.ctrlKey || input.metaKey) && name.length === 1
      ? /^Digit([0-9])$/u.exec(input.code ?? "")?.[1]
      : undefined;
    if (digit === undefined || digit === name) return undefined;
    const baseKey = `${modifiers.join("-")}:${digit}`;
    return this.#shortcuts.find((binding) => normalizedKeys(binding.key)[platform] === baseKey);
  }

  execute(id: string, context: EditorCommandContext): EditorCommandResult | undefined {
    return this.#commands.get(id)?.run(context);
  }
}

function shortcutKey(key: string, platform: "mac" | "windows" | undefined): string {
  if (platform === undefined) return key;
  return key.replace(/(^|-)Mod(?=-)/giu, platform === "mac" ? "$1Meta" : "$1Ctrl");
}

function normalizedKeys(key: string): readonly string[] {
  // Match CodeMirror's grammar, including bindings for the literal '-' key.
  const parts = key.split(/-(?!$)/u);
  const name = parts.pop()!;
  const aliases: Readonly<Record<string, string>> = {
    cmd: "meta", meta: "meta", m: "meta", a: "alt", alt: "alt",
    c: "ctrl", ctrl: "ctrl", control: "ctrl", s: "shift", shift: "shift", mod: "mod",
  };
  const modifiers = parts.map((part) => {
    const modifier = aliases[part.toLowerCase()];
    if (modifier === undefined) throw new Error(`无效快捷键修饰符：${part}`);
    return modifier;
  });
  return ["ctrl", "meta"].map((mod) => {
    const canonical = [...new Set(modifiers.map((part) => part === "mod" ? mod : part))].sort();
    return `${canonical.join("-")}:${name.toLowerCase()}`;
  });
}
