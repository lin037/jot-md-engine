import {
  closeSearchPanel as codeMirrorCloseSearchPanel,
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
import {
  hasNoSearchCandidate,
  isKnownSearchMiss,
  scheduleIncrementalSearch,
  type SearchMatchRange,
} from "../shared/search-engine.js";
import { sameSearchPattern } from "../shared/search-pattern.js";
import { sourceSnapshot } from "../shared/source-snapshot.js";

/** 大文档下合并高频搜索输入的防抖阈值（UTF-16 长度与毫秒）。 */
const LARGE_DOC_QUERY_DEBOUNCE_UNITS = 32_768;
const VERY_LARGE_DOC_UNITS = 262_144;
const SMALL_DOC_SEARCH_DELAY_MS = 50;
const MEDIUM_DOC_QUERY_DEBOUNCE_MS = 40;
const LARGE_DOC_QUERY_DEBOUNCE_MS = 80;

/** UTF-16 source search; decorations and virtualized DOM never become a search index. */
export interface EditorSearchQuery {
  readonly search: string;
  readonly replace?: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly regexp?: boolean;
  readonly literal?: boolean;
}

const activeSearchPanels = new WeakMap<EditorView, SourceSearchPanel>();

type SearchTextField = "search" | "replace";

function editSearchQuery(query: SearchQuery, change: Partial<EditorSearchQuery>): SearchQuery {
  const { test, ...config } = query;
  return new SearchQuery({ ...config, ...change, ...(test === undefined ? {} : { test }) });
}

export function sourceSearch(): Extension {
  return [search({ createPanel: (view) => new SourceSearchPanel(view) }), searchTheme];
}

export function updateSourceSearch(view: EditorView, query: EditorSearchQuery): void {
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery(query)) });
}

/** 面板输入处于大文档防抖窗口时，返回面板当前草稿查询以保持公开读取一致。 */
export function getSourceSearchQuery(view: EditorView): SearchQuery {
  return activeSearchPanels.get(view)?.currentDraftQuery() ?? getSearchQuery(view.state);
}

/** 在导航、替换等外部入口执行前，同步提交面板尚未落入状态的防抖输入。 */
export function flushPendingSearchQuery(view: EditorView): void {
  activeSearchPanels.get(view)?.flushPendingQuery();
}

