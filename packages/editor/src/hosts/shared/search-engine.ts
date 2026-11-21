import type { SearchQuery } from "@codemirror/search";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { sourceSnapshot } from "./source-snapshot.js";

/** 大文档搜索热路径的共享常量：单次分块大小、正则预筛上限与单时间片预算。 */
const SEARCH_CHUNK_UNITS = 65_536;
const MAX_ASCII_PREFILTER_REGEX_LENGTH = 1_024;
const TIME_SLICE_BUDGET_MS = 4;
const MAX_CACHED_MISSES = 16;

export interface SearchMatchRange {
  readonly from: number;
  readonly to: number;
}

interface CompiledPrefilter {
  readonly eligible: boolean;
  readonly caseSensitive: boolean;
  readonly normNeedle: string;
  readonly asciiRegex?: RegExp;
  readonly overlap: number;
}

interface DocumentMissCache {
  readonly caseInsensitive: string[];
  readonly caseSensitive: string[];
}

const prefilterCache = new WeakMap<SearchQuery, CompiledPrefilter>();
const missCacheByDoc = new WeakMap<Text, DocumentMissCache>();

const COMBINING_MARK_PATTERN = /\p{M}/u;
const GREEK_SIGMA_PATTERN = /[σςΣ]/u;
const ASCII_ONLY_PATTERN = /^[\x00-\x7F]+$/u;
const REGEXP_SPECIAL_PATTERN = /[.*+?^${}()|[\]\\]/gu;

/**
 * 判断查询在当前不可变文档上是否已由前置全扫证明无匹配。
 *
 * 仅对不含组合变音符和希腊语词尾西格玛的普通字符串查询生效；若更短子串在
 * 同一文档中全量无匹配（无 wholeWord 限制），则任何包含该子串的延长查询
 * （包括开启 wholeWord 或区分大小写）在数学上必然无匹配。
 */
export function isKnownSearchMiss(doc: Text, query: SearchQuery): boolean {
  if (!query.valid || query.regexp || query.test !== undefined) return false;
  const compiled = compilePrefilter(query);
  if (!compiled.eligible || compiled.normNeedle.length === 0) return false;
  const cache = missCacheByDoc.get(doc);
  if (cache === undefined) return false;
  const lowerNeedle = compiled.caseSensitive
    ? compiled.normNeedle.toLowerCase()
    : compiled.normNeedle;
  if (cache.caseInsensitive.some((miss) => lowerNeedle.includes(miss))) return true;
  if (compiled.caseSensitive) {
    return cache.caseSensitive.some((miss) => compiled.normNeedle.includes(miss));
  }
  return false;
}

/**
 * 记录一条已通过整篇文档验证的零匹配模式。
 * 只有不带 wholeWord/regexp/test 的普通查询才能代表无条件子串缺失。
 */
export function recordSearchMiss(doc: Text, query: SearchQuery): void {
  if (!query.valid || query.regexp || query.wholeWord || query.test !== undefined) return;
  recordNormalizedSubstringMiss(doc, query);
}

function recordNormalizedSubstringMiss(doc: Text, query: SearchQuery): void {
  if (!query.valid || query.regexp || query.test !== undefined) return;
  const compiled = compilePrefilter(query);
  if (!compiled.eligible || compiled.normNeedle.length === 0) return;
  let cache = missCacheByDoc.get(doc);
  if (cache === undefined) {
    cache = { caseInsensitive: [], caseSensitive: [] };
    missCacheByDoc.set(doc, cache);
  }
  const bucket = compiled.caseSensitive ? cache.caseSensitive : cache.caseInsensitive;
  const pattern = compiled.normNeedle;
  if (bucket.some((existing) => pattern.includes(existing))) return;
  for (let index = bucket.length - 1; index >= 0; index -= 1) {
    if (bucket[index]!.includes(pattern)) bucket.splice(index, 1);
  }
  if (bucket.length >= MAX_CACHED_MISSES) bucket.shift();
  bucket.push(pattern);
}

/**
 * 对半开区间 `[from, to)` 执行与 CodeMirror SearchCursor 语义一致的 NFKD 块级预筛。
 *
 * 返回 `false` 表示该区间在数学上确定不含匹配；返回 `true` 时仍需由
 * `query.getCursor` 做精确 UTF-16 边界与 wholeWord/test 校验。
 */
