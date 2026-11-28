import { ChangeSet } from "@codemirror/state";
import {
  PROTOCOL_VERSION,
  WORKER_REQUEST_ID_MIN,
  type AnalysisId,
  type AnalysisState,
  type DocumentId,
  type RenderNode,
  type ResponseEnvelope,
  type Revision,
  type SyntaxProfile,
  type Utf16Offset,
} from "../../../editor-protocol/src/index.js";
import {
  createAnalysisRequest,
  EditorDocumentAdapter,
  EditorDocumentSession,
  EditorTransactionCoordinator,
  normalizeInsertedText,
  range,
  singleTextEdit,
  SyntaxBlockIndex,
  Utf16TextModel,
} from "../../src/adapter/index.js";
import { codeMirrorChangesToTextEdits } from "../../src/hosts/source/index.js";

const DOCUMENT = "adapter-document" as DocumentId;
const PROFILE: SyntaxProfile = {
  id: "jot",
  version: 1,
  enabledExtensions: [],
};
const REVISION_0 = 0 as Revision;
const REVISION_1 = 1 as Revision;
const ANALYSIS_0 = "adapter:r0:a1" as AnalysisId;
const ANALYSIS_1 = "adapter:r1:a2" as AnalysisId;

function text_model_updates_utf16_lines_without_a_full_rebuild_contract(): void {
  const model = new Utf16TextModel("a😀\nb\nc");
  equal(model.utf16Length, 7);
  equal(model.lineCount, 3);
  equal(model.lineAt(offset(4)), 1);
  throws(() => model.lineAt(offset(2)), "surrogate halves are rejected");
  model.apply([{ range: range(4, 5), insert: "B\nX" }]);
  equal(model.text, "a😀\nB\nX\nc");
  equal(model.lineCount, 4);
  equal(model.lines(1, 3).map((line) => line.text).join(","), "B,X");
  equal(normalizeInsertedText("a\r\nb\rc"), "a\nb\nc");
}

function source_line_previews_keep_the_full_range(): void {
  const model = new Utf16TextModel("short\n😀abcdef\ntail");
  const previews = model.linePreviews(1, 2, 3);
  equal(previews.length, 1);
  equal(previews[0]?.text, "😀a");
  equal(previews[0]?.fullUtf16Length, 8);
  equal(previews[0]?.range.to, 14 as Utf16Offset);
}

function text_diff_produces_one_utf16_safe_replacement(): void {
  equal(singleTextEdit("alpha beta", "alpha BETA").length, 1);
  const edit = singleTextEdit("alpha beta", "alpha BETA")[0]!;
  equal(edit.range.from, offset(6));
  equal(edit.range.to, offset(10));
  equal(edit.insert, "BETA");

  const emoji = singleTextEdit("a😀b", "a😁b")[0]!;
  equal(emoji.range.from, offset(1));
  equal(emoji.range.to, offset(3));
  equal(emoji.insert, "😁");
  const repeatedEmoji = singleTextEdit("😀", "😀😀", 3)[0]!;
  equal(repeatedEmoji.range.from, offset(2));
  equal(repeatedEmoji.range.to, offset(2));
  equal(repeatedEmoji.insert, "😀");
  equal(singleTextEdit("same", "same").length, 0);
}

function text_diff_uses_selection_to_resolve_repeated_newline_affinity(): void {
  const before = "code\n``` end";
  const after = "code\n\n``` end";
  const edit = singleTextEdit(before, after, 5)[0]!;
  equal(edit.range.from, 4);
  equal(edit.range.to, 4);
  equal(edit.insert, "\n");
}

function codemirror_changes_remain_exact_multi_edits(): void {
  const changes = ChangeSet.of([
    { from: 1, to: 3, insert: "😁" },
    { from: 5, to: 5, insert: "!" },
  ], 5);
  const edits = codeMirrorChangesToTextEdits(changes);
  equal(edits.length, 2);
  equal(edits[0]?.range.from, offset(1));
  equal(edits[0]?.range.to, offset(3));
  equal(edits[0]?.insert, "😁");
  equal(edits[1]?.range.from, offset(5));
  equal(edits[1]?.insert, "!");
}

