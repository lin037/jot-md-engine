import { editorI18nAt } from "../../core/i18n.js";
import { isolateHistory } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { toggleTaskMarker } from "../../components/list-actions.js";
import { booleanAttribute } from "../../components/common/dom-renderer.js";
import type { ComponentLivePreviewWidget } from "../../components/contracts.js";

interface MarkerState { view: EditorView }
const owners = new WeakMap<HTMLInputElement, MarkerState>();

/** Checkbox is a view of the Rust-confirmed marker; CodeMirror owns the edit. */
export class TaskMarkerWidget extends WidgetType {
  readonly #from: number;
  readonly #checked: boolean;

  constructor(from: number, descriptor: ComponentLivePreviewWidget, private readonly toggle?: (from: number) => boolean) {
    super();
    this.#from = from;
    this.#checked = booleanAttribute(descriptor.node, "checked") === true;
  }

  eq(other: TaskMarkerWidget): boolean {
    return this.#from === other.#from && this.#checked === other.#checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = view.dom.ownerDocument.createElement("input");
    input.type = "checkbox";
    input.className = "jot-task-checkbox jot-live-preview-task-checkbox";
    editorI18nAt(view.dom).bind(input, "aria-label", "Task status");
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("change", () => {
      const state = owners.get(input);
      if (state === undefined) return;
      const { view: current } = state;
      if (!current.contentDOM.contains(input)) return;
      // Decorations can be mapped through local edits before the Worker has
      // produced a new descriptor. Resolve the live DOM boundary so a stale
      // stored offset can never toggle a different task after a prior insert.
      const from = current.posAtDOM(input, 0);
      const marker = current.state.doc.sliceString(from, Math.min(from + 3, current.state.doc.length));
      if (current.composing || current.state.facet(EditorState.readOnly) || !/^\[[ xX\t]\]$/u.test(marker)) {
        input.checked = marker[1] === "x" || marker[1] === "X";
        return;
      }
      const value = input.checked ? "x" : " ";
      if (marker[1] === value || (input.checked && marker[1] === "X")) return;
      if (this.toggle) {
        if (!this.toggle(from)) { input.checked = !input.checked; return; }
      } else {
        const result = toggleTaskMarker(marker, 0);
        const edit = result?.edits?.[0];
        if (!edit) return;
        current.dispatch({ changes: { from: from + edit.range.from, to: from + edit.range.to, insert: edit.insert },
          annotations: isolateHistory.of("full"), userEvent: result!.userEvent });
      }
      current.focus();
    });
    this.updateDOM(input, view);
    return input;
  }

  updateDOM(element: HTMLElement, view: EditorView): boolean {
    const input = element as HTMLInputElement;
    owners.set(input, { view });
    input.checked = this.#checked;
    input.disabled = view.state.facet(EditorState.readOnly);
    return true;
  }

  ignoreEvent(): boolean { return true; }
}
