use serde::{Deserialize, Serialize};

use crate::{DiagnosticPatch, DocumentId, Revision, TextRange, TransactionId};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectionMode {
    Source,
    Preview,
    Hybrid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionRequest {
    pub revision: Revision,
    /// 由前端视图持有，并原样回传。
    pub view_revision: u32,
    /// 独立的虚拟窗口。一个请求可以覆盖文档 viewport 和多个展开容器，避免把
    /// renderer 与具体 Markdown 节点类型耦合。
    pub slices: Vec<ProjectionSlice>,
    pub mode: ProjectionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_range: Option<TextRange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectionAxis {
    SyntaxChildren,
    SourceLines,
    /// Confirmed per-physical-line structure within a root block quote.
    QuoteLines,
    /// Derived section boundaries for one confirmed top-level heading.
    HeadingSection,
    /// Source-ordered, windowed top-level headings under the document root.
    HeadingOutline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionSlice {
    /// 稳定语法节点 ID。`"0"` 表示文档根节点。
    pub parent_id: String,
    pub axis: ProjectionAxis,
    pub window: ProjectionWindow,
    /// 每个返回节点中嵌入的后代层级数量。超过该深度的子节点仍可通过另一个
    /// slice 寻址。
    #[serde(default)]
    pub max_depth: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ProjectionWindow {
    Index {
        from: u32,
        to_exclusive: u32,
    },
    AroundRange {
        range: TextRange,
        before: u32,
        after: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenderMode {
    Source,
    Preview,
    Hybrid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RenderContent {
    /// 节点拥有本 slice 未请求的虚拟子节点或不透明源码行。
    Deferred,
    /// 文本有意不在 Wasm 边界重复传输。前端持有同一 revision 的 UTF-16 文本缓冲，
    /// 并在本地解析 `source_range`。
    Source,
    Structured {
        children: Vec<RenderNode>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderNode {
    pub id: String,
    pub kind: String,
    pub source_range: TextRange,
    pub content_version: u32,
    pub mode: RenderMode,
    pub child_count: u32,
    #[serde(default)]
    pub attributes: Vec<RenderAttribute>,
    pub content: RenderContent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderAttribute {
    pub name: String,
    pub value: RenderValue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "kebab-case")]
pub enum RenderValue {
    String(String),
    Number(u32),
    Boolean(bool),
    Range(TextRange),
    Strings(Vec<String>),
    Numbers(Vec<u32>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RenderOperation {
    ReplaceChildren {
        parent_id: String,
        axis: ProjectionAxis,
        from: u32,
        remove_count: u32,
        total_children: u32,
        inserted: Vec<RenderNode>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPatch {
    pub document_id: DocumentId,
    pub document_revision: Revision,
    pub view_revision: u32,
    pub operations: Vec<RenderOperation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedTextRange {
    pub before: TextRange,
    pub after: TextRange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxPatchSummary {
    pub reparsed_range: TextRange,
    pub total_blocks: u32,
    pub changed_blocks: u32,
    pub block_changes: Vec<BlockRangeChange>,
    /// 嵌套稀疏 projection 变化。未受影响的前缀/后缀保留在缓存中；插入槽位有意
    /// 不携带 RenderNode 数据，只有与已挂载虚拟窗口相交时才获取。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projection_changes: Vec<ProjectionRangeChange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionRangeChange {
    pub parent_id: String,
    pub axis: ProjectionAxis,
    pub from: u32,
    pub remove_count: u32,
    pub insert_count: u32,
    pub total_children: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockMetadata {
    pub id: String,
    pub kind: String,
    pub source_range: TextRange,
    pub content_version: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRangeChange {
    pub from_block: u32,
    pub remove_count: u32,
    pub inserted: Vec<BlockMetadata>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPatch {
    pub transaction_id: TransactionId,
    pub base_revision: Revision,
    pub revision: Revision,
    pub changed_text_range: ChangedTextRange,
    /// 只有事务的同步分析预算产生语法更新时才存在。dirty 覆盖范围位于
    /// `AnalysisState` 中。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub syntax: Option<SyntaxPatchSummary>,
    pub diagnostics: DiagnosticPatch,
}
