import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownKeymap } from "@codemirror/lang-markdown";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorView, KeyBinding } from "@codemirror/view";
import type { EditorDocumentAdapter } from "../../adapter/document-adapter.js";
import { quotePrefix } from "../../components/common/quote-prefix.js";
import { allowsUnspacedFenceLanguage, codeFenceCloser, confirmedPrefixMarkerRisks,
  matchesCodeFenceCloser, standaloneMarker } from "../shared/markdown-markers.js";
import { sourceSnapshot } from "../shared/source-snapshot.js";

export function completeCodeFence(view: EditorView, adapter: EditorDocumentAdapter): boolean {
  const { state } = view;
  const { main, ranges } = state.selection;
  if (state.readOnly || view.composing || !main.empty || ranges.length !== 1) return false;
  const line = state.doc.lineAt(main.head);
  if (main.head !== line.to ||
      !/^ {0,3}(?:`{3}|~{3})/u.test(state.doc.sliceString(line.from, Math.min(line.to, line.from + 6)))) return false;
  const marker = standaloneMarker(line.text);
  if (marker === undefined) return false;
  const allowUnspaced = allowsUnspacedFenceLanguage(adapter.syntaxProfile);
  const closer = codeFenceCloser(marker, allowUnspaced);
  if (closer === undefined || (closer.startsWith("~") && marker.slice(closer.length).includes("~"))) return false;

  const source = sourceSnapshot(view);
  const block = adapter.confirmedBlockAt(source, line.from + 1);
  if (block?.kind === "fenced-code" && block.sourceRange.from === line.from) {
    const first = state.doc.line(line.number + 1);
    if (first.length === 0) {
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true, userEvent: "select.keyboard" });
      return true;
    }
  }
  if (block !== undefined) {
    if (block.kind !== "paragraph" || block.sourceRange.from !== line.from) return false;
  } else {
    // Enter can outrun the Worker. A marker-free prefix is unambiguous. For
    // other prefixes reuse confirmed ownership so a literal line in an outer
    // code or math block can never create another pair.
    const prefix = source.slice(0, line.from);
    if (/(?:^|\n) {0,3}(?:`{3}|~{3}|\$\$|\\\[)| {2}\n$/u.test(prefix)) {
      const confirmed = adapter.text.text;
      if (!confirmed.startsWith(prefix) || confirmedPrefixMarkerRisks(confirmed, adapter.blocks, line.from,
          adapter.projection.totalChildren("0", "syntax-children"), allowUnspaced, true) !== 0) return false;
    }
    if (source.indexOf(closer.slice(0, 3), line.to + 1) >= 0) {
      for (const text of state.doc.iterLines(line.number + 1)) {
        const candidate = standaloneMarker(text);
        if (candidate !== undefined && matchesCodeFenceCloser(closer, candidate)) return false;
      }
    }
  }
  const indent = line.text.slice(0, line.text.indexOf(marker));
  const insert = state.update({
    changes: { from: line.to, insert: state.lineBreak + state.lineBreak + indent + closer },
    selection: { anchor: line.to + 1 }, scrollIntoView: true,
    userEvent: "input.code.fence", annotations: isolateHistory.of("full"),
  });
  if (!insert.docChanged) return false;
  // CM otherwise reconstructs the redo caret by mapping the original caret
  // past the entire insert. Record the body selection in the same view update.
  view.dispatch([insert, insert.state.update({ selection: insert.newSelection })]);
  return true;
}

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
