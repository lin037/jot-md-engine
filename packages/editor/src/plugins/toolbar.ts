import { displayShortcut } from "../component/shortcut-settings.js";
import type { MarkdownEditorPlugin } from "./registry.js";
import { toolbarIcon, type ToolbarIcon } from "./toolbar-icons.js";
import { createImagePicker, createTablePicker } from "./toolbar-pickers.js";

const headingCommands = [
  "format.heading-1", "format.heading-2", "format.heading-3",
  "format.heading-4", "format.heading-5", "format.heading-6", "format.paragraph",
] as const;

const defaultMoreGroups = [
  { title: "Text formatting", commands: ["format.strikethrough", "format.math"] },
  { title: "Lists", commands: ["task.toggle-checked", "list.renumber"] },
  { title: "Insert", commands: ["insert.image", "insert.code-block", "insert.math-block", "insert.thematic-break"] },
];

const defaultGroups = [
  ["history.undo", "history.redo"],
  ["toolbar.open-heading", "format.bold", "format.italic", "format.code", "format.link"],
  ["format.bullet-list", "format.ordered-list", "format.task-list", "format.quote", "toolbar.open-table", "toolbar.open-image", "toolbar.open-more"],
  ["search.open", "command.palette"],
] as const;

const icons: Readonly<Record<string, ToolbarIcon>> = {
  "history.undo": "arrow-back-up", "history.redo": "arrow-forward-up",
  "toolbar.open-heading": "heading", "format.bold": "bold", "format.italic": "italic",
  "format.code": "code", "format.link": "link", "toolbar.open-table": "table",
  "format.bullet-list": "list", "format.ordered-list": "list-numbers", "format.quote": "quote",
  "format.task-list": "checklist", "task.toggle-checked": "checked", "list.renumber": "list-numbers",
  "format.strikethrough": "strike", "format.math": "function", "insert.math-block": "formula-box",
  "insert.image": "image", "toolbar.open-image": "image", "insert.code-block": "code-box", "insert.thematic-break": "separator",
  "toolbar.open-more": "dots", "search.open": "search", "command.palette": "command",
};

const pickerTypes = {
  "toolbar.open-heading": "heading",
  "toolbar.open-table": "table",
  "toolbar.open-image": "image",
  "toolbar.open-more": "more",
} as const;
type Picker = typeof pickerTypes[keyof typeof pickerTypes];
const pickerLabels: Readonly<Record<Picker, string>> = {
  heading: "Choose heading level", table: "Choose table size", image: "Insert image", more: "More formatting and inserts",
};

export interface ToolbarOptions {
  readonly enabled?: boolean;
  /** Additional classes on the toolbar root. */
  readonly className?: string;
  /** Ordered groups of command IDs. Use toolbar.open-* for the built-in pickers. */
  readonly groups?: readonly (readonly string[])[];
  /** Return a fresh node for each button or undefined to use the built-in icon. */
  readonly renderIcon?: (command: string, document: Document) => Node | undefined;
}

const keepViewport = { preserveViewport: true } as const;

