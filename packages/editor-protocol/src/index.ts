/** 必须与 `editor_protocol::PROTOCOL_VERSION` 保持一致。 */
export const PROTOCOL_VERSION = 1 as const;
export const FRONTEND_REQUEST_ID_MAX = 0x7fff_ffff as const;
export const WORKER_REQUEST_ID_MIN = 0x8000_0000 as const;
export const WORKER_REQUEST_ID_MAX = 0xffff_ffff as const;

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type DocumentId = Brand<string, "DocumentId">;
export type TransactionId = Brand<string, "TransactionId">;
export type AnalysisId = Brand<string, "AnalysisId">;
export type Revision = Brand<number, "Revision">;
export type Utf16Offset = Brand<number, "Utf16Offset">;

export interface TextRange {
  /** 文档全局 UTF-16 code unit 偏移，包含起点。 */
  readonly from: Utf16Offset;
  /** 文档全局 UTF-16 code unit 偏移，不包含终点。 */
  readonly to: Utf16Offset;
}

export type ConcreteEolKind = "lf" | "crlf" | "cr";
export type SourceLineEnding = ConcreteEolKind | "none";

export interface ExtensionVersion {
  readonly id: string;
  readonly version: string;
}

export interface SyntaxProfile {
  readonly id: string;
  readonly version: number;
  readonly enabledExtensions: readonly ExtensionVersion[];
}

export type AnalysisUrgency = "interactive" | "normal" | "background";
export type AnalysisConsistency = "allow-partial" | "require-complete";
export type AnalysisPurpose =
  | "interactive"
  | "preview"
  | "export"
  | "save-validation"
  | "extension"
  | "test";

export interface AnalysisPriority {
  /** 目标 revision 的 UTF-16 范围；只作为调度提示。 */
  readonly priorityRanges: readonly TextRange[];
  readonly visibleRanges: readonly TextRange[];
  readonly activeRange?: TextRange;
  readonly urgency: AnalysisUrgency;
}

export interface AnalysisWorkBudget {
  readonly maxSourceLines: number;
  readonly maxBlocks: number;
  readonly maxUtf16Units: number;
}

export interface AnalysisRequest {
  readonly priority: AnalysisPriority;
  readonly consistency: AnalysisConsistency;
  readonly purpose: AnalysisPurpose;
  readonly initialBudget: AnalysisWorkBudget;
}

export type AnalysisCancelReason =
  | "requested"
  | "superseded"
  | "document-closed"
  | "generation-changed"
  | "resource-limit"
  | "engine-shutdown";

export type AnalysisFailureCode =
  | "INVALID_PRIORITY"
  | "PARSE_FAILED"
  | "RESOURCE_LIMIT"
  | "CANCELLED"
  | "INTERNAL";

export interface AnalysisFailure {
  readonly code: AnalysisFailureCode;
  readonly message: string;
  readonly recoverable: boolean;
}

export type AnalysisState =
  | {
      readonly state: "pending";
      readonly analysisId: AnalysisId;
      readonly targetRevision: Revision;
      readonly sequence: number;
      readonly confirmedRanges: readonly TextRange[];
      readonly dirtyRanges: readonly TextRange[];
    }
  | {
      readonly state: "complete";
      readonly analysisId: AnalysisId;
      readonly targetRevision: Revision;
      readonly sequence: number;
      readonly confirmedRange: TextRange;
      readonly totalBlocks: number;
    }
  | {
      readonly state: "cancelled";
      readonly analysisId: AnalysisId;
      readonly targetRevision: Revision;
      readonly sequence: number;
      readonly reason: AnalysisCancelReason;
    }
  | {
      readonly state: "failed";
      readonly analysisId: AnalysisId;
      readonly targetRevision: Revision;
      readonly sequence: number;
      readonly failure: AnalysisFailure;
      readonly dirtyRanges: readonly TextRange[];
    };

export interface AnalysisMetrics {
  readonly processedSourceLines: number;
  readonly processedBlocks: number;
  readonly processedUtf16Units: number;
  readonly elapsedMicros: number;
  readonly yielded: boolean;
}

export type TransactionOrigin =
  | "keyboard"
  | "ime"
  | "paste"
  | "drop"
  | "undo"
  | "redo"
  | "api"
  | "remote"
  | "format"
  | "refactor"
  | "system"
  | "import";

export type HistoryIntent =
  | { readonly type: "record"; readonly group?: string }
  | { readonly type: "isolate" }
  | { readonly type: "ignore" };

export interface TransactionMetadata {
  readonly userEvent?: string;
  readonly actorId?: string;
  readonly compositionId?: string;
  readonly correlationId?: string;
}

