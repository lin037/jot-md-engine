import {
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { createDefaultEditorCommandRegistry } from "../../src/components/commands.js";
import { history, undoDepth } from "@codemirror/commands";
import { engineSynchronization, requestedOrigin, sourceReadOnlyFilter } from "../../src/hosts/source/synchronization.js";
import { sourceSnapshot } from "../../src/hosts/shared/source-snapshot.js";
import {
  isKnownSearchMiss,
  recordSearchMiss,
  scheduleIncrementalSearch,
  selectionMatchesSearchQuery,
} from "../../src/hosts/shared/search-engine.js";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { executeSourceAction, sourceSearch, updateSourceSearch } from "../../src/hosts/source/search.js";

function source_snapshots_share_only_the_latest_text_per_view(): void {
  const initial = EditorState.create({ doc: "first\n第二行😀" });
  const updated = initial.update({ changes: { from: 0, insert: "new " } }).state;
  let initialCalls = 0;
  let updatedCalls = 0;
  const initialToString = initial.doc.toString.bind(initial.doc);
  const updatedToString = updated.doc.toString.bind(updated.doc);
  Object.defineProperty(initial.doc, "toString", {
    value: () => { initialCalls += 1; return initialToString(); }, configurable: true,
  });
  Object.defineProperty(updated.doc, "toString", {
    value: () => { updatedCalls += 1; return updatedToString(); }, configurable: true,
  });
  try {
    const view = { state: initial };
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 1);

    view.state = initial.update({ selection: EditorSelection.cursor(3) }).state;
    equal(view.state.doc, initial.doc);
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 1); // Selection changes share the same immutable Text.

    view.state = updated;
    equal(sourceSnapshot(view), "new first\n第二行😀");
    equal(sourceSnapshot(view), "new first\n第二行😀");
    equal(updatedCalls, 1);
    view.state = initial;
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 2); // Returning through history recomputes an evicted version.

    const otherView = { state: initial };
    equal(sourceSnapshot(otherView), "first\n第二行😀");
    equal(initialCalls, 3); // Even shared Text objects do not share view lifetimes.
    otherView.state = updated;
    equal(sourceSnapshot(otherView), "new first\n第二行😀");
    equal(updatedCalls, 2);
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 3); // Moving the other view cannot invalidate this view.
  } finally {
    Reflect.deleteProperty(initial.doc, "toString");
    Reflect.deleteProperty(updated.doc, "toString");
  }
}

function source_search_matches_full_document_and_respects_query_options(): void {
  const source = `Alpha alphabet ALPHA\n${"unrelated line\n".repeat(20_000)}alpha tail42\n尾部匹配`;
  const state = EditorState.create({ doc: source, extensions: sourceSearch() });
  const query = new SearchQuery({ search: "alpha", wholeWord: true });
  const matches = [...{ [Symbol.iterator]: () => query.getCursor(state) }];
  equal(matches.length, 3);
  equal(matches[2]?.from, source.lastIndexOf("alpha"));
  const exact = new SearchQuery({ search: "Alpha", caseSensitive: true, wholeWord: true });
  equal([...{ [Symbol.iterator]: () => exact.getCursor(state) }].length, 1);
  const regex = new SearchQuery({ search: "tail(\\d+)", regexp: true });
  equal(regex.getCursor(state).next().value?.from, source.indexOf("tail42"));
  const unicode = new SearchQuery({ search: "尾部匹配" });
  equal(unicode.getCursor(state).next().value?.to, source.length);
  equal(new SearchQuery({ search: "[", regexp: true }).valid, false);
}

function source_replace_all_is_one_undoable_transaction_and_honors_read_only(): void {
  const source = "# word12\n\n> word34\n\n``` js begin\nword56\n``` end";
  let state = EditorState.create({ doc: source, extensions: [history(), sourceReadOnlyFilter, sourceSearch()] });
  const events: string[] = [];
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec | Transaction) {
      const transaction = spec instanceof Transaction ? spec : state.update(spec);
      if (transaction.docChanged) events.push(transaction.annotation(Transaction.userEvent) ?? "");
      state = transaction.state;
    },
  } as unknown as EditorView;
  updateSourceSearch(view, { search: "word(\\d+)", replace: "value-$1", regexp: true });
  equal(executeSourceAction(view, "search.replace-all"), true);
  equal(state.doc.toString(), source.replace(/word(\d+)/gu, "value-$1"));
  equal(events.join(","), "input.replace.all");
  equal(undoDepth(state), 1);
  equal(executeSourceAction(view, "history.undo"), true);
  equal(state.doc.toString(), source);
  equal(executeSourceAction(view, "history.redo"), true);
  equal(state.doc.toString(), source.replace(/word(\d+)/gu, "value-$1"));

  updateSourceSearch(view, { search: "[", regexp: true });
  const invalidSource = state.doc.toString();
  for (const action of ["search.next", "search.previous", "search.replace-next", "search.replace-all"]) {
    equal(executeSourceAction(view, action), false);
  }
  equal(state.doc.toString(), invalidSource);

  state = EditorState.create({ doc: source, extensions: [EditorState.readOnly.of(true), sourceReadOnlyFilter, sourceSearch()] });
  updateSourceSearch(view, { search: "word", replace: "changed" });
  equal(executeSourceAction(view, "search.replace-all"), false);
  equal(executeSourceAction(view, "search.replace-next"), false);
  equal(state.doc.toString(), source);
}

function engine_sync_preserves_selection_and_does_not_create_history(): void {
  const state = EditorState.create({
    doc: "abc\ndef\nghi",
    selection: EditorSelection.create([EditorSelection.range(5, 4), EditorSelection.cursor(9)], 0),
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
  });
  const transaction = engineSynchronization(state, "a!bc\ndef\nghi");
  if (transaction === undefined) throw new Error("missing sync transaction");
  equal(transaction.newDoc.toString(), "a!bc\ndef\nghi");
  equal(transaction.newSelection.ranges.length, 2);
  equal(transaction.newSelection.main.anchor, 6);
  equal(transaction.newSelection.main.head, 5);
  equal(undoDepth(transaction.state), 0);
  let changed = 0;
  transaction.changes.iterChangedRanges((from, to) => { changed += to - from; });
  equal(changed, 0); // insertion only: the rest of the document was not replaced
}

function read_only_blocks_custom_input_but_allows_explicit_api_updates(): void {
  const state = EditorState.create({ doc: "abc", extensions: [
    history(), sourceReadOnlyFilter, EditorState.readOnly.of(true),
  ] });
  equal(state.update({ changes: { from: 0, insert: "user" } }).newDoc.toString(), "abc");
  equal(state.update({ changes: { from: 0, insert: "api" },
    annotations: requestedOrigin.of("api") }).newDoc.toString(), "apiabc");
  equal(engineSynchronization(state, "confirmed")?.newDoc.toString(), "confirmed");
}

function format_commands_and_dynamic_keybindings_share_one_catalog(): void {
  const registry = createDefaultEditorCommandRegistry();
  const formatted = registry.execute("format.bold", { source: "hello",
    selection: { anchor: 0 as import("@jot-md/editor-protocol").Utf16Offset,
      head: 5 as import("@jot-md/editor-protocol").Utf16Offset } });
  if (formatted?.edits === undefined || formatted.selection === undefined) throw new Error("missing format edit");
  equal(apply("hello", formatted.edits), "**hello**");
  const unwrapped = registry.execute("format.bold", { source: "**hello**", selection: formatted.selection });
  equal(apply("**hello**", unwrapped?.edits ?? []), "hello");
  let changes = 0;
  const unsubscribe = registry.subscribe(() => { changes += 1; });
  registry.configureShortcuts({ "format.bold": "Mod-Shift-b", "format.italic": null });
  equal(registry.shortcuts.find((item) => item.id === "format.bold")?.key, "Mod-Shift-b");
  equal(registry.shortcuts.some((item) => item.id === "format.italic"), false);
  let conflict = false;
  try { registry.configureShortcuts({ "format.italic": "Shift-Mod-b" }); } catch { conflict = true; }
  equal(conflict, true);
  equal(registry.shortcuts.some((item) => item.id === "format.italic"), false);
  equal(changes, 1);
  let invalid = false;
  try { registry.configureShortcuts({ "format.bold": "Unknown-b" }); } catch { invalid = true; }
  equal(invalid, true);
  equal(registry.shortcuts.find((item) => item.id === "format.bold")?.key, "Mod-Shift-b");
  equal(changes, 1);
  registry.resetShortcuts();
  equal(registry.shortcuts.find((item) => item.id === "format.bold")?.key, "Mod-b");
  equal(changes, 2);
  unsubscribe();
}