function analysis_hints_preserve_utf16_boundaries_after_multiple_edits(): void {
  const adapter = new EditorDocumentAdapter({
    documentId: DOCUMENT, generation: 1, source: "x😀y😀z", syntaxProfile: PROFILE,
  });
  const request = adapter.transaction({
    origin: "keyboard",
    edits: [
      { range: range(0, 1), insert: "中a😀" },
      { range: range(4, 6), insert: "🦊" },
    ],
    viewport: { visibleRanges: [range(3, 5)], activeRange: range(8, 8) },
  });
  if (request.body.type !== "apply-transaction") throw new Error("wrong request");
  const priority = request.body.transaction.analysis!.priority;
  // Target text: 中a😀😀y🦊z. CM may place a viewport edge between
  // the surrogate halves even though editing ranges remain valid.
  equal(JSON.stringify(priority.visibleRanges), JSON.stringify([range(2, 6)]));
  equal(JSON.stringify(priority.activeRange), JSON.stringify(range(7, 7)));
  equal(JSON.stringify(priority.priorityRanges), JSON.stringify([range(0, 4), range(7, 9)]));

  const source = "a😀b".repeat(100);
  const edits = Array.from({ length: 100 }, (_, index) => ({ range: range(index * 4 + 3, index * 4 + 4), insert: "xy🦊" }));
  const result = "a😀xy🦊".repeat(100);
  const ranges = Array.from({ length: result.length + 1 }, (_, index) => range(index, index));
  const many = createAnalysisRequest({ edits, viewport: { visibleRanges: ranges }, mode: "preview",
    sourceBeforeEdits: source, documentUtf16Length: result.length });
  for (let index = 0; index < ranges.length; index += 1) {
    const previous = result.charCodeAt(index - 1), next = result.charCodeAt(index);
    const splitsPair = previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    equal(Number(many.priority.visibleRanges[index]!.from), splitsPair ? index - 1 : index);
    equal(Number(many.priority.visibleRanges[index]!.to), splitsPair ? index - 1 : index);
  }
}

function heading_sections_are_revision_scoped_metadata(): void {
  const adapter = new EditorDocumentAdapter({
    documentId: DOCUMENT, generation: 7, source: "# A\nbody", syntaxProfile: PROFILE,
  });
  const handshake = adapter.handshake();
  equal(handshake.body.type, "handshake");
  const capabilities = adapter.accept(response(handshake.requestId, {
    type: "handshake-ack", engineVersion: "test", capabilities: ["heading-section-projection"],
  }));
  equal(capabilities.capabilities?.[0], "heading-section-projection");
  const section = {
    type: "replace-children" as const, parentId: "1", axis: "heading-section" as const,
    from: 0, removeCount: 1, totalChildren: 1,
    inserted: [{ ...render("1", 0, 3), kind: "heading-section" }],
  };
  const patch = { documentId: DOCUMENT, documentRevision: REVISION_0, viewRevision: 0, operations: [section] };
  const effect = adapter.accept(response(10, { type: "projection-ready", patch }));
  equal(effect.renderPatch?.operations[0]?.axis, "heading-section");
  equal(effect.projectionChanged, false);
  equal(adapter.projection.totalChildren("1", "heading-section"), 0, "section metadata must not enter the child cache");
  adapter.setMode("source");
  const stale = adapter.accept(response(11, { type: "projection-ready", patch }));
  equal(stale.renderPatch, undefined, "an old view cannot apply a late section result");
}

