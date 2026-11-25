import { editorI18nAt } from "../../core/i18n.js";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { EditorImage, SaveEditorImage } from "../../core/commands/index.js";

interface PendingImages {
  from: number;
  to: number;
  readonly controller: AbortController;
  readonly source: "picker" | "paste";
  images?: readonly EditorImage[];
}

/** Keep a paste or file pick attached to its original selection while storage is pending. */
export class ImageInput {
  readonly #pending: PendingImages[] = [];
  #applying: PendingImages | undefined;

  constructor(
    private readonly save: SaveEditorImage,
    private readonly insert: (entry: PendingImages, images: readonly EditorImage[]) => boolean,
    private readonly composing: () => boolean,
    private readonly onError: (error: unknown) => void,
  ) {}

  paste(event: ClipboardEvent, view: EditorView): boolean {
    const data = event.clipboardData;
    if (!data || !this.#accepts(view)) return false;
    const files = Array.from(data.files).filter(file => file.type.startsWith("image/"));
    if (!files.length) {
      for (const item of Array.from(data.items)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return false;
    event.preventDefault();
    void this.#save(this.#capture(view, "paste"), files, view);
    return true;
  }

  pick(view: EditorView, selection: { anchor: number; head: number }): boolean {
    if (view.state.readOnly || view.composing) return false;
    const picker = view.dom.ownerDocument.createElement("input");
    picker.type = "file";
    picker.accept = "image/*";
    picker.multiple = true;
    picker.hidden = true;
    const entry = this.#capture(view, "picker", selection);
    const removePicker = () => picker.remove();
    entry.controller.signal.addEventListener("abort", removePicker, { once: true });
    picker.onchange = () => {
      const files = Array.from(picker.files ?? []);
      removePicker();
      entry.controller.signal.removeEventListener("abort", removePicker);
      void this.#save(entry, files, view);
    };
    picker.oncancel = () => { entry.controller.abort(); this.drain(view); };
    view.dom.append(picker);
    try { picker.click(); }
    catch (error) { entry.controller.abort(); this.drain(view); throw error; }
    return true;
  }

  #accepts(view: EditorView): boolean {
    return !view.state.readOnly && !view.composing && view.state.selection.ranges.length === 1;
  }

  #capture(view: EditorView, source: PendingImages["source"], selection: { anchor: number; head: number } = view.state.selection.main): PendingImages {
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    const entry = { from, to, source, controller: new AbortController() };
    this.#pending.push(entry);
    return entry;
  }

  async #save(entry: PendingImages, files: readonly File[], view: EditorView): Promise<void> {
    const { signal } = entry.controller;
    if (signal.aborted) return;
    try {
      const images = await Promise.all(files.map(async file => {
        const image = await this.save(file, { source: entry.source, signal });
        return { ...image, alt: image.alt ?? file.name };
      }));
      entry.images = images;
    } catch (error) {
      if (!signal.aborted) { entry.controller.abort(); this.onError(error); }
    } finally {
      this.drain(view);
    }
  }

  update(update: ViewUpdate): void {
    if (!this.#pending.length) return;
    if (update.state.readOnly) { this.cancel(); return; }
    if (!update.docChanged) return;
    for (const entry of this.#pending) {
      const { from, to } = entry;
      if (this.#applying?.from === from && this.#applying.to === to) {
        // Two pastes at the same original selection replace its text once.
        entry.from = entry.to = update.changes.mapPos(to, 1);
        continue;
      }
      update.changes.iterChangedRanges((start, end) => {
        if ((start < to && end > from) ||
            (end > start && start === 0 && end === update.startState.doc.length)) entry.controller.abort();
      });
      // Typing at a collapsed paste anchor remains after the pending image.
      entry.from = update.changes.mapPos(from, from < to ? 1 : -1);
      entry.to = from === to ? entry.from : update.changes.mapPos(to, -1);
    }
    if (this.#pending[0]?.controller.signal.aborted) queueMicrotask(() => this.drain(update.view));
  }

  drain(view: EditorView): void {
    while (this.#pending.length) {
      const first = this.#pending[0]!;
      if (!first.controller.signal.aborted && (first.images === undefined || view.composing || this.composing())) return;
      this.#pending.shift();
      if (!first.controller.signal.aborted && first.images?.length && !view.state.readOnly) {
        this.#applying = first;
        try {
          if (!this.insert(first, first.images)) throw new Error(editorI18nAt(view.dom).t("Cannot insert an image at this selection"));
        } catch (error) {
          this.onError(error);
        } finally {
          this.#applying = undefined;
        }
      }
    }
  }

  cancel(): void {
    for (const entry of this.#pending.splice(0)) entry.controller.abort();
  }
}