export function chunkMayContainMatch(
  source: string,
  from: number,
  to: number,
  query: SearchQuery,
): boolean {
  if (!query.valid) return false;
  const compiled = compilePrefilter(query);
  if (!compiled.eligible) return true;
  const start = alignSliceStart(source, Math.max(0, Math.min(source.length, from)));
  const end = alignSliceEnd(source, Math.max(start, Math.min(source.length, to)));
  if (end <= start) return false;
  const normalized = source.slice(start, end).normalize("NFKD");
  if (compiled.caseSensitive) return normalized.includes(compiled.normNeedle);
  if (compiled.asciiRegex !== undefined) {
    compiled.asciiRegex.lastIndex = 0;
    return compiled.asciiRegex.test(normalized);
  }
  return normalized.toLowerCase().includes(compiled.normNeedle);
}

/**
 * 精确判断选区 `[from, to]` 是否命中当前搜索条件。
 *
 * - 对 `wholeWord` 左右各多提供 2 个 UTF-16 码元上下文，既避免截断导致把词内子串误判为全词，
 *   又把扫描严格限制在 `O(to - from)` 而不是扫描整篇文档。
 * - 命中零匹配缓存时直接返回 `false`。
 */
export function selectionMatchesSearchQuery(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
): boolean {
  if (!query.valid || isKnownSearchMiss(state.doc, query)) return false;
  if (query.regexp) {
    const match = query.getCursor(state, from).next();
    return !match.done && match.value.from === from && match.value.to === to;
  }
  const lo = query.wholeWord ? Math.max(0, from - 2) : from;
  const hi = query.wholeWord ? Math.min(state.doc.length, to + 2) : to;
  const cursor = query.getCursor(state, lo, hi);
  for (;;) {
    const match = advanceCursor(cursor, true);
    if (match.done || match.value.from > from) return false;
    if (match.value.from === from && match.value.to === to) return true;
  }
}

/** 同步查找从 `curTo` 开始的下一个匹配（含回绕到文档头部），供命令与单测使用。 */
export function findNextMatchSync(
  source: string,
  state: EditorState,
  query: SearchQuery,
  curFrom: number,
  curTo: number,
): SearchMatchRange | undefined {
  if (!query.valid || isKnownSearchMiss(state.doc, query)) return undefined;
  const length = state.doc.length;
  if (query.regexp) {
    const forward = advanceCursor(query.getCursor(state, curTo, length), false);
    if (!forward.done) return { from: forward.value.from, to: forward.value.to };
    const wrapped = advanceCursor(query.getCursor(state, 0, curFrom), false);
    return wrapped.done ? undefined : { from: wrapped.value.from, to: wrapped.value.to };
  }
  if (query.wholeWord || query.test !== undefined) {
    // 全词/自定义 test 依赖游标边界外字符，只能用分块预筛判断全文是否完全不含该子串；
    // 一旦存在候选子串，必须回退到未截断范围的原始 CodeMirror 游标。
    if (!rangeMayContainSubstringSync(source, 0, length, query)) {
      recordNormalizedSubstringMiss(state.doc, query);
      return undefined;
    }
    const forward = advanceCursor(query.getCursor(state, curTo, length), true);
    if (!forward.done && (forward.value.from !== curFrom || forward.value.to !== curTo)) {
      return { from: forward.value.from, to: forward.value.to };
    }
    const wrapEnd = Math.min(length, curFrom + unquoteSearch(query).length);
    const wrapped = advanceCursor(query.getCursor(state, 0, wrapEnd), true);
    if (!wrapped.done && (wrapped.value.from !== curFrom || wrapped.value.to !== curTo)) {
      return { from: wrapped.value.from, to: wrapped.value.to };
    }
    return undefined;
  }
  const overlap = chunkOverlap(query);
  const forward = scanForwardRangeSync(source, state, query, curTo, length, overlap);
  if (forward !== undefined && (forward.from !== curFrom || forward.to !== curTo)) {
    return forward;
  }
  const wrapLimit = Math.min(length, curFrom + Math.max(unquoteSearch(query).length, overlap));
  const wrapped = scanForwardRangeSync(source, state, query, 0, wrapLimit, overlap);
  if (wrapped !== undefined && (wrapped.from !== curFrom || wrapped.to !== curTo)) {
    return wrapped;
  }
  if (forward === undefined && wrapped === undefined) {
    recordSearchMiss(state.doc, query);
  }
  return undefined;
}

