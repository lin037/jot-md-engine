import {
  FRONTEND_REQUEST_ID_MAX,
  PROTOCOL_VERSION,
  type AnalysisUpdate,
  type AnalysisState,
  type DocumentId,
  type DocumentPatch,
  type DocumentTransaction,
  type EditorSelection,
  type HistoryIntent,
  type ProjectionMode,
  type ProjectionSlice,
  type RenderPatch,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Revision,
  type SyntaxProfile,
  type TextEdit,
  type TransactionId,
  type TransactionMetadata,
  type TransactionOrigin,
} from "@jot-md/editor-protocol";

import {
  createAnalysisRequest,
  type EditorAnalysisBudgets,
  type EditorViewport,
} from "./analysis-policy.js";
import { SyntaxBlockIndex } from "./block-index.js";
import { replacesMostDocument } from "./edit-batch.js";
import { ProjectionStore } from "./projection-store.js";
import {
  normalizeInsertedText,
  range,
  Utf16TextModel,
  validateEdits,
  type SourceLinePreview,
  type SourceLineSlice,
  type TextLineChange,
} from "./text-model.js";

const TRANSACTION_ROOT_NEIGHBORS = 2;

export interface EditorDocumentAdapterOptions {
  readonly documentId: DocumentId;
  readonly generation: number;
  readonly source: string;
  readonly syntaxProfile: SyntaxProfile;
  readonly mode?: ProjectionMode;
  readonly budgets?: EditorAnalysisBudgets;
}

export interface EditorEditIntent {
  readonly origin: TransactionOrigin;
  readonly edits: readonly TextEdit[];
  readonly viewport: EditorViewport;
  readonly selectionBefore?: EditorSelection;
  readonly selectionAfter?: EditorSelection;
  readonly history?: HistoryIntent;
  readonly metadata?: TransactionMetadata;
}

export interface AdapterEffect {
  readonly capabilities?: readonly string[];
  readonly analysis?: AnalysisState;
  readonly analysisUpdate?: AnalysisUpdate;
  readonly documentPatch?: DocumentPatch;
  readonly appliedEdits?: readonly TextEdit[];
  readonly lineChanges?: readonly TextLineChange[];
  readonly renderPatch?: RenderPatch;
  readonly projectionChanged: boolean;
}

/**
 * 把前端输入/视图意图翻译为协议消息，并把引擎已接受的响应写回文本、物理行、
 * 语法块和渲染缓存。
 */
export class EditorDocumentAdapter {
  readonly text: Utf16TextModel;
  readonly blocks = new SyntaxBlockIndex();
  readonly projection = new ProjectionStore();
  readonly #documentId: DocumentId;
  readonly #generation: number;
  readonly #profile: SyntaxProfile;
  readonly #openSource: string;
  readonly #budgets: EditorAnalysisBudgets | undefined;
  readonly #pending = new Map<TransactionId, DocumentTransaction>();
  readonly #pendingByRequest = new Map<number, TransactionId>();
  #revision = 0 as Revision;
  #mode: ProjectionMode;
  #requestId = 0;
  #transactionSequence = 0;
  #viewRevision = 0;
  #analysis: AnalysisState | undefined;

  constructor(options: EditorDocumentAdapterOptions) {
    this.#documentId = options.documentId;
    this.#generation = options.generation;
    this.#profile = options.syntaxProfile;
    this.#openSource = options.source;
    this.#mode = options.mode ?? "preview";
    this.#budgets = options.budgets;
    this.text = new Utf16TextModel(normalizeInsertedText(options.source));
  }

  get documentId(): DocumentId {
    return this.#documentId;
  }

  get revision(): Revision {
    return this.#revision;
  }

  get syntaxProfile(): SyntaxProfile {
    return this.#profile;
  }

  get mode(): ProjectionMode {
    return this.#mode;
  }

  get viewRevision(): number {
    return this.#viewRevision;
  }