function adapter_translates_input_and_applies_revision_bound_patches(): void {
  const adapter = new EditorDocumentAdapter({
    documentId: DOCUMENT,
    generation: 7,
    source: "first\nsecond\nthird",
    syntaxProfile: PROFILE,
  });
  const open = adapter.open({
    visibleRanges: [range(0, 12)],
    activeRange: range(6, 6),
  });
  equal(open.body.type, "open-document");
  adapter.accept(response(open.requestId, {
    type: "document-opened",
    revision: REVISION_0,
    sourceUtf16Len: 18,
    sourceLineCount: 3,
    analysis: complete(REVISION_0, ANALYSIS_0, 3),
  }));

  adapter.accept(response(9, {
    type: "projection-ready",
    patch: {
      documentId: DOCUMENT,
      documentRevision: REVISION_0,
      viewRevision: 0,
      operations: [{
        type: "replace-children",
        parentId: "0",
        axis: "syntax-children",
        from: 0,
        removeCount: 3,
        totalChildren: 3,
        inserted: [
          render("1", 0, 5),
          render("2", 6, 12),
          render("3", 13, 18),
        ],
      }],
    },
  }));
  adapter.accept(response(10, {
    type: "projection-ready",
    patch: {
      documentId: DOCUMENT,
      documentRevision: REVISION_0,
      viewRevision: 0,
      operations: [{
        type: "replace-children",
        parentId: "2",
        axis: "source-lines",
        from: 50,
        removeCount: 2,
        totalChildren: 100,
        inserted: [
          { ...render("2:line:500", 500, 510), kind: "source-line", mode: "source" },
          { ...render("2:line:510", 510, 520), kind: "source-line", mode: "source" },
        ],
      }],
    },
  }));
  equal(adapter.projection.totalBlocks, 3);
  equal(adapter.projection.totalChildren("2", "source-lines"), 100);
  equal(adapter.projection.nodes("2", "source-lines", 50, 52).length, 2);

  const request = adapter.transaction({
    origin: "keyboard",
    edits: [{ range: range(6, 12), insert: "second revised\r\ncontinued" }],
    viewport: {
      visibleRanges: [range(0, 30)],
      activeRange: range(30, 30),
    },
    selectionAfter: { anchor: offset(30), head: offset(30) },
  });
  equal(request.body.type, "apply-transaction");
  if (request.body.type !== "apply-transaction") throw new Error("wrong request");
  const transaction = request.body.transaction;
  equal(transaction.edits[0]!.insert, "second revised\ncontinued");
  equal(transaction.analysis?.purpose, "preview");
  equal(transaction.analysis?.priority.activeRange?.to, offset(30));
  equal(request.body.projection?.revision, REVISION_1);
  equal(request.body.projection?.slices.length, 1);
  equal(request.body.projection?.slices[0]?.parentId, "0");
  equal(
    JSON.stringify(request.body.projection?.slices[0]?.window),
    JSON.stringify({
      type: "around-range",
      range: { from: offset(6), to: offset(30) },
      before: 2,
      after: 2,
    }),
  );

  const transactionId = transaction.id;
  adapter.accept(response(request.requestId, {
    type: "transaction-committed",
    patch: {
      transactionId,
      baseRevision: REVISION_0,
      revision: REVISION_1,
      changedTextRange: {
        before: range(6, 12),
        after: range(6, 30),
      },
      syntax: {
        reparsedRange: range(6, 30),
        totalBlocks: 4,
        changedBlocks: 2,
        blockChanges: [{
          fromBlock: 1,
          removeCount: 1,
          inserted: [
            metadata("20", 6, 20),
            metadata("21", 21, 30),
          ],
        }],
      },
      diagnostics: { removedIds: [], upserted: [] },
    },
    analysis: complete(REVISION_1, ANALYSIS_1, 4),
    renderPatch: {
      documentId: DOCUMENT,
      documentRevision: REVISION_1,
      viewRevision: 0,
      operations: [{
        type: "replace-children",
        parentId: "0",
        axis: "syntax-children",
        from: 1,
        removeCount: 2,
        totalChildren: 4,
        inserted: [
          render("20", 6, 20),
          render("21", 21, 30),
        ],
      }],
    },
  }));

  equal(adapter.text.text, "first\nsecond revised\ncontinued\nthird");
  equal(adapter.text.lineCount, 4);
  equal(adapter.revision, REVISION_1);
  equal(adapter.blocks.blocks.length, 4);
  equal(adapter.projection.nodeAt("0", "syntax-children", 1)?.id, "20");
  equal(adapter.projection.nodeAt("0", "syntax-children", 2)?.id, "21");
  equal(adapter.blocks.blocks[3]!.id, "3");
  equal(adapter.blocks.blocks[3]!.sourceRange.from, offset(31));
  equal(adapter.blocks.blocks[3]!.sourceRange.to, offset(36));
  equal(adapter.sourceLines(1, 3).map((line) => line.text).join("|"), "second revised|continued");

  const stale = adapter.accept(response(99, {
      type: "projection-ready",
      patch: {
        documentId: DOCUMENT,
        documentRevision: REVISION_0,
        viewRevision: 0,
        operations: [],
      },
    }));
  equal(stale.projectionChanged, false);
}