/** 同步向前查找匹配（含回绕到文档尾部）。 */
export function findPreviousMatchSync(
  source: string,
  state: EditorState,
  query: SearchQuery,
  curFrom: number,
  curTo: number,
): SearchMatchRange | undefined {
  if (!query.valid || isKnownSearchMiss(state.doc, query)) return undefined;
  const length = state.doc.length;
  if (query.regexp) {
    const backward = lastMatchInRangeSync(state, query, 0, curFrom, false);
    if (backward !== undefined) return backward;
    return lastMatchInRangeSync(state, query, curTo, length, false);
  }
  if (query.wholeWord || query.test !== undefined) {
    if (!rangeMayContainSubstringSync(source, 0, length, query)) {
      recordNormalizedSubstringMiss(state.doc, query);
      return undefined;
    }
    const backward = lastMatchInRangeSync(state, query, 0, curFrom, true);
    if (backward !== undefined && (backward.from !== curFrom || backward.to !== curTo)) {
      return backward;
    }
    const wrapStart = Math.max(0, curTo - unquoteSearch(query).length);
    const wrapped = lastMatchInRangeSync(state, query, wrapStart, length, true);
    if (wrapped !== undefined && (wrapped.from !== curFrom || wrapped.to !== curTo)) {
      return wrapped;
    }
    return undefined;
  }
  const overlap = chunkOverlap(query);
  const backward = scanBackwardRangeSync(source, state, query, 0, curFrom, overlap);
  if (backward !== undefined && (backward.from !== curFrom || backward.to !== curTo)) {
    return backward;
  }
  const wrapStart = Math.max(0, curTo - Math.max(unquoteSearch(query).length, overlap));
  const wrapped = scanBackwardRangeSync(source, state, query, wrapStart, length, overlap);
  if (wrapped !== undefined && (wrapped.from !== curFrom || wrapped.to !== curTo)) {
    return wrapped;
  }
  if (backward === undefined && wrapped === undefined) {
    recordSearchMiss(state.doc, query);
  }
  return undefined;
}

/**
 * 可取消的时间片增量搜索：从 `origin` 向文末扫描，再回绕扫描 `[0, origin)`。
 *
 * - 普通子串：分块 NFKD 预筛 + 4ms 时间片扫描，仅在命中块上调用 `query.getCursor`。
 * - 全词/自定义 test：先按时间片分块预筛是否全文无子串（无则直接返回）；
 *   若存在候选子串，再走未截断的原始 CodeMirror 游标以保持词边界精确。
 * - 正则表达式：直接走原始未分块 CodeMirror 游标，避免截断跨块匹配或伪造行尾 `$`。
 */
