import { editorI18nAt } from "../../core/i18n.js";
import type { EditorView } from "@codemirror/view";

export interface LivePreviewTableInputCallbacks {
  readonly onImagePaste?: (event: ClipboardEvent) => boolean;
  readonly onBeforeInput: (inputType: string, data: string | undefined) => boolean;
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
  readonly onCompositionCommit: (text: string) => void;
}

/**
 * Browser input owner for a mapped table cell.
 *
 * CodeMirror remains the only owner of committed text, selection and history.
 * This textarea is focused while a projected cell is active so that a desktop
 * IME chooses the correct event target before `compositionstart`. It stores
 * only the browser's uncommitted composition string and forwards one final
 * transaction to CodeMirror.
 */
export class LivePreviewTableImeSurface {
  readonly #view: EditorView;
  readonly #element: HTMLTextAreaElement;
  readonly #callbacks: LivePreviewTableInputCallbacks;
  readonly #onViewportChange = (): void => this.#schedulePosition();
  #cell: HTMLElement | undefined;
  #active = false;
  #composing = false;
  #latestText = "";
  #suppressCommittedInput = false;
  #suppressPasteInput = false;
  #cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  #positionFrame: number | undefined;

  constructor(view: EditorView, callbacks: LivePreviewTableInputCallbacks) {
    this.#view = view;
    this.#callbacks = callbacks;
    const element = view.dom.ownerDocument.createElement("textarea");
    element.className = "jot-live-preview-table-ime";
    element.rows = 1;
    element.wrap = "off";
    element.tabIndex = -1;
    element.spellcheck = false;
    element.autocomplete = "off";
    element.setAttribute("autocapitalize", "off");
    element.setAttribute("autocorrect", "off");
    editorI18nAt(view.dom).bind(element, "aria-label", "Table cell input");
    element.addEventListener("compositionstart", this.#onCompositionStart);
    element.addEventListener("compositionupdate", this.#onCompositionUpdate);
    element.addEventListener("compositionend", this.#onCompositionEnd);
    element.addEventListener("beforeinput", this.#onBeforeInput);
    element.addEventListener("input", this.#onInput);
    element.addEventListener("keydown", this.#onKeyDown);
    element.addEventListener("paste", this.#onPaste);
    element.addEventListener("blur", this.#onBlur);
    view.dom.addEventListener("scroll", this.#onViewportChange, true);
    view.dom.ownerDocument.defaultView?.addEventListener("resize", this.#onViewportChange);
    view.dom.append(element);
    this.#element = element;
  }

  get active(): boolean {
    return this.#active;
  }

  get composing(): boolean {
    return this.#composing;
  }

  get focused(): boolean {
    return this.#element.ownerDocument.activeElement === this.#element;
  }

  owns(target: EventTarget | null): boolean {
    return target === this.#element;
  }

  /** Focus before the first composition event; never call this from compositionstart. */
  focus(cell: HTMLElement): boolean {
    if (!cell.isConnected) return false;
    this.#active = true;
    this.#cell = cell;
    this.#element.classList.add("jot-live-preview-table-ime--active");
    this.#positionAtCaret(cell);
    if (!this.#composing) {
      this.#latestText = "";
      this.#element.value = "";
    }
    if (!this.focused) this.#element.focus({ preventScroll: true });
    const end = this.#element.value.length;
    this.#element.setSelectionRange(end, end);
    this.#schedulePosition();
    if (this.focused) return true;
    this.#deactivate(false);
    return false;
  }

  /** Keep an already-active input session attached to the newest keyed cell shell. */
  retarget(cell: HTMLElement): void {
    if (!this.#active || !cell.isConnected) return;
    this.#cell = cell;
    this.#positionAtCaret(cell);
    this.#schedulePosition();
  }

  cancel(): void {
    this.#clearCleanupTimer();
    this.#deactivate(true);
  }

  dispose(): void {
    this.cancel();
    this.#cancelPosition();
    this.#element.removeEventListener("compositionstart", this.#onCompositionStart);
    this.#element.removeEventListener("compositionupdate", this.#onCompositionUpdate);
    this.#element.removeEventListener("compositionend", this.#onCompositionEnd);
    this.#element.removeEventListener("beforeinput", this.#onBeforeInput);
    this.#element.removeEventListener("input", this.#onInput);
    this.#element.removeEventListener("keydown", this.#onKeyDown);
    this.#element.removeEventListener("paste", this.#onPaste);
    this.#element.removeEventListener("blur", this.#onBlur);
    this.#view.dom.removeEventListener("scroll", this.#onViewportChange, true);
    this.#view.dom.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.#onViewportChange,
    );
    this.#element.remove();
  }

  readonly #onCompositionStart = (event: CompositionEvent): void => {
    event.stopPropagation();
    if (!this.#active) return;
    this.#clearCleanupTimer();
    this.#composing = true;
    this.#suppressCommittedInput = false;
    this.#latestText = event.data ?? "";
  };

  readonly #onCompositionUpdate = (event: CompositionEvent): void => {
    event.stopPropagation();
    if (!this.#active) return;
    this.#latestText = event.data ?? this.#element.value;
  };

  readonly #onCompositionEnd = (event: CompositionEvent): void => {
    event.stopPropagation();
    if (!this.#active) return;
    this.#composing = false;
    const committed = typeof event.data === "string"
      ? event.data
      : this.#latestText || this.#element.value;
    // Blink/WebKit may emit insertFromComposition immediately afterwards.
    // Commit here exactly once, then consume that native echo on the same sink.
    this.#suppressCommittedInput = true;
    if (committed.length > 0) this.#callbacks.onCompositionCommit(committed);
    this.#scheduleCleanup();
  };

  readonly #onBeforeInput = (event: InputEvent): void => {
    event.stopPropagation();
    if (!this.#active) {
      event.preventDefault();
      return;
    }
    if (
      this.#composing || event.isComposing ||
      event.inputType === "insertCompositionText" ||
      event.inputType === "deleteCompositionText"
    ) {
      // The native textarea must retain the uncommitted string for the OS IME.
      return;
    }
    if (
      this.#suppressCommittedInput ||
      (this.#suppressPasteInput && event.inputType === "insertFromPaste")
    ) {
      event.preventDefault();
      return;
    }
    this.#callbacks.onBeforeInput(event.inputType, inputData(event));
    // Committed state belongs to CodeMirror, never to this input sink.
    event.preventDefault();
    this.#element.value = "";
  };

  readonly #onInput = (event: Event): void => {
    event.stopPropagation();
    if (!this.#active) return;
    const input = event as InputEvent;
    if (this.#composing || input.isComposing) {
      this.#latestText = input.data ?? this.#element.value;
      return;
    }
    // A non-cancelable final input can still arrive after compositionend. Its
    // content was already committed above, so only clear the transient value.
    if (this.#suppressCommittedInput || this.#suppressPasteInput) {
      this.#scheduleCleanup();
      return;
    }
    this.#element.value = "";
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (!this.#active || this.#composing || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (this.#callbacks.onKeyDown(event)) event.preventDefault();
  };

  readonly #onPaste = (event: ClipboardEvent): void => {
    event.stopPropagation();
    if (!this.#active || this.#composing) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!this.#callbacks.onImagePaste?.(event)) this.#callbacks.onBeforeInput("insertFromPaste", text);
    this.#suppressPasteInput = true;
    event.preventDefault();
    this.#scheduleCleanup();
  };

  readonly #onBlur = (): void => {
    queueMicrotask(() => {
      if (
        this.#active && !this.#composing &&
        this.#element.ownerDocument.activeElement !== this.#element
      ) {
        this.#deactivate(false);
      }
    });
  };

  #scheduleCleanup(): void {
    this.#clearCleanupTimer();
    this.#cleanupTimer = setTimeout(() => {
      this.#cleanupTimer = undefined;
      this.#latestText = "";
      this.#suppressCommittedInput = false;
      this.#suppressPasteInput = false;
      this.#element.value = "";
      if (this.#active && this.focused) this.#schedulePosition();
    }, 0);
  }

  #clearCleanupTimer(): void {
    if (this.#cleanupTimer === undefined) return;
    clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
  }

  #schedulePosition(): void {
    if (!this.#active || this.#positionFrame !== undefined) return;
    const requestFrame = this.#view.dom.ownerDocument.defaultView?.requestAnimationFrame;
    if (requestFrame === undefined) {
      if (this.#cell?.isConnected === true) this.#positionAtCaret(this.#cell);
      return;
    }
    this.#positionFrame = requestFrame(() => {
      this.#positionFrame = undefined;
      if (this.#active && this.#cell?.isConnected === true) {
        this.#positionAtCaret(this.#cell);
      }
    });
  }

  #cancelPosition(): void {
    if (this.#positionFrame === undefined) return;
    this.#view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.#positionFrame);
    this.#positionFrame = undefined;
  }

  #positionAtCaret(cell: HTMLElement): void {
    const rootRect = this.#view.dom.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const styles = cell.ownerDocument.defaultView?.getComputedStyle(cell);
    const inlineStart = cssPixels(
      cell.style.getPropertyValue("--jot-live-table-caret-inline-start"),
    );
    const blockStart = cssPixels(
      cell.style.getPropertyValue("--jot-live-table-caret-block-start"),
    );
    const lineHeight = cssPixels(
      cell.style.getPropertyValue("--jot-live-table-caret-height"),
    ) || cssPixels(styles?.lineHeight) || cssPixels(styles?.fontSize) || 16;
    const left = Math.max(0, cellRect.left - rootRect.left + inlineStart);
    const top = Math.max(0, cellRect.top - rootRect.top + blockStart);
    this.#element.style.left = `${left}px`;
    this.#element.style.top = `${top}px`;
    this.#element.style.width = "1px";
    this.#element.style.height = `${Math.max(1, lineHeight)}px`;
    this.#element.style.font = styles?.font ?? "inherit";
    this.#element.style.lineHeight = `${Math.max(1, lineHeight)}px`;
    this.#element.style.letterSpacing = styles?.letterSpacing ?? "normal";
  }

  #deactivate(blur: boolean): void {
    // A delayed post-composition cleanup belongs to the old focus session.
    // Never let it tear down a cell that has already been reactivated.
    this.#clearCleanupTimer();
    this.#active = false;
    this.#composing = false;
    this.#cell = undefined;
    this.#latestText = "";
    this.#suppressCommittedInput = false;
    this.#suppressPasteInput = false;
    this.#cancelPosition();
    if (blur && this.focused) this.#element.blur();
    this.#element.value = "";
    this.#element.classList.remove("jot-live-preview-table-ime--active");
    this.#element.removeAttribute("style");
  }
}

function inputData(event: InputEvent): string | undefined {
  if (event.inputType === "insertFromPaste") {
    return event.dataTransfer?.getData("text/plain") ?? event.data ?? undefined;
  }
  return event.data ?? undefined;
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
