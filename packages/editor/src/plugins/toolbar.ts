import { displayShortcut } from "../component/shortcut-settings.js";
import type { MarkdownEditorPlugin } from "./registry.js";
import { toolbarIcon, type ToolbarIcon } from "./toolbar-icons.js";
import { createTablePicker } from "./toolbar-pickers.js";

const headingCommands = [
  "format.heading-1", "format.heading-2", "format.heading-3",
  "format.heading-4", "format.heading-5", "format.heading-6", "format.paragraph",
] as const;

const moreCommands = [
  "format.strikethrough", "format.task-list", "format.math",
  "insert.image", "insert.code-block", "insert.math-block", "insert.thematic-break",
] as const;

const defaultGroups = [
  ["history.undo", "history.redo"],
  ["toolbar.open-heading", "format.bold", "format.italic", "format.code", "format.link"],
  ["format.bullet-list", "format.ordered-list", "format.quote", "toolbar.open-table", "toolbar.open-more"],
  ["search.open", "command.palette"],
] as const;

const icons: Readonly<Record<string, ToolbarIcon>> = {
  "history.undo": "arrow-back-up", "history.redo": "arrow-forward-up",
  "toolbar.open-heading": "heading", "format.bold": "bold", "format.italic": "italic",
  "format.code": "code", "format.link": "link", "toolbar.open-table": "table",
  "format.bullet-list": "list", "format.ordered-list": "list-numbers", "format.quote": "quote",
  "toolbar.open-more": "dots", "search.open": "search", "command.palette": "command",
};