export type NewlinePolicy =
  | { readonly type: "document-dominant"; readonly fallback: ConcreteEolKind }
  | { readonly type: "configured"; readonly eol: ConcreteEolKind }
  | { readonly type: "nearest-line"; readonly fallback: ConcreteEolKind };

export interface TextEdit {
  readonly range: TextRange;
  /** 已规范化为 LF 的插入文本；CR 和 CRLF 无效。 */
  readonly insert: string;
}

export interface EditorSelection {
  readonly anchor: Utf16Offset;
  readonly head: Utf16Offset;
}

export interface DocumentTransaction {
  readonly id: TransactionId;
  readonly baseRevision: Revision;
  readonly origin: TransactionOrigin;
  /** 在 `baseRevision` 中按升序排列且互不重叠。 */
  readonly edits: readonly TextEdit[];
  readonly newlinePolicy: NewlinePolicy;
  readonly selectionBefore?: EditorSelection;
  readonly selectionAfter?: EditorSelection;
  readonly history: HistoryIntent;
  readonly metadata?: TransactionMetadata;
  readonly analysis?: AnalysisRequest;
}

export type ProjectionMode = "source" | "preview" | "hybrid";

export type ProjectionAxis = "syntax-children" | "source-lines" | "quote-lines" | "heading-section" | "heading-outline";

export interface ProjectionSlice {
  /** 稳定语法节点 ID；`"0"` 表示文档根节点。 */
  readonly parentId: string;
  readonly axis: ProjectionAxis;
  readonly window: ProjectionWindow;
  /** 内嵌后代层级；更深层子节点需要单独请求。 */
  readonly maxDepth: number;
  /** On heading-outline, omit descendants of these stable heading IDs from the virtual axis. */
  readonly collapsedHeadings?: readonly string[];
}

export type ProjectionWindow =
  | {
      readonly type: "index";
      readonly from: number;
      readonly toExclusive: number;
    }
  | {
      readonly type: "around-range";
      readonly range: TextRange;
      readonly before: number;
      readonly after: number;
    };

export interface ProjectionRequest {
  readonly revision: Revision;
  readonly viewRevision: number;
  readonly slices: readonly ProjectionSlice[];
  readonly mode: ProjectionMode;
  readonly activeRange?: TextRange;
}

export type RequestBody =
  | {
      readonly type: "handshake";
      readonly clientName: string;
      readonly clientVersion: string;
    }
  | {
      readonly type: "open-document";
      readonly source: string;
      readonly syntaxProfile: SyntaxProfile;
      readonly analysis?: AnalysisRequest;
    }
  | {
      readonly type: "apply-transaction";
      readonly transaction: DocumentTransaction;
      /** 可选的可见投影，在提交后计算。 */
      readonly projection?: ProjectionRequest;
    }
  | {
      readonly type: "project";
      readonly projection: ProjectionRequest;
    }
  | {
      readonly type: "get-snapshot";
      readonly revision: Revision;
    }
  | {
      readonly type: "schedule-analysis";
      readonly revision: Revision;
      readonly request: AnalysisRequest;
    }
  | {
      readonly type: "reprioritize-analysis";
      readonly revision: Revision;
      readonly analysisId: AnalysisId;
      readonly priority: AnalysisPriority;
    }
  | {
      readonly type: "process-analysis-queue";
      readonly revision: Revision;
      readonly analysisId: AnalysisId;
      readonly budget: AnalysisWorkBudget;
    }
  | {
      readonly type: "cancel-analysis";
      readonly revision: Revision;
      readonly analysisId: AnalysisId;
      readonly reason: AnalysisCancelReason;
    }
  | { readonly type: "get-analysis-status"; readonly revision: Revision }
  | { readonly type: "close-document" };

export interface RequestEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
  readonly documentId?: DocumentId;
  readonly body: RequestBody;
}

export type RenderMode = "source" | "preview" | "hybrid";

export type RenderContent =
  | { readonly type: "deferred" }
  /** 从本地 revision 文本缓冲的 RenderNode.sourceRange 解析文本。 */
  | { readonly type: "source" }
  | { readonly type: "structured"; readonly children: readonly RenderNode[] };

export type RenderValue =
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "range"; readonly value: TextRange }
  | { readonly type: "strings"; readonly value: readonly string[] }
  | { readonly type: "numbers"; readonly value: readonly number[] };

export interface RenderAttribute {
  readonly name: string;
  readonly value: RenderValue;
}

