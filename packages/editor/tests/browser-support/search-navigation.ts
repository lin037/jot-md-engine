import { search } from "@codemirror/search";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Record search selections that actually dispatched the host's centering effect. */
export function observeSearchScroll(view: EditorView) {
  const config = new Compartment();
  const ranges: number[][] = [];
  let requested: StateEffect<unknown> | undefined;
  view.dispatch({ effects: StateEffect.appendConfig.of(config.of([
    search({ scrollToMatch(range, target) {
      if (target !== view) throw new Error("search callback received another editor");
      requested = EditorView.scrollIntoView(range, { y: "center" });
      return requested;
    } }),
    EditorView.updateListener.of(update => {
      for (const tr of update.transactions) {
        if (requested && tr.effects.includes(requested)) {
          ranges.push([tr.newSelection.main.from, tr.newSelection.main.to]);
          requested = undefined;
        }
      }
    }),
  ])) });
  return { ranges, stop: () => view.dispatch({ effects: config.reconfigure([]) }) };
}