function mode_translation_keeps_source_and_preview_paths_separate(): void {
  const adapter = new EditorDocumentAdapter({
    documentId: DOCUMENT,
    generation: 1,
    source: "one\ntwo",
    syntaxProfile: PROFILE,
    mode: "source",
  });
  equal(adapter.sourceLines(0, 2).length, 2);
  adapter.setMode("preview");
  const preview = adapter.projectRoot(0, 20);
  equal(preview.body.type, "project");
  if (preview.body.type === "project") {
    equal(preview.body.projection.mode, "preview");
    equal(preview.body.projection.viewRevision, 1);
    equal(preview.body.projection.slices[0]?.parentId, "0");
    equal(preview.body.projection.slices[0]?.axis, "syntax-children");
  }
  adapter.setMode("hybrid");
  const hybrid = adapter.projectSourceLines("42", 100, 140);
  if (hybrid.body.type === "project") {
    equal(hybrid.body.projection.mode, "hybrid");
    equal(hybrid.body.projection.viewRevision, 2);
    equal(hybrid.body.projection.slices[0]?.parentId, "42");
    equal(hybrid.body.projection.slices[0]?.axis, "source-lines");
  }

  const anchored = adapter.projectAround(
    "0",
    "syntax-children",
    range(4, 4),
    8,
    32,
    0,
  );
  if (anchored.body.type === "project") {
    const window = anchored.body.projection.slices[0]?.window;
    equal(window?.type, "around-range");
    if (window?.type === "around-range") {
      equal(window.range.from, offset(4));
      equal(window.before, 8);
      equal(window.after, 32);
    }
  }
}

async function session_connects_requests_and_background_updates(): Promise<void> {
  const endpoint = new LoopbackEndpoint();
  const background: AnalysisState[] = [];
  const backgroundUpdateSequences: number[] = [];
  const observed: string[] = [];
  const protocolEvents: string[] = [];
  const observerErrors: unknown[] = [];
  const session = new EditorDocumentSession({
    endpoint,
    documentId: DOCUMENT,
    generation: 7,
    source: "one\r\ntwo",
    syntaxProfile: PROFILE,
    onBackgroundEffect: (effect) => {
      if (effect.analysis !== undefined) background.push(effect.analysis);
      if (effect.analysisUpdate !== undefined) {
        backgroundUpdateSequences.push(effect.analysisUpdate.sequence);
      }
    },
    onProtocolEvent: (event) => {
      protocolEvents.push(
        event.direction === "request"
          ? `request:${event.message.requestId}:${event.message.body.type}`
          : `response:${event.channel}:${event.message.requestId}:${event.message.body.type}`,
      );
    },
    onError: (error) => observerErrors.push(error),
  });
  session.subscribe((effect) => {
    observed.push(effect.analysis?.state ?? "projection");
  });
  session.subscribe(() => {
    throw new Error("observer failure must not reject a confirmed request");
  });
  endpoint.respond = (request) => {
    if (request.body.type !== "open-document") throw new Error("expected open request");
    equal(request.body.source, "one\r\ntwo", "open preserves original EOL metadata");
    return response(request.requestId, {
      type: "document-opened",
      revision: REVISION_0,
      sourceUtf16Len: 7,
      sourceLineCount: 2,
      analysis: complete(REVISION_0, ANALYSIS_0, 2),
    });
  };
  await session.open({ visibleRanges: [range(0, 7)] });
  equal(session.adapter.text.text, "one\ntwo");
  equal(observerErrors.length, 1);

  endpoint.respond = (request) => {
    if (request.body.type !== "apply-transaction") throw new Error("expected transaction");
    return response(request.requestId, {
      type: "transaction-committed",
      patch: {
        transactionId: request.body.transaction.id,
        baseRevision: REVISION_0,
        revision: REVISION_1,
        changedTextRange: { before: range(4, 7), after: range(4, 10) },
        diagnostics: { removedIds: [], upserted: [] },
      },
      analysis: complete(REVISION_1, ANALYSIS_1, 2),
    });
  };
  await session.transact({
    origin: "keyboard",
    edits: [{ range: range(4, 7), insert: "second" }],
    viewport: { visibleRanges: [range(0, 10)], activeRange: range(10, 10) },
  });
  equal(session.adapter.text.text, "one\nsecond");
  equal(session.adapter.revision, REVISION_1);
  equal(observerErrors.length, 2);

  endpoint.emit(response(WORKER_REQUEST_ID_MIN, {
    type: "analysis-state-changed",
    analysis: complete(REVISION_1, ANALYSIS_1, 2),
    update: {
      analysisId: ANALYSIS_1,
      targetRevision: REVISION_1,
      sequence: 7,
      confirmedRanges: [range(0, 10)],
      dirtyRanges: [],
      diagnostics: { removedIds: [], upserted: [] },
      metrics: {
        processedSourceLines: 2,
        processedBlocks: 2,
        processedUtf16Units: 10,
        elapsedMicros: 120,
        yielded: false,
      },
    },
  }));
  equal(background.length, 1);
  equal(backgroundUpdateSequences.join(","), "7");
  equal(observerErrors.length, 3);
  equal(observed.join(","), "complete,complete,complete");
  equal(protocolEvents.join(","), [
    "request:0:open-document",
    "response:foreground:0:document-opened",
    "request:1:apply-transaction",
    "response:foreground:1:transaction-committed",
    `response:background:${WORKER_REQUEST_ID_MIN}:analysis-state-changed`,
  ].join(","));
  session.dispose();
  equal(endpoint.hasListener, false);
}