const pickerTypes = {
  "toolbar.open-heading": "heading",
  "toolbar.open-table": "table",
  "toolbar.open-more": "more",
} as const;
type Picker = typeof pickerTypes[keyof typeof pickerTypes];
const pickerLabels: Readonly<Record<Picker, string>> = {
  heading: "选择标题级别", table: "选择表格尺寸", more: "更多格式和插入",
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
  return {
    id: "toolbar",
    enabled: options.enabled ?? true,
    activate(editor) {
      const root = editor.inputPane.parentElement!;
      const document = root.ownerDocument;
      const viewport = document.defaultView;
      const toolbar = document.createElement("div");
      toolbar.className = "jot-editor-toolbar";
      if (options.className?.trim()) toolbar.classList.add(...options.className.trim().split(/\s+/u));
      toolbar.setAttribute("role", "group");
      toolbar.setAttribute("aria-label", "Markdown 工具栏");
      const status = document.createElement("span");
      status.className = "jot-editor-toolbar__status";
      status.setAttribute("role", "status");
      status.hidden = true;
      let activePicker: { readonly panel: HTMLElement; readonly trigger: HTMLButtonElement } | undefined;

      const controls = groups.map((actions) => {
        const group = document.createElement("div");
        group.className = "jot-editor-toolbar__group";
        const buttons = actions.map((id) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "jot-editor-toolbar__button";
          button.dataset["jotToolbarCommand"] = id;
          const builtIn = Object.hasOwn(icons, id) ? icons[id] : undefined;
          const icon = options.renderIcon?.(id, document) ?? (builtIn === undefined ? undefined : toolbarIcon(document, builtIn));
          const label = icon === undefined ? document.createElement("span") : undefined;
          if (icon !== undefined) button.append(icon);
          else if (label !== undefined) button.append(label);
          const picker = Object.hasOwn(pickerTypes, id) ? pickerTypes[id as keyof typeof pickerTypes] : undefined;
          if (picker !== undefined) {
            const arrow = toolbarIcon(document, "chevron-down");
            arrow.classList.add("jot-editor-toolbar__chevron");
            button.append(arrow);
            button.setAttribute("aria-haspopup", "dialog");
            button.setAttribute("aria-expanded", "false");
          }
          button.addEventListener("mousedown", (event) => {
            if (event.button === 0) event.preventDefault();
          });
          button.addEventListener("click", (event) => {
            const editing = requiresEdit(id);
            if (!isAvailable(editing) || button.hidden) return;
            event.preventDefault();
            if (picker !== undefined) {
              openPicker(picker, button);
              return;
            }
            closePicker();
            void run(editing, () => id === "search.open" && editor.inputPane.hidden
              ? editor.openSearch()
              : editor.executeCommand(id, undefined, keepViewport));
          });
          group.append(button);
          return { id, button, picker, label };
        });
        toolbar.append(group);
        return { group, buttons };
      });
      toolbar.append(status);

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
          if (!handled) showStatus("当前选区无法执行此操作");
        } catch (error) {
          showStatus(error instanceof Error ? error.message : "命令执行失败");
        }
      }

      function showStatus(message: string): void {
        status.textContent = message;
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
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", trigger.getAttribute("aria-label") ?? "编辑工具");

        const apply = (action: () => boolean) => {
          closePicker();
          void run(true, action);
        };
        let first: HTMLElement | undefined;
        if (picker === "table") {
          first = createTablePicker(panel, (size) => apply(() => editor.insertTable(size, keepViewport)));
        } else {
          const { doc, selection } = editor.input.view.state;
          const currentLevel = picker === "heading"
            ? /^ {0,3}(#{1,6})(?:\s|$)/u.exec(doc.lineAt(selection.main.from).text)?.[1]?.length ?? 0
            : undefined;
          const choices = picker === "heading" ? headingCommands : moreCommands;
          for (const [index, commandId] of choices.entries()) {
            const command = editor.commands.command(commandId);
            if (command === undefined) continue;
            const choice = document.createElement("button");
            choice.type = "button";
            choice.dataset["jotToolbarChoice"] = commandId;
            choice.textContent = command.title;
            if (picker === "heading") {
              const level = commandId === "format.paragraph" ? 0 : index + 1;
              if (level !== 0) choice.dataset["jotHeadingLevel"] = String(level);
              choice.style.setProperty("--jot-toolbar-heading-size", `${level === 0 ? 14 : 28 - level * 2}px`);
              if (level === currentLevel) {
                choice.setAttribute("aria-current", "true");
                first = choice;
              }
            }
            choice.addEventListener("click", () => apply(() => editor.executeCommand(commandId, undefined, keepViewport)));
            panel.append(choice);
            first ??= choice;
          }
        }
        activePicker = { panel, trigger };
        trigger.after(panel);
        trigger.popoverTargetElement = panel;
        panel.addEventListener("keydown", (event) => {
          if (event.key !== "Escape" || event.isComposing) return;
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
        const shortcuts = new Map(editor.commands.shortcuts.map((shortcut) => [shortcut.command, shortcut.key]));
        const shortcutPlatform = editor.commands.shortcutPlatform;
        const mac = shortcutPlatform === undefined
          ? /Mac|iPhone|iPad/u.test(viewport?.navigator.platform ?? "")
          : shortcutPlatform === "mac";
        for (const { group, buttons } of controls) {
          for (const { id, button, picker, label } of buttons) {
            const command = editor.commands.command(id);
            const choices = picker === "heading" ? headingCommands : picker === "more" ? moreCommands : undefined;
            const available = choices?.some((choice) => editor.commands.command(choice) !== undefined) ??
              (picker === "table" ? editor.commands.command("insert.table") !== undefined : command !== undefined);
            const title = command?.title ?? (picker === undefined ? id : pickerLabels[picker]);
            const shortcut = shortcuts.get(id);
            button.hidden = !available;
            button.title = shortcut === undefined ? title : `${title} · ${displayShortcut(shortcut, mac)}`;
            button.setAttribute("aria-label", title);
            if (label !== undefined) label.textContent = title;
            button.disabled = !isAvailable(requiresEdit(id));
          }
          group.hidden = buttons.every(({ button }) => button.hidden);
        }
        toolbar.hidden = controls.every(({ group }) => group.hidden);
        root.classList.toggle("jot-markdown-editor--with-toolbar", !toolbar.hidden);
        if (activePicker?.trigger.disabled || activePicker?.trigger.hidden) closePicker();
      }

      const actionCleanups: (() => void)[] = [];
      try {
        for (const { buttons } of controls) {
          for (const { id, button, picker } of buttons) {
            if (picker === undefined) continue;
            actionCleanups.push(editor.registerCommandAction(id, () => {
              if (!editor.canEdit || button.hidden) return false;
              openPicker(picker, button);
              return true;
            }));
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
      root.prepend(toolbar);
      refresh();
      return () => {
        closePicker();
        for (const cleanup of actionCleanups) cleanup();
        observer.disconnect();
        unsubscribe();
        toolbar.remove();
        root.classList.remove("jot-markdown-editor--with-toolbar");
      };
    },
  };
}