function awaitIncrementalSearch(
  view: EditorView,
  query: SearchQuery,
  origin: number,
): Promise<{ readonly from: number; readonly to: number } | undefined> {
  return new Promise((resolve) => {
    scheduleIncrementalSearch(view, query, origin, resolve);
  });
}

function navigateSearch(
  initial: EditorState,
  query: SearchQuery,
  action: "search.next" | "search.previous",
  caret = 0,
) {
  let state = initial.update({ selection: EditorSelection.cursor(caret), effects: setSearchQuery.of(query) }).state;
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
    plugin() { return null; },
  } as unknown as EditorView;
  return executeSourceAction(view, action) ? state.selection.main : undefined;
}

async function search_engine_matches_unicode_boundaries_and_prunes_misses(): Promise<void> {
  const filler = "普通中文段落 abc 😀\n".repeat(4_800);
  const seamIndex = 65_530;
  const source = filler.slice(0, seamIndex) +
    "跨块target_seam ﬀ 尾部ΟΣ e\u0301 aaa\n" +
    filler.slice(seamIndex) +
    "末行needle";
  const state = EditorState.create({ doc: source, extensions: sourceSearch() });

  // 跨 65536 分块边界、NFKD 连字 ﬀ、希腊词尾西格玛与组合字符都与 SearchCursor 完全一致。
  for (const config of [
    { search: "target_seam" },
    { search: "ff" },
    { search: "σ" },
    { search: "e\u0301" },
    { search: "末行needle" },
  ]) {
    const query = new SearchQuery(config);
    const expected = query.getCursor(state, 0).next();
    const actual = navigateSearch(state, query, "search.next");
    equal(actual?.from, expected.done ? undefined : expected.value.from);
    equal(actual?.to, expected.done ? undefined : expected.value.to);
  }

  // 反向查找支持重叠匹配与跨接缝回绕。
  const overlapQuery = new SearchQuery({ search: "aa" });
  const aaaStart = source.indexOf("aaa");
  const prevOverlap = navigateSearch(state, overlapQuery, "search.previous", aaaStart + 3);
  equal(prevOverlap?.from, aaaStart + 1);
  equal(prevOverlap?.to, aaaStart + 3);

  // A normalized match across the wrap boundary is unreachable, but disproves a whole-document miss.
  const expandedFrom = 65_532;
  const expandedSource = "x".repeat(expandedFrom) + "株式会社" + "x".repeat(40);
  const expandedState = EditorState.create({ doc: expandedSource, extensions: sourceSearch() });
  const expandedQuery = new SearchQuery({ search: "㍿" });
  const insideMatch = expandedFrom + 2;
  equal(navigateSearch(expandedState, expandedQuery, "search.next", insideMatch), undefined);
  equal(navigateSearch(expandedState, expandedQuery, "search.previous", insideMatch), undefined);
  equal(isKnownSearchMiss(expandedState.doc, expandedQuery), false);
  equal(navigateSearch(expandedState, expandedQuery, "search.next")?.from, expandedFrom);

  // Both the native and optimized document sizes must wrap from offset 3 to the
  // composed match, even when an earlier normalized match overlaps that boundary.
  for (const length of [32_767, 32_768, 32_769]) {
    const hangul = ("각".normalize("NFD") + "각가").padEnd(length, "x");
    const hangulState = EditorState.create({ doc: hangul, extensions: sourceSearch() });
    const query = new SearchQuery({ search: "각가" });
    const match = navigateSearch(hangulState, query, "search.previous", 3);
    equal(match?.from, 3);
    equal(match?.to, 5);
    equal(isKnownSearchMiss(hangulState.doc, query), false);
  }

  // 零匹配单调性：fff 无匹配后，ffff / ffffffffff / wholeWord / caseSensitive 均 O(1) 剪枝。
  const fff = new SearchQuery({ search: "fff" });
  equal(isKnownSearchMiss(state.doc, fff), false);
  equal(navigateSearch(state, fff, "search.next"), undefined);
  equal(isKnownSearchMiss(state.doc, fff), true);
  equal(isKnownSearchMiss(state.doc, new SearchQuery({ search: "ffffffffff" })), true);
  equal(isKnownSearchMiss(state.doc, new SearchQuery({ search: "ffff", wholeWord: true })), true);
  equal(isKnownSearchMiss(state.doc, new SearchQuery({ search: "FFFF", caseSensitive: true })), true);

  // 区分大小写的无匹配不得误剪枝不区分大小写的查询。
  const upperMissing = new SearchQuery({ search: "NEEDLE", caseSensitive: true });
  equal(navigateSearch(state, upperMissing, "search.next"), undefined);
  equal(isKnownSearchMiss(state.doc, upperMissing), true);
  equal(isKnownSearchMiss(state.doc, new SearchQuery({ search: "NEEDLE", caseSensitive: false })), false);
  equal(navigateSearch(state, new SearchQuery({ search: "NEEDLE", caseSensitive: false }), "search.next")?.from,
    source.lastIndexOf("needle"));

  // wholeWord 的无匹配不能写入普通子串零匹配缓存。
  const wordOnlyMiss = new SearchQuery({ search: "need", wholeWord: true });
  recordSearchMiss(state.doc, wordOnlyMiss);
  equal(isKnownSearchMiss(state.doc, new SearchQuery({ search: "needle" })), false);

  // 文档编辑生成新 Text 实例后，旧零匹配缓存自然失效。
  const edited = state.update({ changes: { from: 0, insert: "ffffffffff " } }).state;
  equal(isKnownSearchMiss(edited.doc, new SearchQuery({ search: "ffffffffff" })), false);
  equal(navigateSearch(edited, new SearchQuery({ search: "ffffffffff" }), "search.next")?.from, 0);

  // 增量搜索支持回绕定位与零匹配记录，且在让出时间片后异步收敛。
  const mockView = { state } as unknown as EditorView;
  const wrapped = await awaitIncrementalSearch(mockView, new SearchQuery({ search: "target_seam" }), source.length - 4);
  equal(wrapped?.from, source.indexOf("target_seam"));

  // 强制每次时间片检查都超时以覆盖 setTimeout 让出路径。
  const originalNow = performance.now.bind(performance);
  let fakeClock = 0;
  Object.defineProperty(performance, "now", {
    value: () => { fakeClock += 10; return fakeClock; },
    configurable: true,
  });
  try {
    const yieldedHit = await awaitIncrementalSearch(mockView, new SearchQuery({ search: "末行needle" }), 0);
    equal(yieldedHit?.from, source.lastIndexOf("末行needle"));
    const yieldedMiss = await awaitIncrementalSearch(mockView, new SearchQuery({ search: "zzzzzzzzzz" }), 128);
    equal(yieldedMiss, undefined);
    equal(isKnownSearchMiss(state.doc, new SearchQuery({ search: "zzzzzzzzzzzz" })), true);
  } finally {
    Object.defineProperty(performance, "now", { value: originalNow, configurable: true });
  }
}