async function projection_owner_stays_local_and_reaches_subscribers(): Promise<void> {
  const endpoint = new LoopbackEndpoint();
  const session = new EditorDocumentSession({ endpoint, documentId: DOCUMENT, generation: 7,
    source: "", syntaxProfile: PROFILE });
  const owner = Symbol("root-window");
  const other = Symbol("other");
  const observed: string[] = [];
  const requests: import("../../../editor-protocol/src/index.js").RequestEnvelope[] = [];
  session.subscribe(effect => { observed.push(session.ownsProjection(effect, owner) ? "root" :
    session.ownsProjection(effect, other) ? "other" : "unowned"); });
  endpoint.respond = request => {
    equal(request.body.type, "project");
    equal(JSON.stringify(request).includes("root-window"), false, "local owner must not enter the Worker protocol");
    equal(typeof structuredClone(request), "object", "Worker requests must remain structured-cloneable");
    requests.push(request);
    return undefined;
  };
  const slice = { parentId: "0", axis: "syntax-children" as const,
    window: { type: "index" as const, from: 0, toExclusive: 0 }, maxDepth: 0 };
  const first = session.project([slice], { owner });
  const second = session.project([slice], { owner: other });
  const resultFor = (requestId: number) => response(requestId, { type: "projection-ready", patch: {
      documentId: DOCUMENT, documentRevision: REVISION_0, viewRevision: 0,
      operations: [{ type: "replace-children", parentId: "0", axis: "syntax-children",
        from: 0, removeCount: 0, totalChildren: 0, inserted: [] }],
    } });
  endpoint.emit(resultFor(requests[1]!.requestId));
  endpoint.emit(resultFor(requests[0]!.requestId));
  const [effect, otherEffect] = await Promise.all([first, second]);
  equal(effect.projectionChanged, true);
  equal(session.ownsProjection(effect, owner), true);
  equal(session.ownsProjection(otherEffect, other), true);
  equal(observed.join(","), "other,root", "out-of-order responses retain their own owners");
  equal(session.ownsProjection(effect, other), false);
  equal(typeof structuredClone(effect), "object", "local ownership must not make effects non-cloneable");
  session.dispose();
}