export function openSourceSearch(view: EditorView, replace = false): boolean {
  flushPendingSearchQuery(view);
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
function searchCommand(command: Command, prefilterNavigation = false): Command {
  return (view) => {
    flushPendingSearchQuery(view);
    const { state } = view;
    const query = getSearchQuery(state);
    if (!query.valid) return query.search.length === 0 && command(view);
    if (isKnownSearchMiss(state.doc, query)) return false;
    // Only short-circuit proven misses. CodeMirror owns match traversal and the
    // host's scrollToMatch effect, as well as announcements and panel focus.
    if (prefilterNavigation && state.doc.length >= LARGE_DOC_QUERY_DEBOUNCE_UNITS &&
        !query.regexp && !query.wholeWord && query.test === undefined &&
        hasNoSearchCandidate(sourceSnapshot(view), state.doc, query)) return false;
    return command(view);
  };
}

function closeSearchPanel(view: EditorView): boolean {
  flushPendingSearchQuery(view);
  return codeMirrorCloseSearchPanel(view);
}

function selectSearchMatch(view: EditorView, match: SearchMatchRange): void {
  const state = view.state;
  const line = state.doc.lineAt(match.from);
  const from = Math.max(line.from, match.from - 30);
  const to = Math.min(state.doc.lineAt(match.to).to, match.to + 30, match.from + 90);
  const context = state.sliceDoc(from, to);
  const selection = EditorSelection.single(match.from, match.to);
  view.dispatch({
    selection,
    effects: [
      EditorView.announce.of(`${state.phrase("current match")}. ${context} ${state.phrase("on line")} ${line.number}.`),
      EditorView.scrollIntoView(selection.main),
    ],
    userEvent: "select.search",
  });
}

const findNext = searchCommand(codeMirrorFindNext, true);
const findPrevious = searchCommand(codeMirrorFindPrevious, true);
const replaceNext = searchCommand(codeMirrorReplaceNext);
const replaceAll = searchCommand(codeMirrorReplaceAll);

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
  #composition: { field: SearchTextField; timer: ReturnType<typeof setTimeout> } | undefined;
  #queryTimer: ReturnType<typeof setTimeout> | undefined;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  #cancelScan: (() => void) | undefined;
  #pendingQuery: SearchQuery | undefined;
  #flushingQuery = false;
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
    activeSearchPanels.set(view, this);
    const document = view.dom.ownerDocument;
    this.dom = document.createElement("div");
    this.dom.className = "cm-search jot-search-panel";
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", "搜索与替换");
    this.dom.addEventListener("focusin", this.#onPanelFocus);
    view.contentDOM.addEventListener("focusin", this.#onEditorFocus);
    const field = (name: SearchTextField, label: string) => {
      const input = document.createElement("input");
      input.name = name;
      input.className = "cm-textfield jot-search-input";
      input.placeholder = label;
      input.setAttribute("aria-label", label);
      input.addEventListener("input", () => {
        if (!this.#composing && this.#composition === undefined) this.#commit({ [name]: input.value });
      });
      input.addEventListener("compositionstart", () => {
        if (this.#composition !== undefined) this.#pendingQuery = this.currentDraftQuery();
        this.#clearComposition();
        this.#clearQueryTimer();
        this.#cancelSearch();
        this.#composing = true;
      });
      input.addEventListener("compositionend", () => {
        this.#composing = false;
        // Some platforms emit their final input after compositionend.
        this.#composition = { field: name, timer: setTimeout(() => {
          this.#composition = undefined;
          this.#commit({ [name]: input.value });
        }, 0) };
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
    const checkbox = (name: string, text: string, option: "caseSensitive" | "wholeWord" | "regexp") => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = name;
      input.addEventListener("change", () => {
        if (!this.#composing && this.#composition === undefined) this.#commit({ [option]: input.checked }, true);
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
    this.#case = checkbox("case", "区分大小写", "caseSensitive");
    this.#word = checkbox("word", "全词", "wholeWord");
    this.#regexp = checkbox("re", "正则表达式", "regexp");
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
    this.#sync(true);
  }

  mount(): void { this.#search.focus({ preventScroll: true }); this.#search.select(); }

  destroy(): void {
    this.#destroyed = true;
    if (activeSearchPanels.get(this.#view) === this) activeSearchPanels.delete(this.#view);
    this.#cancelPending();
    this.dom.removeEventListener("focusin", this.#onPanelFocus);
    this.#view.contentDOM.removeEventListener("focusin", this.#onEditorFocus);
    queueMicrotask(() => this.#restoreCursorAffinity());
  }

  currentDraftQuery(): SearchQuery {
    const query = this.#pendingQuery ?? getSearchQuery(this.#view.state);
    const field = this.#composition?.field;
    if (field === undefined) return query;
    const input = field === "search" ? this.#search : this.#replace;
    return editSearchQuery(query, { [field]: input.value });
  }

  flushPendingQuery(): void {
    if (this.#destroyed) return;
    this.#cancelSearch();
    if (this.#pendingQuery !== undefined || this.#composition !== undefined) this.#flushQuery();
  }

  update(update: ViewUpdate): void {
    if (this.#cursorAffinity !== undefined && (update.docChanged ||
        !update.state.selection.eq(this.#cursorAffinity.neutral, true))) this.#cursorAffinity = undefined;
    const queryEffect = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(setSearchQuery)));
    if (queryEffect && !this.#flushingQuery) {
      this.#cancelPending();
      this.#sync(true);
      return;
    }
    if (update.startState.readOnly !== update.state.readOnly || queryEffect) {
      this.#sync(false);
    }
  }

  #sync(syncInputs: boolean): void {
    const query = getSearchQuery(this.#view.state);
    if (syncInputs && !this.#composing && this.#composition === undefined && this.#pendingQuery === undefined) {
      if (this.#search.value !== query.search) this.#search.value = query.search;
      if (this.#replace.value !== query.replace) this.#replace.value = query.replace;
      this.#case.checked = query.caseSensitive;
      this.#regexp.checked = query.regexp;
      this.#word.checked = query.wholeWord;
    }
    for (const control of this.#replaceControls) control.disabled = this.#view.state.readOnly;
    this.#applyValidationState(this.currentDraftQuery());
  }

  #applyValidationState(query: SearchQuery): void {
    const invalid = query.search.length > 0 && !query.valid;
    this.#search.setAttribute("aria-invalid", String(invalid));
    this.#status.textContent = invalid ? "无效的正则表达式" : "";
  }

  #dispatchQuery(query: SearchQuery): void {
    if (this.#destroyed) return;
    const current = getSearchQuery(this.#view.state);
    if (sameSearchPattern(current, query) && current.replace === query.replace) return;
    this.#flushingQuery = true;
    try {
      this.#view.dispatch({ effects: setSearchQuery.of(query) });
    } finally {
      this.#flushingQuery = false;
    }
  }

  #flushQuery(): SearchQuery {
    const draft = this.currentDraftQuery();
    this.#clearQueryTimer();
    this.#clearComposition();
    this.#pendingQuery = undefined;
    this.#dispatchQuery(draft);
    return getSearchQuery(this.#view.state);
  }

  #commit(change: Partial<EditorSearchQuery>, immediate = false): void {
    // A single-line input can omit line breaks from an API value. Merge
    // only the field changed by the input event into the canonical query.
    const baseline = this.#pendingQuery ?? getSearchQuery(this.#view.state);
    const draft = editSearchQuery(baseline, change);
    const patternChanged = !sameSearchPattern(baseline, draft);
    this.#pendingQuery = draft;
    if (!patternChanged) {
      // 仅修改替换框时，不打断正在等待防抖的搜索词。
      if (this.#queryTimer === undefined) this.#flushQuery();
      return;
    }

    this.#cancelSearch();
    this.#applyValidationState(draft);
    const docLength = this.#view.state.doc.length;
    const shouldDebounceQuery = !immediate &&
      draft.valid &&
      draft.search.length > 0 &&
      docLength >= LARGE_DOC_QUERY_DEBOUNCE_UNITS;

    if (shouldDebounceQuery) {
      if (this.#queryTimer !== undefined) clearTimeout(this.#queryTimer);
      const delay = docLength >= VERY_LARGE_DOC_UNITS
        ? LARGE_DOC_QUERY_DEBOUNCE_MS
        : MEDIUM_DOC_QUERY_DEBOUNCE_MS;
      const snapshotDoc = this.#view.state.doc;
      const snapshotSelection = this.#view.state.selection;
      this.#queryTimer = setTimeout(() => {
        this.#queryTimer = undefined;
        if (this.#destroyed) return;
        const committed = this.#flushQuery();
        const state = this.#view.state;
        if (!committed.valid ||
            !this.dom.contains(this.dom.ownerDocument.activeElement) ||
            state.doc !== snapshotDoc || !state.selection.eq(snapshotSelection)) return;
        this.#startIncrementalSearch(state, committed);
      }, delay);
      return;
    }

    const committed = this.#flushQuery();
    if (!committed.valid) return;
    const start = this.#view.state;
    // 小文档或显式切换复选框时保留原有轻量导航防抖；已知零匹配时无需再空等。
    const delay = isKnownSearchMiss(start.doc, committed) ? 0 : SMALL_DOC_SEARCH_DELAY_MS;
    this.#searchTimer = setTimeout(() => {
      this.#searchTimer = undefined;
      const state = this.#view.state;
      // A click into the document wins over a pending incremental search.
      // Explicit Find Next commands keep their own synchronous navigation.
      if (this.#destroyed ||
          !this.dom.contains(this.dom.ownerDocument.activeElement) ||
          !sameSearchPattern(committed, getSearchQuery(state)) ||
          state.doc !== start.doc || !state.selection.eq(start.selection)) return;
      this.#startIncrementalSearch(start, committed);
    }, delay);
  }

  #startIncrementalSearch(start: EditorView["state"], query: SearchQuery): void {
    this.#cancelScan?.();
    const origin = start.selection.main.from;
    this.#cancelScan = scheduleIncrementalSearch(this.#view, query, origin, (match) => {
      this.#cancelScan = undefined;
      const state = this.#view.state;
      if (this.#destroyed ||
          !this.dom.contains(this.dom.ownerDocument.activeElement) ||
          !sameSearchPattern(query, getSearchQuery(state)) ||
          state.doc !== start.doc || !state.selection.eq(start.selection)) return;
      if (match === undefined) {
        this.#status.textContent = "未找到匹配项";
        return;
      }
      this.#status.textContent = "";
      selectSearchMatch(this.#view, match);
    });
  }

  #cancelSearch(): void {
    if (this.#searchTimer !== undefined) clearTimeout(this.#searchTimer);
    this.#searchTimer = undefined;
    this.#cancelScan?.();
    this.#cancelScan = undefined;
  }

  #clearQueryTimer(): void {
    if (this.#queryTimer !== undefined) clearTimeout(this.#queryTimer);
    this.#queryTimer = undefined;
  }

  #clearComposition(): void {
    if (this.#composition !== undefined) clearTimeout(this.#composition.timer);
    this.#composition = undefined;
  }

  #cancelPending(): void {
    this.#clearQueryTimer();
    this.#clearComposition();
    this.#pendingQuery = undefined;
    this.#cancelSearch();
  }

  #run(command: () => boolean, requiresQuery = true): void {
    if (requiresQuery) this.flushPendingQuery();
    // CodeMirror's command fallback opens the panel for an invalid query. In
    // an already open form, retain the user's invalid input and focus so they
    // can correct it, instead of adopting the editor's previous selection.
    if (requiresQuery && !getSearchQuery(this.#view.state).valid) {
      this.#sync(false);
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