export interface RenderNode {
  readonly id: string;
  readonly kind: string;
  readonly sourceRange: TextRange;
  readonly contentVersion: number;
  readonly mode: RenderMode;
  readonly childCount: number;
  readonly attributes: readonly RenderAttribute[];
  readonly content: RenderContent;
}

export type RenderOperation = {
  readonly type: "replace-children";
  readonly parentId: string;
  readonly axis: ProjectionAxis;
  readonly from: number;
  readonly removeCount: number;
  readonly totalChildren: number;
  readonly inserted: readonly RenderNode[];
};

export interface RenderPatch {
  readonly documentId: DocumentId;
  readonly documentRevision: Revision;
  readonly viewRevision: number;
  readonly operations: readonly RenderOperation[];
}

export interface ChangedTextRange {
  readonly before: TextRange;
  readonly after: TextRange;
}

export interface SyntaxPatchSummary {
  readonly reparsedRange: TextRange;
  readonly totalBlocks: number;
  readonly changedBlocks: number;
  readonly blockChanges: readonly BlockRangeChange[];
  /** 受本次语法更新影响的稀疏嵌套子序列。 */
  readonly projectionChanges?: readonly ProjectionRangeChange[];
}

export interface ProjectionRangeChange {
  readonly parentId: string;
  readonly axis: ProjectionAxis;
  readonly from: number;
  readonly removeCount: number;
  readonly insertCount: number;
  readonly totalChildren: number;
}

export interface BlockMetadata {
  readonly id: string;
  readonly kind: string;
  readonly sourceRange: TextRange;
  readonly contentVersion: number;
}

export interface BlockRangeChange {
  readonly fromBlock: number;
  readonly removeCount: number;
  readonly inserted: readonly BlockMetadata[];
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  readonly id: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly sourceRange: TextRange;
}

export interface DiagnosticPatch {
  readonly removedIds: readonly string[];
  readonly upserted: readonly Diagnostic[];
}

export interface AnalysisUpdate {
  readonly analysisId: AnalysisId;
  readonly targetRevision: Revision;
  readonly sequence: number;
  readonly confirmedRanges: readonly TextRange[];
  readonly dirtyRanges: readonly TextRange[];
  readonly syntax?: SyntaxPatchSummary;
  readonly diagnostics: DiagnosticPatch;
  readonly metrics: AnalysisMetrics;
}

export interface DocumentPatch {
  readonly transactionId: TransactionId;
  readonly baseRevision: Revision;
  readonly revision: Revision;
  readonly changedTextRange: ChangedTextRange;
  /** 分析被延迟且没有同步语法差异时省略。 */
  readonly syntax?: SyntaxPatchSummary;
  readonly diagnostics: DiagnosticPatch;
}

export type ErrorCode =
  | "PROTOCOL_MISMATCH"
  | "MISSING_DOCUMENT_ID"
  | "DOCUMENT_NOT_OPEN"
  | "GENERATION_MISMATCH"
  | "REVISION_MISMATCH"
  | "REVISION_OVERFLOW"
  | "INVALID_TRANSACTION"
  | "INVALID_RANGE"
  | "INVALID_ANALYSIS_HINT"
  | "ANALYSIS_NOT_FOUND"
  | "ANALYSIS_STALE"
  | "ANALYSIS_FAILED"
  | "RESOURCE_LIMIT"
  | "UNSUPPORTED_REQUEST"
  | "INTERNAL";

export interface ProtocolError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly expectedRevision?: Revision;
  readonly actualRevision?: Revision;
  readonly recoverable: boolean;
}

export type ResponseBody =
  | {
      readonly type: "handshake-ack";
      readonly engineVersion: string;
      readonly capabilities: readonly string[];
    }
  | {
      readonly type: "document-opened";
      readonly revision: Revision;
      readonly sourceUtf16Len: number;
      readonly sourceLineCount: number;
      readonly analysis: AnalysisState;
    }
  | {
      readonly type: "transaction-committed";
      readonly patch: DocumentPatch;
      readonly analysis: AnalysisState;
      readonly renderPatch?: RenderPatch;
    }
  | { readonly type: "projection-ready"; readonly patch: RenderPatch }
  | {
      readonly type: "snapshot-ready";
      readonly revision: Revision;
      readonly text: string;
      readonly lineEndings: readonly SourceLineEnding[];
    }
  | {
      readonly type: "analysis-state-changed";
      readonly analysis: AnalysisState;
      readonly update?: AnalysisUpdate;
    }
  | { readonly type: "document-closed" }
  | { readonly type: "failure"; readonly error: ProtocolError };

export interface ResponseEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
  readonly documentId?: DocumentId;
  readonly body: ResponseBody;
}