async function search_engine_preserves_regexp_and_whole_word_across_chunk_boundaries(): Promise<void> {
  // 正则跨 65536 边界的长匹配与行尾锚点 `$` 不能被人工分块截断。
  const longLine = `${"x".repeat(65_500)}START${"a".repeat(600)}END\nsecond`;
  const regexState = EditorState.create({ doc: longLine, extensions: sourceSearch() });
  const regexView = { state: regexState } as unknown as EditorView;
  const spanQuery = new SearchQuery({ search: "STARTa{600}END", regexp: true });
  const expectedSpan = spanQuery.getCursor(regexState, 0).next();
  const actualSpan = await awaitIncrementalSearch(regexView, spanQuery, 0);
  equal(actualSpan?.from, expectedSpan.value.from);
  equal(actualSpan?.to, expectedSpan.value.to);
  equal(navigateSearch(regexState, spanQuery, "search.next")?.from, expectedSpan.value.from);

  const eolQuery = new SearchQuery({ search: ".$", regexp: true });
  const expectedEol = eolQuery.getCursor(regexState, 0).next();
  const actualEol = await awaitIncrementalSearch(regexView, eolQuery, 0);
  equal(actualEol?.from, expectedEol.value.from);
  equal(actualEol?.to, expectedEol.value.to);
  equal(actualEol?.to, longLine.indexOf("\n"));

  // 全词搜索在分块边界处不能把词内子串误判为完整单词。
  const catfishDoc = `${"x".repeat(65_564)} catfish `;
  const catfishState = EditorState.create({ doc: catfishDoc, extensions: sourceSearch() });
  const catfishView = { state: catfishState } as unknown as EditorView;
  const wholeCat = new SearchQuery({ search: "cat", wholeWord: true });
  equal(navigateSearch(catfishState, wholeCat, "search.next"), undefined);
  equal(navigateSearch(catfishState, wholeCat, "search.previous", catfishDoc.length), undefined);
  equal(await awaitIncrementalSearch(catfishView, wholeCat, 0), undefined);

  const standaloneDoc = `${"x".repeat(65_564)} catfish cat `;
  const standaloneState = EditorState.create({ doc: standaloneDoc, extensions: sourceSearch() });
  const standaloneView = { state: standaloneState } as unknown as EditorView;
  const standalonePos = standaloneDoc.lastIndexOf("cat");
  equal(navigateSearch(standaloneState, wholeCat, "search.next")?.from, standalonePos);
  equal((await awaitIncrementalSearch(standaloneView, wholeCat, 0))?.from, standalonePos);

  // 选区命中判定对全词左右边界都不能误判，且不依赖扫描全文档。
  const rightWordState = EditorState.create({ doc: "catfish" });
  const leftWordState = EditorState.create({ doc: "xcat " });
  const exactWordState = EditorState.create({ doc: " cat " });
  equal(selectionMatchesSearchQuery(rightWordState, wholeCat, 0, 3), false);
  equal(selectionMatchesSearchQuery(leftWordState, wholeCat, 1, 4), false);
  equal(selectionMatchesSearchQuery(exactWordState, wholeCat, 1, 4), true);
  const regexWord = new SearchQuery({ search: "\\bcat\\b", regexp: true });
  equal(selectionMatchesSearchQuery(leftWordState, regexWord, 1, 4), false);
  equal(selectionMatchesSearchQuery(exactWordState, regexWord, 1, 4), true);

  // 超长 ASCII 搜索词（> 64KB）不能触发 V8 正则长度上限异常，且应精确匹配。
  const hugeNeedle = `a${"b".repeat(79_998)}c`;
  const hugeDoc = `${"z".repeat(70_000)}${hugeNeedle}${"z".repeat(70_000)}`;
  const hugeState = EditorState.create({ doc: hugeDoc, extensions: sourceSearch() });
  const hugeView = { state: hugeState } as unknown as EditorView;
  const hugeQuery = new SearchQuery({ search: hugeNeedle });
  equal(navigateSearch(hugeState, hugeQuery, "search.next")?.from, 70_000);
  equal(navigateSearch(hugeState, hugeQuery, "search.previous", hugeDoc.length)?.from, 70_000);
  equal((await awaitIncrementalSearch(hugeView, hugeQuery, 0))?.from, 70_000);
}

function apply(source: string, edits: readonly { readonly range: { readonly from: number; readonly to: number }; readonly insert: string }[]): string {
  return [...edits]
    .sort((left, right) => Number(right.range.from) - Number(left.range.from))
    .reduce((value, edit) =>
      value.slice(0, Number(edit.range.from)) + edit.insert + value.slice(Number(edit.range.to)), source);
}

function equal<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

source_snapshots_share_only_the_latest_text_per_view();
source_search_matches_full_document_and_respects_query_options();
source_replace_all_is_one_undoable_transaction_and_honors_read_only();
await search_engine_matches_unicode_boundaries_and_prunes_misses();
await search_engine_preserves_regexp_and_whole_word_across_chunk_boundaries();
engine_sync_preserves_selection_and_does_not_create_history();
read_only_blocks_custom_input_but_allows_explicit_api_updates();
format_commands_and_dynamic_keybindings_share_one_catalog();