/** Optional command buttons and pickers above the editor's content panes. */
export function createToolbarPlugin(options: ToolbarOptions = {}): MarkdownEditorPlugin {
  const groups = options.groups ?? defaultGroups;
  const all = groups.flat();
  if (new Set(all).size !== all.length) throw new Error("duplicate editor toolbar command");
  const moreGroups = defaultMoreGroups.map(group => ({
    ...group,
    commands: group.commands.filter(id => id !== "insert.image" || !all.includes("toolbar.open-image")),
  }));
  const moreCommands = moreGroups.flatMap(group => group.commands);
  return {
    id: "toolbar",
    enabled: options.enabled ?? true,
    activate(editor) {
      const { i18n } = editor;
      const root = editor.inputPane.parentElement!;
      const document = root.ownerDocument;
      const viewport = document.defaultView;
      const toolbar = document.createElement("div");
      toolbar.className = "jot-editor-toolbar";
      if (options.className?.trim()) toolbar.classList.add(...options.className.trim().split(/\s+/u));
      toolbar.setAttribute("role", "toolbar");
      i18n.bind(toolbar, "aria-label", "Markdown toolbar");
      const status = document.createElement("span");
      status.className = "jot-editor-toolbar__status";
      status.setAttribute("role", "status");
      status.hidden = true;
      let activePicker: { readonly panel: HTMLElement; readonly trigger: HTMLButtonElement } | undefined;
      let tabStop: HTMLButtonElement | undefined;

      function commandIcon(id: string): Node | undefined {
        const name = Object.hasOwn(icons, id) ? icons[id] : undefined;
        return options.renderIcon?.(id, document) ?? (name && toolbarIcon(document, name));
      }

      function shortcutLabel(id: string): string | undefined {
        const key = editor.commands.shortcuts.find(binding => binding.command === id)?.key;
        const platform = editor.commands.shortcutPlatform;
        const mac = platform === undefined ? /Mac|iPhone|iPad/u.test(viewport?.navigator.platform ?? "") : platform === "mac";
        return key === undefined ? undefined : displayShortcut(key, mac);
      }

      const controls = groups.map((actions) => {
        const group = document.createElement("div");
        group.className = "jot-editor-toolbar__group";
        const buttons = actions.map((id) => {
          const button = document.createElement("button");
          button.type = "button";
          button.tabIndex = -1;
          button.className = "jot-editor-toolbar__button";
          button.dataset["jotToolbarCommand"] = id;
          const icon = commandIcon(id);
          const label = icon === undefined ? document.createElement("span") : undefined;
          if (icon !== undefined) button.append(icon);
          else if (label !== undefined) button.append(label);
          const picker = Object.hasOwn(pickerTypes, id) ? pickerTypes[id as keyof typeof pickerTypes] : undefined;
          if (picker !== undefined) {
            const arrow = toolbarIcon(document, "chevron-down");
            arrow.classList.add("jot-editor-toolbar__chevron");
            button.append(arrow);
            const menu = picker === "heading" || picker === "more";
            button.setAttribute("aria-haspopup", menu ? "menu" : "dialog");
            button.setAttribute("aria-expanded", "false");
            if (menu) button.addEventListener("keydown", event => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp" || event.isComposing) return;
              event.preventDefault();
              if (editor.commands.command(id)) editor.executeCommand(id);
              else openPicker(picker, button);
              if (event.key === "ArrowUp") {
                const enabled = activePicker?.panel.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
                enabled?.[enabled.length - 1]?.focus();
              }
            });
          }
          button.addEventListener("mousedown", (event) => {
            if (event.button === 0) event.preventDefault();
          });
          button.addEventListener("click", (event) => {
            const editing = requiresEdit(id);
            if (!isAvailable(editing) || button.hidden) return;
            event.preventDefault();
            if (picker !== undefined) {
              if (editor.commands.command(id)) editor.executeCommand(id);
              else openPicker(picker, button);
              return;
            }
            closePicker();
            void run(editing, async () => {
              if (id === "search.open" && editor.inputPane.hidden) await editor.setMode("live-preview");
              return editor.executeCommand(id, undefined, keepViewport);
            });
          });
          group.append(button);
          return { id, button, picker, label };
        });
        toolbar.append(group);
        return { group, buttons };
      });
      toolbar.append(status);
      const buttons = controls.flatMap(group => group.buttons.map(entry => entry.button));

      function available(button: HTMLButtonElement): boolean {
        return !button.hidden && !button.disabled;
      }

      function setTabStop(button: HTMLButtonElement | undefined): void {
        if (tabStop === button) return;
        if (tabStop !== undefined) tabStop.tabIndex = -1;
        tabStop = button;
        if (tabStop !== undefined) tabStop.tabIndex = 0;
      }

      toolbar.addEventListener("focusin", event => {
        const button = event.target as HTMLButtonElement;
        if (buttons.includes(button)) setTabStop(button);
      });
      toolbar.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const enabled = buttons.filter(available);
        const index = enabled.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        const forward = getComputedStyle(toolbar).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
        const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
          : (index + (event.key === forward ? 1 : -1) + enabled.length) % enabled.length;
        event.preventDefault();
        enabled[next]!.focus({ preventScroll: true });
      });
      toolbar.addEventListener("focusout", event => {
        const picker = activePicker;
        if (!picker || toolbar.contains(event.relatedTarget as Node | null)) return;
        queueMicrotask(() => {
          if (activePicker === picker) closePicker();
        });
      });

      function requiresEdit(id: string): boolean {
        return Object.hasOwn(pickerTypes, id) ||
          (id !== "search.open" && editor.commands.command(id)?.requiresInput !== false);
      }

      function isAvailable(editing: boolean): boolean {
        return editing ? editor.canEdit : root.hasAttribute("data-jot-editor-ready");
      }

      async function run(editing: boolean, action: () => boolean | Promise<boolean>): Promise<void> {
        if (!isAvailable(editing)) return;
        status.hidden = true;
        try {
          if (editing) editor.focus();
          const handled = await action();
          if (!handled) showStatus("This action is unavailable at the current selection");
        } catch (error) {
          showStatus(error instanceof Error ? error.message : "Command failed");
        }
      }

      function showStatus(message: string): void {
        i18n.bind(status, "textContent", message);
        status.hidden = false;
      }

      function closePicker(): void {
        if (activePicker === undefined) return;
        const { panel, trigger } = activePicker;
        activePicker = undefined;
        viewport?.removeEventListener("resize", positionPicker);
        viewport?.removeEventListener("scroll", positionPicker, true);
        if (panel.matches(":popover-open")) panel.hidePopover();
        panel.remove();
        trigger.popoverTargetElement = null;
        trigger.setAttribute("aria-expanded", "false");
      }

      function openPicker(picker: Picker, trigger: HTMLButtonElement): void {
        if (activePicker?.trigger === trigger && activePicker.panel.matches(":popover-open")) {
          closePicker();
          trigger.focus({ preventScroll: true });
          return;
        }
        closePicker();
        status.hidden = true;
        const panel = document.createElement("div");
        panel.className = `jot-editor-toolbar__picker jot-editor-toolbar__picker--${picker}`;
        panel.popover = "auto";
        const menu = picker === "heading" || picker === "more";
        panel.setAttribute("role", menu ? "menu" : "dialog");
        i18n.bind(panel, "aria-label", pickerLabels[picker]);

        const apply = (action: () => boolean) => {
          closePicker();
          void run(true, action);
        };
        let first: HTMLElement | undefined;
        if (picker === "table") {
          first = createTablePicker(panel, i18n, (size) => apply(() => editor.insertTable(size, keepViewport)));
        } else if (picker === "image") {
          first = createImagePicker(panel, i18n, destination => apply(() => editor.insertImage({ destination }, keepViewport)),
            editor.input.canPickImageFiles ? () => apply(() => editor.executeCommand("insert.image", undefined, keepViewport)) : undefined);
        } else {
          const { doc, selection } = editor.input.view.state;
          const currentLevel = picker === "heading"
            ? /^ {0,3}(#{1,6})(?:\s|$)/u.exec(doc.lineAt(selection.main.from).text)?.[1]?.length ?? 0
            : undefined;
          const groups = picker === "heading" ? [{ title: "", commands: headingCommands }] : moreGroups;
          for (const group of groups) {
            let container = panel;
            if (group.title) {
              if (!group.commands.some(id => editor.commands.command(id))) continue;
              container = document.createElement("div");
              container.setAttribute("role", "group");
              i18n.bind(container, "aria-label", group.title);
              const title = document.createElement("div");
              title.className = "jot-editor-toolbar__section";
              title.setAttribute("aria-hidden", "true");
              i18n.bind(title, "textContent", group.title);
              container.append(title);
              panel.append(container);
            }
            for (const [index, commandId] of group.commands.entries()) {
              const command = editor.commands.command(commandId);
              if (command === undefined) continue;
              const choice = document.createElement("button");
              choice.type = "button";
              choice.dataset["jotToolbarChoice"] = commandId;
              choice.tabIndex = -1;
              choice.setAttribute("role", picker === "heading" ? "menuitemradio" : "menuitem");
              choice.disabled = !editor.canExecuteCommand(commandId);
              if (picker === "more") {
                const icon = commandIcon(commandId);
                if (icon) choice.append(icon);
              }
              const label = document.createElement("span");
              i18n.bind(label, "textContent", command.title);
              choice.append(label);
              const shortcut = shortcutLabel(commandId);
              if (shortcut) {
                const key = document.createElement("kbd");
                key.setAttribute("aria-label", shortcut);
                key.title = shortcut;
                key.textContent = shortcut.replace(/Command-/gu, "⌘").replace(/Option-/gu, "⌥")
                  .replace(/Control-/gu, "⌃").replace(/Shift-/gu, "⇧").replace(/Enter$/u, "↵");
                choice.append(key);
              }
              if (picker === "heading") {
                const level = commandId === "format.paragraph" ? 0 : index + 1;
                if (level !== 0) choice.dataset["jotHeadingLevel"] = String(level);
                choice.style.setProperty("--jot-toolbar-heading-size", `${level === 0 ? 14 : 28 - level * 2}px`);
                choice.setAttribute("aria-checked", String(level === currentLevel));
                if (level === currentLevel && !choice.disabled) {
                  choice.setAttribute("aria-current", "true");
                  first = choice;
                }
              }
              choice.addEventListener("click", () => apply(() => editor.executeCommand(commandId, undefined, keepViewport)));
              container.append(choice);
              if (!choice.disabled) first ??= choice;
            }
          }
        }
        activePicker = { panel, trigger };
        trigger.after(panel);
        trigger.popoverTargetElement = panel;
        panel.addEventListener("keydown", (event) => {
          if (event.isComposing) return;
          if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            const choices = [...panel.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];
            const index = choices.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
            event.preventDefault();
            choices[next]!.focus();
            return;
          }
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          closePicker();
          trigger.focus({ preventScroll: true });
        });
        panel.addEventListener("toggle", () => {
          if (activePicker?.panel === panel && !panel.matches(":popover-open")) closePicker();
        });
        panel.showPopover();
        positionPicker();
        viewport?.addEventListener("resize", positionPicker);
        viewport?.addEventListener("scroll", positionPicker, { capture: true, passive: true });
        trigger.setAttribute("aria-expanded", "true");
        first?.focus({ preventScroll: true });
      }

      function positionPicker(event?: Event): void {
        if (activePicker === undefined) return;
        const { panel, trigger } = activePicker;
        if (event?.target === panel) return;
        const anchor = trigger.getBoundingClientRect();
        const view = document.documentElement;
        const below = view.clientHeight - anchor.bottom - 12;
        const above = anchor.top - 12;
        const openBelow = panel.scrollHeight <= below || below >= above;
        panel.style.maxHeight = `${Math.max(0, openBelow ? below : above)}px`;
        const { width, height } = panel.getBoundingClientRect();
        const left = Math.min(Math.max(6, anchor.left), Math.max(6, view.clientWidth - width - 6));
        panel.style.left = `${left}px`;
        panel.style.top = `${openBelow ? anchor.bottom + 6 : Math.max(6, anchor.top - height - 6)}px`;
      }

      function refresh(): void {
        for (const { group, buttons } of controls) {
          for (const { id, button, picker, label } of buttons) {
            const command = editor.commands.command(id);
            const choices = picker === "heading" ? headingCommands : picker === "more" ? moreCommands : undefined;
            const available = choices?.some((choice) => editor.commands.command(choice) !== undefined) ??
              (picker === "table" || picker === "image" ? editor.commands.command(`insert.${picker}`) !== undefined : command !== undefined);
            const title = i18n.t(command?.title ?? (picker === undefined ? id : pickerLabels[picker]));
            const shortcut = shortcutLabel(id);
            button.hidden = !available;
            button.title = shortcut === undefined ? title : `${title} · ${shortcut}`;
            button.setAttribute("aria-label", title);
            if (label !== undefined) label.textContent = title;
            button.disabled = !isAvailable(requiresEdit(id));
          }
          group.hidden = buttons.every(({ button }) => button.hidden);
        }
        toolbar.hidden = controls.every(({ group }) => group.hidden);
        root.classList.toggle("jot-markdown-editor--with-toolbar", !toolbar.hidden);
        if (activePicker?.trigger.disabled || activePicker?.trigger.hidden) closePicker();
        if (tabStop === undefined || !available(tabStop)) setTabStop(buttons.find(available));
      }

      const actionCleanups: (() => void)[] = [];
      try {
        actionCleanups.push(editor.registerFocusTarget("focus.toolbar", toolbar, () => {
          if (toolbar.hidden) return undefined;
          closePicker();
          return tabStop !== undefined && available(tabStop) ? tabStop : buttons.find(available);
        }));
        for (const { buttons } of controls) {
          for (const { id, button, picker } of buttons) {
            if (picker === undefined) continue;
            actionCleanups.push(editor.registerCommandAction(id, () => {
              if (!editor.canEdit || button.hidden) return false;
              openPicker(picker, button);
              return true;
            }, () => editor.canEdit && !button.hidden));
          }
        }
      } catch (error) {
        for (const cleanup of actionCleanups) cleanup();
        throw error;
      }
      const observer = new MutationObserver(refresh);
      observer.observe(root, {
        attributeFilter: ["data-jot-editor-ready", "data-jot-editor-read-only", "data-jot-editor-mode"],
      });
      const unsubscribe = editor.commands.subscribe(refresh);
      const stopLocale = i18n.subscribe(() => { refresh(); if (activePicker) positionPicker(); });
      root.prepend(toolbar);
      refresh();
      return () => {
        closePicker();
        for (const cleanup of actionCleanups) cleanup();
        observer.disconnect();
        unsubscribe();
        stopLocale();
        toolbar.remove();
        root.classList.remove("jot-markdown-editor--with-toolbar");
      };
    },
  };
}