function late_projection_does_not_cancel_a_commit_or_seed_the_new_view(): void {
  const adapter = new EditorDocumentAdapter({ documentId: DOCUMENT, generation: 7, source: "a", syntaxProfile: PROFILE });
  const tx = adapter.transaction({ origin: "api", edits: [{ range: range(0, 1), insert: "b" }], viewport: { visibleRanges: [] } });
  if (tx.body.type !== "apply-transaction") throw new Error("expected edit");
  adapter.setMode("source");
  const patch = { documentId: DOCUMENT, documentRevision: REVISION_1, viewRevision: 0,
    operations: [{ type: "replace-children" as const, parentId: "0", axis: "syntax-children" as const,
      from: 0, removeCount: 1, totalChildren: 1, inserted: [render("old", 0, 1)] }] };
  const effect = adapter.accept(response(tx.requestId, { type: "transaction-committed",
    patch: { transactionId: tx.body.transaction.id, baseRevision: REVISION_0, revision: REVISION_1,
      changedTextRange: { before: range(0, 1), after: range(0, 1) }, diagnostics: { removedIds: [], upserted: [] } },
    analysis: complete(REVISION_1, ANALYSIS_1, 1), renderPatch: patch }));
  equal(adapter.text.text, "b");
  equal(effect.documentPatch?.revision, REVISION_1);
  equal(effect.renderPatch, undefined);
  equal(adapter.accept(response(7, { type: "projection-ready", patch })).renderPatch, undefined);
  equal(adapter.projection.totalBlocks, 0);
  equal(adapter.blocks.blocks.length, 0);
  const fresh = adapter.accept(response(8, { type: "projection-ready", patch: { ...patch, viewRevision: 1 } }));
  equal(fresh.projectionChanged, true);
  equal(adapter.blocks.blocks.length, 1);
}

function replacing_text_preserves_unchanged_block_metadata(): void {
  const index = new SyntaxBlockIndex();
  index.seedProjection(0, [render("edited", 0, 4), render("following", 5, 9)], 3);
  const [, following, unloaded] = index.blocks;
  index.applyTextEdits([{ range: range(1, 2), insert: "字" }]);
  equal(index.blocks[0]?.dirty, true);
  equal(index.blocks[1], following, "an equal-length replacement preserves following block metadata");
  index.applyTextEdits([{ range: range(0, 0), insert: "字" }]);
  equal(index.blocks[1]?.sourceRange.from, offset(6));
  equal(index.blocks[2], unloaded, "an unloaded slot has no document coordinates to shift");
}

function commands_only_use_confirmed_blocks_in_sparse_projections(): void {
  const source = "before\n| A | B |";
  const adapter = new EditorDocumentAdapter({ documentId: DOCUMENT, generation: 7, source, syntaxProfile: PROFILE });
  adapter.blocks.seedProjection(1, [{ ...render("table", 7, source.length), kind: "table" }], 100);
  equal(adapter.confirmedBlockAt(source, 9)?.id, "table");
  equal(adapter.confirmedBlockAt("changed" + source, 9), undefined);
  equal(adapter.confirmedBlockAt(source, 2), undefined);
  adapter.blocks.applyTextEdits([{ range: range(9, 10), insert: "" }]);
  equal(adapter.confirmedBlockAt(source, 9), undefined);
}

