import {
  closeSearchPanel,
  findNext as codeMirrorFindNext,
  findPrevious as codeMirrorFindPrevious,
  getSearchQuery,
  gotoLine,
  openSearchPanel,
  replaceAll as codeMirrorReplaceAll,
  replaceNext as codeMirrorReplaceNext,
  search,
  SearchQuery,
  selectNextOccurrence,
  setSearchQuery,
} from "@codemirror/search";
import { redo, undo } from "@codemirror/commands";
import { EditorView, runScopeHandlers, type Command, type Panel, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, Transaction, type Extension } from "@codemirror/state";
import { sameSearchPattern } from "../shared/search-pattern.js";

/** UTF-16 source search; decorations and virtualized DOM never become a search index. */
export interface EditorSearchQuery {
  readonly search: string;
  readonly replace?: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly regexp?: boolean;
  readonly literal?: boolean;
}

export function sourceSearch(): Extension {
  return [search({ createPanel: (view) => new SourceSearchPanel(view) }), searchTheme];
}

export function updateSourceSearch(view: EditorView, query: EditorSearchQuery): void {
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery(query)) });
}

export function openSourceSearch(view: EditorView, replace = false): boolean {
  openSearchPanel(view);
  if (replace && !view.state.readOnly && getSearchQuery(view.state).valid) {
    const field = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
    field?.focus({ preventScroll: true });
    field?.select();
  }
  return true;
}

/**
 * CodeMirror opens its panel when a query is empty or invalid. Once the user
 * has entered an invalid expression, every entry point keeps that expression
 * intact until corrected instead of replacing it with a previous selection.
 */
function validSearchCommand(command: Command): Command {
  return (view) => {
    const query = getSearchQuery(view.state);
    if (query.search.length > 0 && !query.valid) return false;
    return command(view);
  };
}

const findNext = validSearchCommand(codeMirrorFindNext);
const findPrevious = validSearchCommand(codeMirrorFindPrevious);
const replaceNext = validSearchCommand(codeMirrorReplaceNext);
const replaceAll = validSearchCommand(codeMirrorReplaceAll);

/** One host adapter for command palette, public API, and configured shortcuts. */
export function executeSourceAction(view: EditorView, action: string): boolean | undefined {
  switch (action) {
    case "search.open": return openSourceSearch(view);
    case "search.replace": return openSourceSearch(view, true);
    case "search.close": return closeSearchPanel(view);
    case "search.next": return findNext(view);
    case "search.previous": return findPrevious(view);
    case "search.replace-next": return replaceNext(view);
    case "search.replace-all": return replaceAll(view);
    case "document.goto-line": return gotoLine(view);
    case "history.undo": return undo(view);
    case "history.redo": return redo(view);
    case "selection.next-occurrence": return selectNextOccurrence(view);
    default: return undefined;
  }
}

/**
 * A small native panel over CodeMirror's search implementation. Its only state is
 * UI state: matching, replacements, selection, and undo stay in CodeMirror.
 */
class SourceSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly #view: EditorView;
  readonly #search: HTMLInputElement;
  readonly #replace: HTMLInputElement;
  readonly #case: HTMLInputElement;
  readonly #regexp: HTMLInputElement;
  readonly #word: HTMLInputElement;
  readonly #status: HTMLElement;
  readonly #replaceControls: (HTMLInputElement | HTMLButtonElement)[] = [];
  #composing = false;
  #compositionTimer: ReturnType<typeof setTimeout> | undefined;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;
  #cursorAffinity: {
    readonly doc: EditorView["state"]["doc"];
    readonly original: EditorSelection;
    readonly neutral: EditorSelection;
  } | undefined;

  readonly #onPanelFocus = (): void => {
    // Panel.mount runs inside CM.update. Wait until that update finishes,
    // before the next measure can enforce a wrapped-line cursor association.
    queueMicrotask(() => {
      if (this.#destroyed || !this.dom.contains(this.dom.ownerDocument.activeElement)) return;
      const { state } = this.#view;
      const main = state.selection.main;
      if (!main.empty || main.assoc === 0) return;
      const neutral = EditorSelection.create(state.selection.ranges.map((range, index) =>
        index === state.selection.mainIndex
          ? EditorSelection.cursor(range.head, 0, range.bidiLevel ?? undefined, range.goalColumn)
          : range), state.selection.mainIndex);
      this.#cursorAffinity = { doc: state.doc, original: state.selection, neutral };
      this.#view.dispatch({ selection: neutral, annotations: Transaction.addToHistory.of(false) });
    });
  };
  readonly #onEditorFocus = (): void => { queueMicrotask(() => this.#restoreCursorAffinity()); };

  #restoreCursorAffinity(): void {
    const saved = this.#cursorAffinity;
    this.#cursorAffinity = undefined;
    if (saved === undefined || !this.#view.dom.isConnected || !this.#view.hasFocus ||
        this.#view.state.doc !== saved.doc || !this.#view.state.selection.eq(saved.neutral, true)) return;
    this.#view.dispatch({ selection: saved.original, annotations: Transaction.addToHistory.of(false) });
  }

  constructor(view: EditorView) {
    this.#view = view;
    const document = view.dom.ownerDocument;
    this.dom = document.createElement("div");
    this.dom.className = "cm-search jot-search-panel";
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", "搜索与替换");
    this.dom.addEventListener("focusin", this.#onPanelFocus);
    view.contentDOM.addEventListener("focusin", this.#onEditorFocus);
    const field = (name: string, label: string) => {
      const input = document.createElement("input");
      input.name = name;
      input.className = "cm-textfield jot-search-input";
      input.placeholder = label;
      input.setAttribute("aria-label", label);
      input.addEventListener("input", () => {
        if (!this.#composing && this.#compositionTimer === undefined) this.#commit();
      });
      input.addEventListener("compositionstart", () => {
        this.#composing = true;
        this.#cancelSearch();
        if (this.#compositionTimer !== undefined) clearTimeout(this.#compositionTimer);
        this.#compositionTimer = undefined;
      });
      input.addEventListener("compositionend", () => {
        this.#composing = false;
        // Some platforms emit their final input after compositionend.
        this.#compositionTimer = setTimeout(() => {
          this.#compositionTimer = undefined;
          this.#commit();
        }, 0);
      });
      return input;
    };
    const button = (name: string, label: string, run: () => boolean, icon?: string) => {
      const element = document.createElement("button");
      element.type = "button";
      element.name = name;
      element.className = "cm-button jot-search-button";
      element.textContent = icon ?? label;
      if (icon !== undefined) {
        element.classList.add("jot-search-button--icon");
        element.setAttribute("aria-label", label);
        element.title = label;
      }
      element.addEventListener("click", () => this.#run(run, name !== "close"));
      return element;
    };
    const checkbox = (name: string, text: string) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = name;
      input.addEventListener("change", () => {
        if (!this.#composing && this.#compositionTimer === undefined) this.#commit();
      });
      label.append(input, document.createTextNode(text));
      options.append(label);
      return input;
    };
    const row = document.createElement("div");
    row.className = "jot-search-row";
    this.#search = field("search", "搜索");
    this.#search.setAttribute("main-field", "true");
    row.append(this.#search,
      button("prev", "上一个", () => findPrevious(view), "↑"),
      button("next", "下一个", () => findNext(view), "↓"),
      button("close", "关闭", () => closeSearchPanel(view), "×"));
    const options = document.createElement("div");
    options.className = "jot-search-options";
    this.#case = checkbox("case", "区分大小写");
    this.#word = checkbox("word", "全词");
    this.#regexp = checkbox("re", "正则表达式");
    this.#status = document.createElement("span");
    this.#status.className = "jot-search-status";
    this.#status.setAttribute("role", "status");
    options.append(this.#status);
    const replaceRow = document.createElement("div");
    replaceRow.className = "jot-search-row";
    this.#replace = field("replace", "替换为");
    const one = button("replace", "替换", () => replaceNext(view));
    const all = button("replaceAll", "全部替换", () => replaceAll(view));
    this.#replaceControls.push(this.#replace, one, all);
    replaceRow.append(this.#replace, one, all);
    this.dom.append(row, options, replaceRow);
    this.dom.addEventListener("keydown", (event) => {
      // The panel owns its native inputs and buttons. Only explicitly scoped
      // search bindings may run here; document-level editing handlers must not
      // receive the same Enter/Backspace/Arrow event after it bubbles out.
      event.stopPropagation();
      if (this.#composing || event.isComposing || event.keyCode === 229) return;
      if (["Enter", "F3", "Escape"].includes(event.key) || event.metaKey || event.ctrlKey) this.#cancelSearch();
      if (runScopeHandlers(view, event, "search-panel")) {
        event.preventDefault();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeSearchPanel(view);
      } else if (event.key === "Enter") {
        if (event.target === this.#search) {
          event.preventDefault();
          this.#run(() => (event.shiftKey ? findPrevious : findNext)(view));
        } else if (event.target === this.#replace) {
          event.preventDefault();
          this.#run(() => replaceNext(view));
        }
      }
    });
    this.#sync();
  }

  mount(): void { this.#search.focus({ preventScroll: true }); this.#search.select(); }

  destroy(): void {
    this.#destroyed = true;
    this.#cancelSearch();
    if (this.#compositionTimer !== undefined) clearTimeout(this.#compositionTimer);
    this.dom.removeEventListener("focusin", this.#onPanelFocus);
    this.#view.contentDOM.removeEventListener("focusin", this.#onEditorFocus);
    queueMicrotask(() => this.#restoreCursorAffinity());
  }

  update(update: ViewUpdate): void {
    if (this.#cursorAffinity !== undefined && (update.docChanged ||
        !update.state.selection.eq(this.#cursorAffinity.neutral, true))) this.#cursorAffinity = undefined;
    if (update.startState.readOnly !== update.state.readOnly ||
      update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setSearchQuery)))) {
      this.#sync();
    }
  }

  #sync(): void {
    const query = getSearchQuery(this.#view.state);
    if (!this.#composing && this.#compositionTimer === undefined) {
      if (this.#search.value !== query.search) this.#search.value = query.search;
      if (this.#replace.value !== query.replace) this.#replace.value = query.replace;
    }
    this.#case.checked = query.caseSensitive;
    this.#regexp.checked = query.regexp;
    this.#word.checked = query.wholeWord;
    for (const control of this.#replaceControls) control.disabled = this.#view.state.readOnly;
    const invalid = query.search.length > 0 && !query.valid;
    this.#search.setAttribute("aria-invalid", String(invalid));
    this.#status.textContent = invalid ? "无效的正则表达式" : "";
  }

  #commit(): void {
    const previous = getSearchQuery(this.#view.state);
    updateSourceSearch(this.#view, {
      search: this.#search.value,
      replace: this.#replace.value,
      caseSensitive: this.#case.checked,
      wholeWord: this.#word.checked,
      regexp: this.#regexp.checked,
      literal: previous.literal,
    });
    const start = this.#view.state;
    const query = getSearchQuery(start);
    if (sameSearchPattern(previous, query)) return;
    this.#cancelSearch();
    if (!query.valid) return;
    // Only navigation is debounced. CM keeps ownership of query matching,
    // source selection and replacement, including regex and whole-word rules.
    this.#searchTimer = setTimeout(() => {
      this.#searchTimer = undefined;
      const state = this.#view.state;
      // A click into the document wins over a pending incremental search.
      // Explicit Find Next commands keep their own synchronous navigation.
      if (!this.dom.contains(this.dom.ownerDocument.activeElement) ||
          !sameSearchPattern(query, getSearchQuery(state)) ||
          state.doc !== start.doc || !state.selection.eq(start.selection)) return;
      const origin = start.selection.main.from;
      let match = query.getCursor(state, origin).next();
      if (match.done && origin > 0) match = query.getCursor(state, 0, origin).next();
      if (match.done) {
        this.#status.textContent = "未找到匹配项";
        return;
      }
      this.#status.textContent = "";
      this.#view.dispatch({
        selection: EditorSelection.single(match.value.from, match.value.to),
        effects: EditorView.scrollIntoView(EditorSelection.range(match.value.from, match.value.to)),
        userEvent: "select.search",
      });
    }, 50);
  }

  #cancelSearch(): void {
    if (this.#searchTimer !== undefined) clearTimeout(this.#searchTimer);
    this.#searchTimer = undefined;
  }

  #run(command: () => boolean, requiresQuery = true): void {
    this.#cancelSearch();
    // CodeMirror's command fallback opens the panel for an invalid query. In
    // an already open form, retain the user's invalid input and focus so they
    // can correct it, instead of adopting the editor's previous selection.
    if (requiresQuery && !getSearchQuery(this.#view.state).valid) {
      this.#sync();
      return;
    }
    const found = command();
    if (!found && getSearchQuery(this.#view.state).valid) this.#status.textContent = "未找到匹配项";
    else if (found) this.#status.textContent = "";
  }
}

const searchTheme = EditorView.baseTheme({
  ".cm-panels.cm-panels-bottom:has(> .jot-search-panel)": {
    borderTop: "1px solid color-mix(in srgb, var(--jot-text-color, CanvasText) 14%, transparent)",
  },
  ".cm-panel.cm-search.jot-search-panel": {
    "--jot-search-border": "color-mix(in srgb, currentColor 18%, transparent)",
    padding: "8px 10px", color: "var(--jot-text-color, CanvasText)",
    background: "color-mix(in srgb, var(--jot-background, Canvas) 97%, currentColor)",
    font: "13px/1.4 system-ui, sans-serif",
    "& .jot-search-row": { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" },
    "& .jot-search-options": { display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "center", marginBlock: "5px" },
    "& .jot-search-options label": { display: "inline-flex", gap: "4px", alignItems: "center" },
    "& input[type=checkbox]": { accentColor: "var(--jot-link-color, auto)" },
    "& input, & button, & label": { margin: "0" },
    "& .jot-search-input": { minWidth: "76px", flex: "1 1 76px", boxSizing: "border-box", maxWidth: "100%", minHeight: "30px", padding: "4px 8px", font: "inherit", border: "1px solid var(--jot-search-border)", borderRadius: "6px", color: "inherit", background: "var(--jot-background, Canvas)" },
    "& .jot-search-input::placeholder": { color: "var(--jot-muted-color, inherit)", opacity: ".74" },
    "& .jot-search-input[aria-invalid=true]": { borderColor: "var(--jot-search-error-color, #cb5353)" },
    "& .jot-search-button": { minHeight: "30px", padding: "3px 8px", borderRadius: "6px", font: "inherit", color: "inherit", background: "transparent", border: "1px solid var(--jot-search-border)", cursor: "pointer", whiteSpace: "nowrap" },
    "& .jot-search-button--icon": { width: "30px", padding: "0", borderColor: "transparent", fontSize: "16px" },
    "& .jot-search-button:hover:not(:disabled)": { background: "color-mix(in srgb, currentColor 8%, transparent)" },
    "& :focus-visible": { outline: "2px solid var(--jot-link-color, currentColor)", outlineOffset: "-2px" },
    "& .jot-search-row > button[name=close]": { position: "static" },
    "& .jot-search-button:disabled, & .jot-search-input:disabled": { opacity: ".45" },
    "& .jot-search-status": { fontSize: "12px" },
  },
  ".cm-searchMatch": { backgroundColor: "var(--jot-search-match, #ffe49b88)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--jot-search-match-selected, #ffbe4988)" },
  "& .cm-content::selection, & .cm-content ::selection": { backgroundColor: "var(--jot-selection-background, Highlight)" },
  "& ::highlight(jot-search-match)": { backgroundColor: "var(--jot-search-match, #ffe49b88)" },
  "& ::highlight(jot-search-current)": { backgroundColor: "var(--jot-search-match-selected, #ffbe4988)" },
  "& ::highlight(jot-preview-selection)": { backgroundColor: "var(--jot-selection-background, #2f6feb55)" },
  ".jot-search-match-node": { boxShadow: "inset 0 0 0 2px var(--jot-search-match, #ffe49bcc)" },
  ".jot-search-current-node": { boxShadow: "inset 0 0 0 2px var(--jot-search-match-selected, #ffbe49cc)" },
  ".jot-preview-selection-node": { backgroundColor: "var(--jot-selection-background, #2f6feb55)" },
});

export { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext };
