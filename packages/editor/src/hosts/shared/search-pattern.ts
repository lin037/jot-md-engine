import type { SearchQuery } from "@codemirror/search";

/** Replacement text does not change which source positions match. */
export function sameSearchPattern(left: SearchQuery, right: SearchQuery): boolean {
  return left.search === right.search && left.caseSensitive === right.caseSensitive &&
    left.wholeWord === right.wholeWord && left.regexp === right.regexp &&
    left.literal === right.literal && left.test === right.test;
}