async function fatal_worker_failure_settles_foreground_and_queued_requests(): Promise<void> {
  const endpoint = new LoopbackEndpoint();
  const options = { endpoint, documentId: DOCUMENT, generation: 7, source: "a", syntaxProfile: PROFILE };
  const errors: unknown[] = [];
  const session = new EditorDocumentSession({ ...options, onError: error => errors.push(error) });
  throws(() => new EditorDocumentSession(options), "sessions must not claim the same endpoint");
  const coordinator = new EditorTransactionCoordinator(session);
  const viewport = { visibleRanges: [] };
  const intent = { origin: "api" as const, edits: [{ range: range(0, 1), insert: "b" }], viewport };
  let signal!: () => void;
  const sent = new Promise<void>(resolve => { signal = resolve; });
  endpoint.respond = request => { if (request.body.type === "apply-transaction") signal(); return undefined; };
  let queuedBuilds = 0;
  const pending = Promise.allSettled([
    session.projectRoot(0, 1),
    coordinator.enqueue(() => intent),
    coordinator.enqueue(() => { queuedBuilds += 1; return intent; }),
  ]);
  await sent;
  endpoint.emit({ type: "editor-worker-fatal", message: "Wasm failed" });
  for (const result of await pending) {
    equal(result.status, "rejected");
    if (result.status === "rejected") equal(result.reason.message, "Wasm failed");
  }
  await coordinator.settled();
  equal(errors.length, 1);
  equal(queuedBuilds, 0);
  equal(session.adapter.text.text, "a");
  equal(session.adapter.revision, REVISION_0);
  equal(endpoint.hasListener, false);
  coordinator.dispose();
  session.dispose();
}

class LoopbackEndpoint {
  respond: ((request: import("../../../editor-protocol/src/index.js").RequestEnvelope) => ResponseEnvelope | undefined) | undefined;
  #listener: ((event: MessageEvent<unknown>) => void) | undefined;

  get hasListener(): boolean {
    return this.#listener !== undefined;
  }

  postMessage(message: unknown): void {
    const request = message as import("../../../editor-protocol/src/index.js").RequestEnvelope;
    const returned = this.respond?.(request);
    if (returned !== undefined) this.emit(returned);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listener = listener;
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (this.#listener === listener) this.#listener = undefined;
  }

  emit(value: unknown): void {
    this.#listener?.({ data: value } as MessageEvent<unknown>);
  }
}

function complete(revision: Revision, id: AnalysisId, totalBlocks: number): AnalysisState {
  return {
    state: "complete",
    analysisId: id,
    targetRevision: revision,
    sequence: 0,
    confirmedRange: range(0, 100),
    totalBlocks,
  };
}

function response(requestId: number, body: ResponseEnvelope["body"]): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    generation: 7,
    documentId: DOCUMENT,
    body,
  };
}

function render(id: string, from: number, to: number): RenderNode {
  return {
    id,
    kind: "paragraph",
    sourceRange: range(from, to),
    contentVersion: 0,
    mode: "hybrid",
    childCount: 0,
    attributes: [],
    content: { type: "source" },
  };
}

function metadata(id: string, from: number, to: number) {
  return {
    id,
    kind: "paragraph",
    sourceRange: range(from, to),
    contentVersion: 0,
  };
}

function offset(value: number): Utf16Offset {
  return value as Utf16Offset;
}

function throws(action: () => void, message: string, expected = true): void {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  if (threw !== expected) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  }
}


// Differential oracle: validate every intermediate edit, not only initial load.
function text_model_sequential_edits_match_a_fresh_line_index(): void {
  const model = new Utf16TextModel("首行😀\nsecond\n\nlast\n");
  let seed = 42;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let step = 0; step < 400; step += 1) {
    const boundaries = [0];
    let position = 0;
    for (const point of model.text) { position += point.length; boundaries.push(position); }
    const a = random(boundaries.length), b = random(boundaries.length);
    const from = boundaries[Math.min(a, b)]!, to = boundaries[Math.max(a, b)]!;
    const insert = ["", "x", "😀", "\n", "中\n文\n", "é"][random(6)]!;
    const expected = model.text.slice(0, from) + insert + model.text.slice(to);
    model.apply([{ range: range(from, to), insert }]);
    equal(model.text, expected);
    const fresh = new Utf16TextModel(expected);
    equal(JSON.stringify(model.lines(0, model.lineCount)), JSON.stringify(fresh.lines(0, fresh.lineCount)));
    let offsetValue = 0;
    for (const point of expected) {
      equal(model.lineAt(offset(offsetValue)), fresh.lineAt(offset(offsetValue)));
      offsetValue += point.length;
    }
    equal(model.lineAt(offset(expected.length)), fresh.lineAt(offset(expected.length)));
  }
}