  get analysis(): AnalysisState | undefined {
    return this.#analysis;
  }

  open(viewport: EditorViewport): RequestEnvelope {
    return this.#envelope({
      type: "open-document",
      // 打开时保留原始 EOL 序列；Rust 记录这些元数据，同时把权威编辑缓冲
      // 规范化为 LF。
      source: this.#openSource,
      syntaxProfile: this.#profile,
      analysis: createAnalysisRequest(
        {
          edits: [],
          viewport,
          mode: this.#mode,
          documentUtf16Length: this.text.utf16Length,
          sourceBeforeEdits: this.text.text,
        },
        this.#budgets,
      ),
    });
  }

  handshake(): RequestEnvelope {
    return this.#envelope({ type: "handshake", clientName: "jot-editor", clientVersion: "1" });
  }

  transaction(intent: EditorEditIntent): RequestEnvelope {
    if (this.#pending.size > 0) {
      throw new Error("wait for the current exact-revision transaction response");
    }
    const edits = intent.edits.map((edit) => ({
      range: edit.range,
      insert: normalizeInsertedText(edit.insert),
    }));
    validateEdits(this.text.text, edits);
    const nextLength = edits.reduce(
      (length, edit) =>
        length + edit.insert.length - (Number(edit.range.to) - Number(edit.range.from)),
      this.text.utf16Length,
    );
    const id = `${String(this.#documentId)}:tx${++this.#transactionSequence}` as TransactionId;
    const analysis = createAnalysisRequest(
      {
        edits,
        viewport: intent.viewport,
        mode: this.#mode,
        documentUtf16Length: nextLength,
        sourceBeforeEdits: this.text.text,
      },
      this.#budgets,
    );
    const transaction: DocumentTransaction = {
      id,
      baseRevision: this.#revision,
      origin: intent.origin,
      edits,
      newlinePolicy: { type: "document-dominant", fallback: "lf" },
      ...(intent.selectionBefore === undefined
        ? {}
        : { selectionBefore: intent.selectionBefore }),
      ...(intent.selectionAfter === undefined ? {} : { selectionAfter: intent.selectionAfter }),
      history: intent.history ?? { type: "record" },
      ...(intent.metadata === undefined ? {} : { metadata: intent.metadata }),
      analysis,
    };
    this.#pending.set(id, transaction);
    // A multi-row edit inside one confirmed table invalidates the root and its
    // detail together. Request its root neighborhood once; the viewport will
    // load the required cells against the new row/column schema after commit.
    // Keep the original row edits for history and per-line EOL preservation.
    const ownerIndex = this.blocks.batchOwner(edits);
    const owner = ownerIndex === undefined ? undefined : this.blocks.blocks[ownerIndex];
    const tableBatch = owner?.kind === "table";
    const { priorityRanges, visibleRanges } = analysis.priority;
    const viewportOnly = priorityRanges.length === 0;
    const cachedSlices = tableBatch || viewportOnly ? [] : this.projection.slicesTouchingEdits(edits);
    let roots = viewportOnly ? visibleRanges : priorityRanges;
    if (tableBatch || (roots.length === 0 && edits.length > 0)) {
      const first = edits[0]!;
      const firstChanged = range(Number(first.range.from), Number(first.range.from) + first.insert.length);
      roots = [tableBatch ? firstChanged : analysis.priority.activeRange ?? firstChanged];
    }
    const rootRefreshSlices = roots.map((sourceRange): ProjectionSlice => ({
      parentId: "0",
      axis: "syntax-children",
      window: {
        type: "around-range",
        range: sourceRange,
        // Markdown block boundaries may include a separator blank line. Two
        // neighbors are enough to retain the preceding/following semantic block
        // without materializing a document-wide root projection.
        before: TRANSACTION_ROOT_NEIGHBORS,
        after: TRANSACTION_ROOT_NEIGHBORS,
      },
      maxDepth: 0,
    }));
    // 语法重解析可以替换编辑点两侧的根块。旧 root index slice 即使仍在 cache
    // 中也不代表邻接槽位有效，因此用有限邻域刷新 root；嵌套 row/cell slice
    // 仍保留，避免把 table 详情升级为全表投影。
    const projectionSlices = [
      ...cachedSlices.filter((slice) =>
        !(slice.parentId === "0" && slice.axis === "syntax-children")),
      ...rootRefreshSlices,
    ];
    const request = this.#envelope({
      type: "apply-transaction",
      transaction,
      ...(projectionSlices.length === 0
        ? {}
        : {
            projection: {
              revision: (Number(this.#revision) + 1) as Revision,
              viewRevision: this.#viewRevision,
              slices: projectionSlices,
              mode: this.#mode,
              ...(intent.viewport.activeRange === undefined
                ? {}
                : { activeRange: intent.viewport.activeRange }),
            },
          }),
    });
    this.#pendingByRequest.set(request.requestId, id);
    return request;
  }

  discardPendingTransactions(): void {
    this.#pending.clear();
    this.#pendingByRequest.clear();
  }

  setMode(mode: ProjectionMode): void {
    if (mode !== this.#mode) {
      this.#mode = mode;
      this.#viewRevision += 1;
    }
  }

  project(slices: readonly ProjectionSlice[]): RequestEnvelope {
    return this.#envelope({
      type: "project",
      projection: {
        revision: this.#revision,
        viewRevision: this.#viewRevision,
        slices,
        mode: this.#mode,
      },
    });
  }

  projectRoot(from: number, toExclusive: number, maxDepth = 0): RequestEnvelope {
    return this.project([{
      parentId: "0",
      axis: "syntax-children",
      window: { type: "index", from, toExclusive },
      maxDepth,
    }]);
  }

  projectSourceLines(
    parentId: string,
    from: number,
    toExclusive: number,
  ): RequestEnvelope {
    return this.project([{
      parentId,
      axis: "source-lines",
      window: { type: "index", from, toExclusive },
      maxDepth: 0,
    }]);
  }

  projectAround(
    parentId: string,
    axis: ProjectionSlice["axis"],
    range: import("@jot-md/editor-protocol").TextRange,
    before: number,
    after: number,
    maxDepth = 0,
  ): RequestEnvelope {
    return this.project([{
      parentId,
      axis,
      window: { type: "around-range", range, before, after },
      maxDepth,
    }]);
  }

  sourceLines(fromLine: number, toLineExclusive: number): readonly SourceLineSlice[] {
    return this.text.lines(fromLine, toLineExclusive);
  }

  pretextLines(
    fromLine: number,
    toLineExclusive: number,
    maxUtf16: number,
  ): readonly SourceLinePreview[] {
    return this.text.linePreviews(fromLine, toLineExclusive, maxUtf16);
  }

  accept(response: ResponseEnvelope): AdapterEffect {
    this.#assertIdentity(response);
    const body = response.body;
    if (body.type === "handshake-ack") return { capabilities: body.capabilities, projectionChanged: false };
    if (body.type === "document-opened") {
      this.#revision = body.revision;
      this.#analysis = body.analysis;
      this.projection.advanceRevision(body.revision);
      return { analysis: body.analysis, projectionChanged: false };
    }
    if (body.type === "transaction-committed") {
      if (this.#pendingByRequest.get(response.requestId) !== body.patch.transactionId) {
        throw new Error("transaction response does not match its request");
      }
      const transaction = this.#pending.get(body.patch.transactionId);
      if (transaction === undefined) throw new Error("unknown transaction response");
      if (body.patch.baseRevision !== this.#revision) {
        throw new Error("transaction response does not extend the local revision");
      }
      const lineChanges = this.text.apply(transaction.edits);
      this.blocks.applyTextEdits(transaction.edits);
      if (body.patch.syntax !== undefined) this.blocks.applySyntaxPatch(body.patch.syntax);
      this.#revision = body.patch.revision;
      this.#analysis = body.analysis;
      this.projection.advanceRevision(
        body.patch.revision,
        transaction.edits,
        body.patch.syntax,
        { reset: replacesMostDocument(transaction.edits, this.text.utf16Length) },
      );
      this.#pending.delete(body.patch.transactionId);
      this.#pendingByRequest.delete(response.requestId);
      return {
        analysis: body.analysis,
        documentPatch: body.patch,
        appliedEdits: transaction.edits,
        lineChanges,
        ...this.#acceptProjection(body.renderPatch),
      };
    }
    if (body.type === "analysis-state-changed") {
      if (Number(body.analysis.targetRevision) < Number(this.#revision)) {
        return { projectionChanged: false };
      }
      if (body.analysis.targetRevision !== this.#revision) {
        throw new Error("analysis response is ahead of the local text revision");
      }
      this.#analysis = body.analysis;
      if (body.update?.syntax !== undefined) {
        this.blocks.applySyntaxPatch(body.update.syntax);
        this.projection.applySyntaxPatch(body.update.syntax);
      }
      return {
        analysis: body.analysis,
        ...(body.update === undefined ? {} : { analysisUpdate: body.update }),
        projectionChanged: false,
      };
    }
    if (body.type === "projection-ready") {
      if (Number(body.patch.documentRevision) < Number(this.#revision)) {
        return { projectionChanged: false };
      }
      if (body.patch.documentRevision !== this.#revision) {
        throw new Error("projection response is ahead of the local text revision");
      }
      return this.#acceptProjection(body.patch);
    }
    if (body.type === "failure") {
      const transactionId = this.#pendingByRequest.get(response.requestId);
      if (transactionId !== undefined) {
        this.#pending.delete(transactionId);
        this.#pendingByRequest.delete(response.requestId);
      }
      throw new Error(`${body.error.code}: ${body.error.message}`);
    }
    return { projectionChanged: false };
  }

  #acceptProjection(patch: RenderPatch | undefined): AdapterEffect {
    if (patch === undefined || patch.viewRevision !== this.#viewRevision) {
      return { projectionChanged: false };
    }
    if (patch.operations.every(({ axis }) => axis === "heading-section" || axis === "heading-outline")) {
      return { projectionChanged: false, renderPatch: patch };
    }
    if (!this.projection.apply(patch)) return { projectionChanged: false };
    for (const operation of patch.operations) {
      if (operation.parentId === "0" && operation.axis === "syntax-children") {
        this.blocks.seedProjection(operation.from, operation.inserted, operation.totalChildren);
      }
    }
    return { projectionChanged: true, renderPatch: patch };
  }

  /** A source command can use syntax ranges only for the text that Rust confirmed. */
  confirmedBlockAt(source: string, offset: number) {
    if (source !== this.text.text) return undefined;
    const index = this.blocks.blockAt(offset);
    if (index !== undefined) {
      const block = this.blocks.blocks[index]!;
      if (block.kind !== "unloaded") return block.dirty ? undefined : block;
    }
    // An unloaded slot has range 0..0 even after a loaded root. Binary search
    // alone can miss a confirmed command target while projection is sparse.
    return this.blocks.blocks.find((block) => !block.dirty &&
      block.sourceRange.from <= offset && offset <= block.sourceRange.to);
  }

  #envelope(body: RequestEnvelope["body"]): RequestEnvelope {
    const requestId = this.#requestId;
    this.#requestId =
      requestId === FRONTEND_REQUEST_ID_MAX ? 0 : requestId + 1;
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      generation: this.#generation,
      documentId: this.#documentId,
      body,
    };
  }

  #assertIdentity(response: ResponseEnvelope): void {
    if (
      response.protocolVersion !== PROTOCOL_VERSION ||
      response.generation !== this.#generation ||
      response.documentId !== this.#documentId
    ) {
      throw new Error("response belongs to another editor document instance");
    }
  }
}
