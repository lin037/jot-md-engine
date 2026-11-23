import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

// CodeMirror's default-height probe picks a short ASCII text line from the
// viewport. A styled code line or heading can have a different font, line
// height and padding from the document's ordinary text. A neutral mark makes
// that line a non-text tile for the probe, so CM uses its own representative
// undecorated measurement line instead. It does not alter source or layout.
const neutralMetricMark = Decoration.mark({ attributes: { "data-jot-metric-guard": "" } });
const blankMetricMark = Decoration.mark({ attributes: { "data-jot-metric-guard": "", "data-jot-blank-text": "" } });

function visibleMetricGuards(view: EditorView): DecorationSet {
  const decorations = [];
  const seen = new Set<number>();
  for (const range of view.visibleRanges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      const line = view.state.doc.line(number);
      if (seen.has(line.from) || line.from < range.from || line.to > range.to || line.length === 0) continue;
      const blank = /^[ \t]+$/u.test(line.text);
      if (!blank && (line.length > 20 || /[^ -~]/u.test(line.text))) continue;
      seen.add(line.from);
      decorations.push((blank ? blankMetricMark : neutralMetricMark).range(line.from, line.to));
    }
  }
  return Decoration.set(decorations, true);
}

export function createStableMetricGuard(isEnabled: () => boolean): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    #enabled: boolean;
    constructor(view: EditorView) {
      this.#enabled = isEnabled();
      this.decorations = this.#enabled ? visibleMetricGuards(view) : Decoration.none;
    }
    update(update: ViewUpdate): void {
      const enabled = isEnabled();
      if (enabled !== this.#enabled || update.docChanged || update.viewportChanged) {
        this.#enabled = enabled;
        this.decorations = enabled ? visibleMetricGuards(update.view) : Decoration.none;
      }
    }
  }, { decorations: value => value.decorations });
}