function batched_text_edits_match_reverse_application(): void {
  const source = "一😀\nsecond\n\nlast\n";
  for (const edits of [
    [{ range: range(0, 1), insert: "" }, { range: range(4, 10), insert: "文\n中" },
      { range: range(11, 11), insert: "\n" }],
    [{ range: range(3, 4), insert: "" }, { range: range(4, 4), insert: "新\n" },
      { range: range(4, 4), insert: "😀" }],
    [{ range: range(1, 3), insert: "🧪" }, { range: range(source.length, source.length), insert: "结束" }],
  ]) {
    const expected = new Utf16TextModel(source);
    const changes = edits.slice().reverse().flatMap(edit => expected.apply([edit]));
    const batch = new Utf16TextModel(source);
    equal(JSON.stringify(batch.apply(edits)), JSON.stringify(changes));
    equal(batch.text, expected.text);
    equal(JSON.stringify(batch.lines(0, batch.lineCount)), JSON.stringify(expected.lines(0, expected.lineCount)));
  }
}

function one_table_edit_requests_its_root_neighborhood_once(): void {
  const source = "| A | B |\n| --- | --- |\n| x | y |\n\n尾部";
  const adapter = new EditorDocumentAdapter({
    documentId: DOCUMENT, generation: 1, source, syntaxProfile: PROFILE,
  });
  const end = source.indexOf("\n\n");
  adapter.blocks.seedProjection(0, [{ ...render("table", 0, end), kind: "table" }], 3);
  const edits = source.slice(0, end).split("\n").map((row, index, all) => {
    const from = all.slice(0, index).reduce((sum, previous) => sum + previous.length + 1, 0);
    return { range: range(from, from + row.length), insert: row.replace(/\| [^|]+ \|$/u, "|") };
  });
  const { body } = adapter.transaction({ origin: "keyboard", edits, viewport: { visibleRanges: [range(0, end)] } });
  if (body.type !== "apply-transaction") throw new Error("expected transaction");
  equal(body.projection?.slices.length, 1);
  equal(body.projection?.slices[0]?.parentId, "0");
  equal(JSON.stringify(body.transaction.edits), JSON.stringify(edits));
  adapter.blocks.applyTextEdits(edits);
  equal(adapter.blocks.blocks[0]?.sourceRange.to, offset(edits.map(edit => edit.insert).join("\n").length));
  equal(adapter.blocks.blocks[1]?.sourceRange.to, offset(0));
}

const tests: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
  ["text model updates UTF-16 lines", text_model_updates_utf16_lines_without_a_full_rebuild_contract],
  ["bounded line previews retain the full UTF-16 range", source_line_previews_keep_the_full_range],
  ["sequential edits match a fresh line index", text_model_sequential_edits_match_a_fresh_line_index],
  ["batched edits match reverse application", batched_text_edits_match_reverse_application],
  ["a table edit requests its root neighborhood once", one_table_edit_requests_its_root_neighborhood_once],
  ["text diff keeps UTF-16 boundaries valid", text_diff_produces_one_utf16_safe_replacement],
  ["text diff resolves repeated newline affinity", text_diff_uses_selection_to_resolve_repeated_newline_affinity],
  ["CodeMirror changes preserve exact multi-edit ranges", codemirror_changes_remain_exact_multi_edits],
  ["analysis hints stay UTF-16 safe after edits", analysis_hints_preserve_utf16_boundaries_after_multiple_edits],
  ["heading sections stay out of child caches and stale views", heading_sections_are_revision_scoped_metadata],
  ["adapter translates input and applies patches", adapter_translates_input_and_applies_revision_bound_patches],
  ["mode translation separates source and preview", mode_translation_keeps_source_and_preview_paths_separate],
  ["session connects requests and background updates", session_connects_requests_and_background_updates],
  ["replacements preserve unaffected block metadata", replacing_text_preserves_unchanged_block_metadata],
  ["command targets use confirmed sparse blocks", commands_only_use_confirmed_blocks_in_sparse_projections],
  ["late projection cannot seed the current view", late_projection_does_not_cancel_a_commit_or_seed_the_new_view],
  ["fatal Worker rejects outstanding work", fatal_worker_failure_settles_foreground_and_queued_requests],
  ["projection owner is local to the session", projection_owner_stays_local_and_reaches_subscribers],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