export function scheduleIncrementalSearch(
  view: EditorView,
  query: SearchQuery,
  origin: number,
  onDone: (match: SearchMatchRange | undefined) => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    cancelled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const state = view.state;
  const doc = state.doc;
  if (!query.valid || isKnownSearchMiss(doc, query)) {
    onDone(undefined);
    return cancel;
  }

  const length = doc.length;
  const clampedOrigin = Math.max(0, Math.min(length, origin));

  const runExactUnchunked = (): void => {
    let match = query.getCursor(state, clampedOrigin).next();
    if (match.done && clampedOrigin > 0) match = query.getCursor(state, 0, clampedOrigin).next();
    onDone(match.done ? undefined : { from: match.value.from, to: match.value.to });
  };

  if (query.regexp) {
    runExactUnchunked();
    return cancel;
  }

  const compiled = compilePrefilter(query);
  const source = sourceSnapshot(view);

  if (query.wholeWord || query.test !== undefined) {
    if (!compiled.eligible) {
      runExactUnchunked();
      return cancel;
    }
    const overlap = compiled.overlap;
    const stepSize = Math.max(SEARCH_CHUNK_UNITS, overlap);
    let position = 0;
    const prefilterStep = (): void => {
      timer = undefined;
      if (cancelled || view.state.doc !== doc) return;
      const deadline = now() + TIME_SLICE_BUDGET_MS;
      while (position < length) {
        const chunkEnd = Math.min(length, position + stepSize);
        const sliceEnd = Math.min(length, chunkEnd + overlap);
        if (chunkMayContainMatch(source, position, sliceEnd, query)) {
          runExactUnchunked();
          return;
        }
        position = chunkEnd;
        if (now() >= deadline && position < length) {
          timer = setTimeout(prefilterStep, 0);
          return;
        }
      }
      recordNormalizedSubstringMiss(doc, query);
      onDone(undefined);
    };
    prefilterStep();
    return cancel;
  }

  const overlap = chunkOverlap(query);
  const stepSize = Math.max(SEARCH_CHUNK_UNITS, overlap);
  // 扫描阶段：0 表示 [origin, length]，1 表示回绕区间 [0, origin]。
  // 为了让零匹配缓存严格覆盖跨过 origin 接缝的匹配，回绕结束边界多留一个 overlap。
  const segments: Array<{ readonly from: number; readonly to: number; readonly acceptLimit: number }> = [
    { from: clampedOrigin, to: length, acceptLimit: length },
  ];
  if (clampedOrigin > 0) {
    segments.push({
      from: 0,
      to: Math.min(length, clampedOrigin + overlap),
      acceptLimit: clampedOrigin,
    });
  }
  let segmentIndex = 0;
  let position = segments[0]!.from;
  let sawStraddlingMatch = false;

  const step = (): void => {
    timer = undefined;
    if (cancelled || view.state.doc !== doc) return;
    const deadline = now() + TIME_SLICE_BUDGET_MS;
    while (segmentIndex < segments.length) {
      const segment = segments[segmentIndex]!;
      if (position >= segment.to) {
        segmentIndex += 1;
        position = segmentIndex < segments.length ? segments[segmentIndex]!.from : length;
        continue;
      }
      const chunkEnd = Math.min(segment.to, position + stepSize);
      const sliceEnd = Math.min(segment.to, chunkEnd + overlap);
      if (!compiled.eligible || chunkMayContainMatch(source, position, sliceEnd, query)) {
        const cursor = query.getCursor(state, position, sliceEnd);
        for (let next = cursor.next(); !next.done; next = cursor.next()) {
          const match = next.value;
          if (match.to <= segment.acceptLimit) {
            onDone({ from: match.from, to: match.to });
            return;
          }
          // 命中跨过 origin 接缝但超出了回绕上界：不能将其误记为全文无匹配。
          sawStraddlingMatch = true;
        }
      }
      position = chunkEnd;
      if (now() >= deadline && (position < segment.to || segmentIndex + 1 < segments.length)) {
        timer = setTimeout(step, 0);
        return;
      }
    }
    if (!sawStraddlingMatch) recordSearchMiss(doc, query);
    onDone(undefined);
  };

  step();
  return cancel;
}

function rangeMayContainSubstringSync(
  source: string,
  from: number,
  to: number,
  query: SearchQuery,
): boolean {
  const compiled = compilePrefilter(query);
  if (!compiled.eligible) return true;
  const overlap = compiled.overlap;
  const stepSize = Math.max(SEARCH_CHUNK_UNITS, overlap);
  let position = from;
  while (position < to) {
    const end = Math.min(to, position + stepSize);
    const sliceEnd = Math.min(to, end + overlap);
    if (chunkMayContainMatch(source, position, sliceEnd, query)) return true;
    position = end;
  }
  return false;
}

function lastMatchInRangeSync(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  overlapping: boolean,
): SearchMatchRange | undefined {
  const cursor = query.getCursor(state, from, to);
  let last: SearchMatchRange | undefined;
  for (let next = advanceCursor(cursor, overlapping); !next.done; next = advanceCursor(cursor, overlapping)) {
    last = { from: next.value.from, to: next.value.to };
  }
  return last;
}

function advanceCursor(
  cursor: ReturnType<SearchQuery["getCursor"]>,
  overlapping: boolean,
): { readonly value: SearchMatchRange; readonly done?: boolean } {
  if (overlapping && "nextOverlapping" in cursor && typeof cursor.nextOverlapping === "function") {
    return cursor.nextOverlapping();
  }
  return cursor.next();
}

