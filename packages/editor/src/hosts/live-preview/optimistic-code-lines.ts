import { type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { quotePrefix } from "../../components/common/quote-prefix.js";
import { quotedCodeLineAt } from "./quoted-code-line.js";

interface CodeRow {
  readonly from: number;
  readonly decoration: Decoration;
  readonly number: number;
  readonly owner: string;
}

export interface OptimisticCodeLines {
  readonly owner: string;
  readonly affectedFrom: number;
  readonly firstCodeLine: number;
  readonly lineDelta: number;
  readonly rows: readonly { readonly from: number; readonly number: number; readonly template: Decoration; readonly markerOnly: boolean | undefined }[];
  readonly addedQuoteMarker?: { readonly from: number; readonly to: number; readonly decoration: Decoration };
  readonly removedQuoteMarker?: { readonly from: number; readonly to: number; readonly decoration: Decoration; readonly owner: string };
}

/**
 * Preserve a confirmed native code body's visible line geometry and numbers
 * for a single newline insertion or join. Quoted bodies must retain their
 * confirmed prefix; fence-like edits and uncertain boundaries fall back.
 */
export function resolveOptimisticCodeLines(
  decorations: DecorationSet,
  transaction: Transaction,
): OptimisticCodeLines | undefined {
  const changes: Array<{ from: number; to: number; fromB: number; toB: number; inserted: string }> = [];
  transaction.changes.iterChanges((from, to, fromB, toB, inserted) => {
    changes.push({ from, to, fromB, toB, inserted: inserted.length > 4096 ? "?" : inserted.toString() });
  });
  const change = changes.length === 1 ? changes[0] : undefined;
  if (change === undefined) return undefined;
  const oldLine = transaction.startState.doc.lineAt(change.from);
  const endLine = transaction.startState.doc.lineAt(change.to);
  const inserting = oldLine.number === endLine.number && change.inserted.startsWith("\n") &&
    !change.inserted.slice(1).includes("\n");
  const joining = change.to > change.from && change.inserted === "" && endLine.number > oldLine.number;
  if (!inserting && !joining) return undefined;

  const otherOldLine = joining ? endLine : oldLine;
  let candidate: CodeRow | undefined;
  decorations.between(oldLine.from, oldLine.from, (from, _to, decoration) => {
    if (from !== oldLine.from || decoration.spec.jotLiveSourceLine !== true) return;
    const attributes = decoration.spec.attributes as Record<string, string> | undefined;
    const owner = attributes?.["data-jot-code-owner"];
    const number = Number(attributes?.["data-jot-line-number"]);
    if (typeof owner === "string" && Number.isSafeInteger(number) && number > 0) {
      candidate = { from, decoration, number, owner };
    }
  });
  if (candidate === undefined) return undefined;
  const attributes = candidate.decoration.spec.attributes as Record<string, string> | undefined;
  const quoted = attributes?.["data-jot-quote-depth"] === undefined ? undefined :
    quotedCodeLineAt(decorations, transaction.startState.doc, oldLine.from);
  if (attributes?.["data-jot-quote-depth"] !== undefined && quoted === undefined) return undefined;
  const otherQuoted = quoted === undefined || !joining ? undefined :
    quotedCodeLineAt(decorations, transaction.startState.doc, otherOldLine.from);
  if (quoted === undefined) {
    if (inserting && !/^\n[ \t]{0,64}$/u.test(change.inserted)) return undefined;
  } else {
    if (Number(attributes?.["data-jot-quote-open"]) !== 0 ||
        Number(attributes?.["data-jot-quote-close"]) !== 0) return undefined;
    if (inserting && (!change.inserted.startsWith(`\n${quoted.prefix}`) ||
        !/^[ \t]{0,4096}$/u.test(change.inserted.slice(1 + quoted.prefix.length)) ||
        change.from < quoted.prefixTo)) return undefined;
    if (joining && (change.to - change.from > 513 || otherQuoted === undefined || otherQuoted.codeOwner !== quoted.codeOwner ||
        otherQuoted.quoteOwner !== quoted.quoteOwner || otherQuoted.depth !== quoted.depth ||
        change.from !== quoted.to || change.to !== otherQuoted.prefixTo ||
        transaction.startState.doc.sliceString(change.from, change.to) !== `\n${otherQuoted.prefix}`)) return undefined;
  }
  const firstNew = transaction.newDoc.lineAt(change.fromB);
  const lastNew = transaction.newDoc.lineAt(change.toB);
  // Splitting text into a possible closing fence can change the block itself;
  // leave that case to Rust rather than extrapolating old code semantics.
  const couldBeFence = (line: typeof firstNew): boolean => {
    const head = transaction.newDoc.sliceString(line.from, Math.min(line.to, line.from + (quoted?.prefix.length ?? 0) + 256));
    const prefix = quoted === undefined ? undefined : quotePrefix(head, 0, quoted.depth);
    if (quoted !== undefined && prefix?.depth !== quoted.depth) return true;
    return /^[ \t]{0,3}(?:`{3}|~{3})/u.test(prefix === undefined ? head : head.slice(prefix.to));
  };
  if (couldBeFence(firstNew) || couldBeFence(lastNew)) return undefined;

  const rows: CodeRow[] = [];
  decorations.between(0, transaction.startState.doc.length, (from, _to, decoration) => {
    if (decoration.spec.jotLiveSourceLine !== true) return;
    const attributes = decoration.spec.attributes as Record<string, string> | undefined;
    const owner = attributes?.["data-jot-code-owner"];
    const number = Number(attributes?.["data-jot-line-number"]);
    if (typeof owner !== "string" || !Number.isSafeInteger(number) || number < 1) return;
    rows.push({ from, decoration, number, owner });
  });
  const current = rows.find(row => row.from === oldLine.from && row.owner === candidate?.owner);
  if (current === undefined) return undefined;
  if (joining && !rows.some(row => row.from === otherOldLine.from && row.owner === current.owner)) return undefined;
  const firstCodeLine = oldLine.number - current.number + 1;
  if (firstCodeLine < 1 || firstCodeLine > transaction.startState.doc.lines) return undefined;
  const start = transaction.startState.doc.line(firstCodeLine).from;
  const newFirstLine = transaction.newDoc.lineAt(transaction.changes.mapPos(start, -1)).number;
  // CodeMirror's change invalidation includes one position on either side of
  // the edit. At the start of an empty line that includes the previous line's
  // decoration, which must also be restored for rapid consecutive Enters.
  const affectedFrom = transaction.newDoc.lineAt(Math.max(0, change.fromB - 1)).from;
  const nextRows = new Map<number, { number: number; template: Decoration; markerOnly: boolean | undefined }>();
  const markerOnly = (line: typeof firstNew): boolean | undefined => {
    if (quoted === undefined) return undefined;
    if (line.length > 512) return false;
    const prefix = quotePrefix(line.text, 0, quoted.depth);
    return prefix?.depth === quoted.depth && prefix.to === line.length;
  };
  for (const row of rows) {
    if (row.owner !== current.owner) continue;
    const position = transaction.changes.mapPos(row.from, -1);
    const line = transaction.newDoc.lineAt(position);
    const number = line.number - newFirstLine + 1;
    if (number > 0 && !nextRows.has(line.from)) nextRows.set(line.from, { number, template: row.decoration, markerOnly: markerOnly(line) });
  }
  for (let number = firstNew.number; number <= lastNew.number; number += 1) {
    const line = transaction.newDoc.line(number);
    if (!nextRows.has(line.from)) nextRows.set(line.from, {
      number: line.number - newFirstLine + 1, template: current.decoration, markerOnly: markerOnly(line),
    });
  }
  return {
    owner: current.owner,
    affectedFrom,
    firstCodeLine,
    lineDelta: inserting ? 1 : oldLine.number - otherOldLine.number,
    rows: [...nextRows].map(([from, row]) => ({ from, ...row })),
    ...(quoted !== undefined && inserting ? { addedQuoteMarker: {
      from: lastNew.from, to: lastNew.from + quoted.prefix.length, decoration: quoted.marker,
    } } : {}),
    ...(otherQuoted !== undefined && joining ? { removedQuoteMarker: {
      from: otherQuoted.from, to: otherQuoted.prefixTo, decoration: otherQuoted.marker, owner: otherQuoted.quoteOwner,
    } } : {}),
  };
}

export function applyOptimisticCodeLines(
  decorations: DecorationSet,
  atomic: DecorationSet,
  edit: OptimisticCodeLines,
  numberWidth?: number,
): { readonly decorations: DecorationSet; readonly atomic: DecorationSet } {
  const add = edit.rows.filter(row => numberWidth !== undefined || row.from >= edit.affectedFrom).map(row => {
    const spec = row.template.spec;
    const attributes: Record<string, string> = { ...(spec.attributes as Record<string, string>), "data-jot-line-number": String(row.number) };
    if (row.markerOnly === true) attributes["data-jot-quote-marker-only"] = "true";
    else if (row.markerOnly === false) delete attributes["data-jot-quote-marker-only"];
    if (numberWidth !== undefined) {
      const styles = (attributes["style"] ?? "").split(";").filter(value =>
        value.length > 0 && !/^--jot-code-number-width:/u.test(value.trim()));
      styles.push(`--jot-code-number-width:${numberWidth}ch`);
      attributes["style"] = styles.join(";");
    }
    return Decoration.line({ ...spec, attributes }).range(row.from);
  });
  const remove = (from: number, _to: number, decoration: Decoration): boolean =>
    decoration !== edit.removedQuoteMarker?.decoration && !((numberWidth !== undefined || from >= edit.affectedFrom) &&
      decoration.spec.jotLiveSourceLine === true &&
      (decoration.spec.attributes as Record<string, string> | undefined)?.["data-jot-code-owner"] === edit.owner);
  const marker = edit.addedQuoteMarker?.decoration.range(edit.addedQuoteMarker.from, edit.addedQuoteMarker.to);
  return {
    decorations: decorations.update({ filter: remove, add: marker === undefined ? add : [...add, marker], sort: true }),
    atomic: atomic.update({ filter: (_from, _to, decoration) => decoration !== edit.removedQuoteMarker?.decoration,
      add: marker === undefined ? [] : [marker], sort: true }),
  };
}
