import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownKeymap } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { KeyBinding } from "@codemirror/view";
import { quotePrefix } from "../../components/common/quote-prefix.js";

export const markdownEditingKeymap = markdownKeymap.map<KeyBinding>((binding) => {
  const run = binding.run;
  if (run !== insertNewlineContinueMarkup && run !== deleteMarkupBackward) return binding;
  return {
    ...binding,
    run(view) {
      const { state } = view;
      const { main, ranges } = state.selection;
      if (!main.empty || ranges.length !== 1) return run(view);
      const mark = syntaxTree(state).resolveInner(main.head, -1);
      if (mark.name !== "ListMark" || mark.to !== main.head) return run(view);
      const line = state.doc.lineAt(main.head);
      if (mark.to !== line.to) return run(view);
      const quote = quotePrefix(line.text, 0, Number.POSITIVE_INFINITY);
      const prefixEnd = quote?.to ?? 0;
      if (!/^[\t ]*$/u.test(line.text.slice(prefixEnd, mark.from - line.from))) return run(view);

      // A marker alone on its physical line has no list separator. Let the
      // ordinary bindings edit it, carrying only the surrounding quote on Enter.
      if (state.readOnly || run === deleteMarkupBackward || quote === undefined) return false;
      const insert = state.lineBreak + line.text.slice(0, prefixEnd);
      const changes = state.changes({ from: main.head, insert });
      view.dispatch({ changes, selection: { anchor: changes.mapPos(main.head, 1) },
        scrollIntoView: true, userEvent: "input" });
      return true;
    },
  };
});