function scanForwardRangeSync(
  source: string,
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  overlap: number,
): SearchMatchRange | undefined {
  const compiled = compilePrefilter(query);
  if (!compiled.eligible) {
    const match = advanceCursor(query.getCursor(state, from, to), !query.regexp);
    return match.done ? undefined : { from: match.value.from, to: match.value.to };
  }
  const stepSize = Math.max(SEARCH_CHUNK_UNITS, overlap);
  let position = from;
  while (position < to) {
    const end = Math.min(to, position + stepSize);
    const sliceEnd = Math.min(to, end + overlap);
    if (chunkMayContainMatch(source, position, sliceEnd, query)) {
      const match = advanceCursor(query.getCursor(state, position, sliceEnd), true);
      if (!match.done) return { from: match.value.from, to: match.value.to };
    }
    position = end;
  }
  return undefined;
}

function scanBackwardRangeSync(
  source: string,
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  overlap: number,
): SearchMatchRange | undefined {
  const compiled = compilePrefilter(query);
  const stepSize = Math.max(SEARCH_CHUNK_UNITS, overlap);
  let end = to;
  while (end > from) {
    const start = Math.max(from, end - stepSize);
    const sliceStart = Math.max(from, start - overlap);
    if (!compiled.eligible || chunkMayContainMatch(source, sliceStart, end, query)) {
      const cursor = query.getCursor(state, sliceStart, end);
      let last: SearchMatchRange | undefined;
      for (let next = advanceCursor(cursor, !query.regexp); !next.done; next = advanceCursor(cursor, !query.regexp)) {
        last = { from: next.value.from, to: next.value.to };
      }
      if (last !== undefined) return last;
    }
    end = start;
  }
  return undefined;
}

function compilePrefilter(query: SearchQuery): CompiledPrefilter {
  const cached = prefilterCache.get(query);
  if (cached !== undefined) return cached;
  let compiled: CompiledPrefilter;
  const unquoted = unquoteSearch(query);
  if (!query.valid || query.regexp || unquoted.length === 0) {
    compiled = { eligible: false, caseSensitive: query.caseSensitive, normNeedle: "", overlap: 32 };
  } else {
    const normalized = unquoted.normalize("NFKD");
    const normNeedle = query.caseSensitive ? normalized : normalized.toLowerCase();
    const hasCombining = COMBINING_MARK_PATTERN.test(normalized);
    const hasSigma = !query.caseSensitive && GREEK_SIGMA_PATTERN.test(normalized);
    const eligible = normNeedle.length > 0 && !hasCombining && !hasSigma;
    // 超长查询（例如误粘贴数万字符进搜索框）不能构造正则，避免触发 V8 Regular expression too large。
    const asciiRegex = eligible &&
      !query.caseSensitive &&
      normNeedle.length <= MAX_ASCII_PREFILTER_REGEX_LENGTH &&
      ASCII_ONLY_PATTERN.test(normNeedle)
      ? new RegExp(normNeedle.replace(REGEXP_SPECIAL_PATTERN, "\\$&"), "gi")
      : undefined;
    compiled = {
      eligible,
      caseSensitive: query.caseSensitive,
      normNeedle,
      ...(asciiRegex === undefined ? {} : { asciiRegex }),
      overlap: Math.max(normNeedle.length * 2 + 16, 32),
    };
  }
  prefilterCache.set(query, compiled);
  return compiled;
}

function chunkOverlap(query: SearchQuery): number {
  return query.regexp ? 256 : compilePrefilter(query).overlap;
}

function alignSliceStart(source: string, offset: number): number {
  if (offset <= 0 || offset >= source.length) return offset;
  const code = source.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

function alignSliceEnd(source: string, offset: number): number {
  if (offset <= 0 || offset >= source.length) return offset;
  const previous = source.charCodeAt(offset - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? offset + 1 : offset;
}

function unquoteSearch(query: SearchQuery): string {
  return query.literal
    ? query.search
    : query.search.replace(/\\([nrt\\])/gu, (_match, ch: string) =>
        ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\");
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}
