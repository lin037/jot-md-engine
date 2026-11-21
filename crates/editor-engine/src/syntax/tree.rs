use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, OnceLock},
};

use editor_protocol::TextRange;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NodeId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BulletMarker {
    Dash,
    Plus,
    Asterisk,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderedDelimiter {
    Period,
    Parenthesis,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListMarker {
    Unordered {
        marker: BulletMarker,
    },
    Ordered {
        number: u32,
        delimiter: OrderedDelimiter,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MathDelimiter {
    Dollar,
    Bracket,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TableAlignment {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Document,
    /// 只包含空格/Tab 的物理行，也包括最终 LF 后的终止空行。
    BlankLine,
    Paragraph,
    Heading {
        level: u8,
    },
    BlockQuote,
    ListItem {
        marker: ListMarker,
        /// 列表标记前的绝对缩进列数，每个制表位占四列。渲染器据此对齐同层列表项。
        indent_columns: u32,
    },
    FencedCode {
        language: Option<String>,
        /// opening marker 占用的完整物理行。
        opening_range: TextRange,
        content_range: TextRange,
        /// closing marker 占用的完整物理行。
        closing_range: Option<TextRange>,
        closed: bool,
    },
    MathBlock {
        delimiter: MathDelimiter,
        opening_range: TextRange,
        content_range: TextRange,
        closing_range: Option<TextRange>,
        closed: bool,
    },
    Table {
        alignments: Vec<TableAlignment>,
    },
    TableRow {
        header: bool,
    },
    TableCell {
        alignment: TableAlignment,
    },
    ThematicBreak,
    Text,
    EscapedText {
        content_range: TextRange,
    },
    SoftBreak,
    HardBreak,
    Emphasis,
    Strong,
    Strikethrough,
    TaskMarker {
        checked: bool,
    },
    InlineCode {
        content_range: TextRange,
    },
    InlineMath {
        delimiter: MathDelimiter,
        content_range: TextRange,
    },
    Link {
        destination: String,
        title: Option<String>,
    },
    Image {
        destination: String,
        title: Option<String>,
        alt: String,
    },
}

impl NodeKind {
    pub fn wire_name(&self) -> String {
        match self {
            Self::Document => "document",
            Self::BlankLine => "blank-line",
            Self::Paragraph => "paragraph",
            Self::Heading { .. } => "heading",
            Self::BlockQuote => "block-quote",
            Self::ListItem { .. } => "list-item",
            Self::FencedCode { .. } => "fenced-code",
            Self::MathBlock { .. } => "math-block",
            Self::Table { .. } => "table",
            Self::TableRow { .. } => "table-row",
            Self::TableCell { .. } => "table-cell",
            Self::ThematicBreak => "thematic-break",
            Self::Text => "text",
            Self::EscapedText { .. } => "escaped-text",
            Self::SoftBreak => "soft-break",
            Self::HardBreak => "hard-break",
            Self::Emphasis => "emphasis",
            Self::Strong => "strong",
            Self::Strikethrough => "strikethrough",
            Self::TaskMarker { .. } => "task-marker",
            Self::InlineCode { .. } => "inline-code",
            Self::InlineMath { .. } => "inline-math",
            Self::Link { .. } => "link",
            Self::Image { .. } => "image",
        }
        .to_owned()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxNode {
    pub id: NodeId,
    pub kind: NodeKind,
    pub source_range: TextRange,
    pub children: Vec<NodeId>,
    pub content_version: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxSnapshot {
    root: NodeId,
    nodes: Vec<SyntaxNode>,
    node_index: HashMap<NodeId, usize>,
    next_node_id: u64,
    // Built only for consumers requesting root headings. This is derived
    // state, not part of syntax identity or equality.
    heading_index: HeadingIndexCache,
}

#[derive(Clone, Debug, Default)]
struct HeadingIndexCache(OnceLock<Arc<HeadingIndex>>);

impl PartialEq for HeadingIndexCache {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
impl Eq for HeadingIndexCache {}

#[derive(Clone, Debug)]
struct HeadingIndex {
    entries: Vec<HeadingIndexEntry>,
    by_id: HashMap<NodeId, usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct HeadingIndexEntry {
    pub(crate) id: NodeId,
    pub(crate) block: usize,
    pub(crate) level: u8,
    next: Option<usize>,
}

impl SyntaxSnapshot {
    pub fn new(root: SyntaxNode, mut descendants: Vec<SyntaxNode>) -> Self {
        let root_id = root.id;
        let mut nodes = Vec::with_capacity(descendants.len() + 1);
        nodes.push(root);
        nodes.append(&mut descendants);
        let mut next_node_id = 1;
        let node_index = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| {
                next_node_id =
                    next_node_id.max(node.id.0.checked_add(1).expect("syntax node id exhausted"));
                (node.id, index)
            })
            .collect();
        Self {
            root: root_id,
            nodes,
            node_index,
            next_node_id,
            heading_index: HeadingIndexCache::default(),
        }
    }

    /// Append newly confirmed nodes without cloning or reindexing the old prefix.
    pub(crate) fn append_confirmed(&mut self, roots: &[NodeId], nodes: &[SyntaxNode], end: u32) {
        self.heading_index.0.take();
        let root_index = self.node_index[&self.root];
        self.nodes[root_index].children.extend_from_slice(roots);
        self.nodes[root_index].source_range.to = end;
        self.nodes.reserve(nodes.len());
        for node in nodes {
            self.next_node_id = self
                .next_node_id
                .max(node.id.0.checked_add(1).expect("syntax node id exhausted"));
            self.node_index.insert(node.id, self.nodes.len());
            self.nodes.push(node.clone());
        }
    }

    pub fn root(&self) -> &SyntaxNode {
        self.node(self.root).expect("syntax root must exist")
    }

    /// 根据稳定节点 ID 查找节点；找不到时返回 `None` 而不是 panic。
    pub fn node(&self, id: NodeId) -> Option<&SyntaxNode> {
        self.node_index
            .get(&id)
            .and_then(|index| self.nodes.get(*index))
    }

    pub fn block_count(&self) -> usize {
        self.root().children.len()
    }

    pub fn block(&self, index: usize) -> Option<&SyntaxNode> {
        self.root()
            .children
            .get(index)
            .and_then(|id| self.node(*id))
    }

    pub fn nodes(&self) -> &[SyntaxNode] {
        &self.nodes
    }

    /// 供已经确认不会共享该快照的增量事务原地协调节点。调用方完成 ID/节点
    /// 替换后必须调用 `rebuild_index`，否则按 ID 查询会继续使用旧索引。
    pub(crate) fn nodes_mut(&mut self) -> &mut Vec<SyntaxNode> {
        self.heading_index.0.take();
        &mut self.nodes
    }

    pub(crate) fn rebuild_index(&mut self) {
        self.heading_index.0.take();
        let mut next_node_id = self.next_node_id;
        self.node_index = self
            .nodes
            .iter()
            .enumerate()
            .map(|(index, node)| {
                next_node_id =
                    next_node_id.max(node.id.0.checked_add(1).expect("syntax node id exhausted"));
                (node.id, index)
            })
            .collect();
        self.next_node_id = next_node_id;
    }

    /// Root heading and its next same-or-higher-level root heading. The index
    /// is shared by cloned snapshots and retains IDs/slots, never copied text.
    pub(crate) fn heading_section(&self, id: NodeId) -> Option<(usize, u8, Option<usize>)> {
        let index = self.heading_index();
        let entry = index.entries.get(*index.by_id.get(&id)?)?;
        Some((entry.block, entry.level, entry.next))
    }

    pub(crate) fn headings(&self) -> &[HeadingIndexEntry] {
        &self.heading_index().entries
    }

    fn heading_index(&self) -> &HeadingIndex {
        self.heading_index.0.get_or_init(|| {
            let mut entries: Vec<HeadingIndexEntry> = Vec::new();
            let mut by_id = HashMap::new();
            let mut open: Vec<usize> = Vec::new();
            for (block, root_id) in self.root().children.iter().copied().enumerate() {
                let Some(SyntaxNode {
                    kind: NodeKind::Heading { level },
                    ..
                }) = self.node(root_id)
                else {
                    continue;
                };
                while open
                    .last()
                    .is_some_and(|previous| entries[*previous].level >= *level)
                {
                    let previous = open.pop().expect("checked stack");
                    entries[previous].next = Some(block);
                }
                by_id.insert(root_id, entries.len());
                open.push(entries.len());
                entries.push(HeadingIndexEntry {
                    id: root_id,
                    block,
                    level: *level,
                    next: None,
                });
            }
            Arc::new(HeadingIndex { entries, by_id })
        })
    }

    pub(crate) fn with_id_allocator(mut self, ids: NodeIdAllocator) -> Self {
        self.next_node_id = self.next_node_id.max(ids.next);
        self
    }

    /// Sibling ranges are source-ordered. Descend only the branch containing
    /// the edit, retaining child slots for projection invalidation. No global
    /// owner/parent map is needed for this query.
    pub(crate) fn inline_owner_path(&self, edit: TextRange) -> Option<(Vec<NodeId>, Vec<usize>)> {
        if edit.from > edit.to {
            return None;
        }
        let mut path = vec![self.root];
        let mut slots = Vec::new();
        loop {
            let node = self.node(*path.last()?)?;
            if matches!(
                node.kind,
                NodeKind::Paragraph
                    | NodeKind::Heading { .. }
                    | NodeKind::ListItem { .. }
                    | NodeKind::TableCell { .. }
            ) {
                return Some((path, slots));
            }
            if !matches!(
                node.kind,
                NodeKind::Document
                    | NodeKind::BlockQuote
                    | NodeKind::Table { .. }
                    | NodeKind::TableRow { .. }
            ) {
                return None;
            }
            let slot = node.children.partition_point(|id| {
                self.node(*id)
                    .is_some_and(|child| child.source_range.to < edit.from)
            });
            let child = self.node(*node.children.get(slot)?)?;
            if child.source_range.from > edit.from || child.source_range.to < edit.to {
                return None;
            }
            path.push(child.id);
            slots.push(slot);
        }
    }

    /// Commit a fully validated owner-local rewrite. Source order lives in
    /// children, so removed descendants may use swap_remove without shifting
    /// or reindexing unrelated nodes. The document root remains in slot zero.
    /// The caller guarantees unchanged root topology and owner kind, so the
    /// derived heading slots remain valid even when source offsets are rebased.
    pub(crate) fn commit_local_rewrite(
        &mut self,
        removed: &[NodeId],
        replacements: Vec<SyntaxNode>,
        ancestors: &[NodeId],
        next_node_id: u64,
        shifted_after: Option<(u32, i64)>,
    ) {
        for id in removed {
            let slot = self.node_index.remove(id).expect("validated removed node");
            debug_assert_ne!(slot, 0);
            self.nodes.swap_remove(slot);
            if let Some(moved) = self.nodes.get(slot) {
                self.node_index.insert(moved.id, slot);
            }
        }
        if let Some((after, delta)) = shifted_after {
            let ancestors: HashSet<_> = ancestors.iter().copied().collect();
            // Absolute public ranges still require suffix rebasing when text
            // length changes. Mutate coordinates only; do not clone semantic
            // nodes, ancestor child vectors or rebuild the ID index.
            for node in &mut self.nodes {
                if ancestors.contains(&node.id) {
                    node.source_range.to = shift_offset(node.source_range.to, delta)
                        .expect("validated document length delta");
                } else if node.source_range.from >= after {
                    shift_node_after(node, delta).expect("validated document length delta");
                }
            }
        }
        for node in replacements {
            if let Some(slot) = self.node_index.get(&node.id).copied() {
                self.nodes[slot] = node;
            } else {
                self.node_index.insert(node.id, self.nodes.len());
                self.nodes.push(node);
            }
        }
        for id in ancestors {
            let slot = self.node_index[id];
            self.nodes[slot].content_version = self.nodes[slot].content_version.saturating_add(1);
        }
        self.next_node_id = self.next_node_id.max(next_node_id);
    }

    pub(crate) fn prefix(&self, block_count: usize, root_end: u32) -> Self {
        let root_ids: Vec<NodeId> = self
            .root()
            .children
            .iter()
            .copied()
            .take(block_count)
            .collect();
        let mut reachable = HashSet::new();
        let mut stack = root_ids.clone();
        while let Some(id) = stack.pop() {
            if !reachable.insert(id) {
                continue;
            }
            if let Some(node) = self.node(id) {
                stack.extend(node.children.iter().copied());
            }
        }
        let descendants = self
            .nodes
            .iter()
            .filter(|node| reachable.contains(&node.id))
            .cloned()
            .collect();
        Self::new(
            SyntaxNode {
                id: NodeId(0),
                kind: NodeKind::Document,
                source_range: TextRange::new(0, root_end),
                children: root_ids,
                content_version: self.root().content_version,
            },
            descendants,
        )
        .with_id_allocator(NodeIdAllocator::after(self))
    }

    pub(crate) fn shifted_suffix(
        &self,
        from_block: usize,
        delta: i64,
    ) -> Option<(Vec<NodeId>, Vec<SyntaxNode>)> {
        let root_ids: Vec<NodeId> = self
            .root()
            .children
            .iter()
            .copied()
            .skip(from_block)
            .collect();
        let mut reachable = HashSet::new();
        let mut stack = root_ids.clone();
        while let Some(id) = stack.pop() {
            if !reachable.insert(id) {
                continue;
            }
            let node = self.node(id)?;
            stack.extend(node.children.iter().copied());
        }
        let nodes = self
            .nodes
            .iter()
            .filter(|node| reachable.contains(&node.id))
            .cloned()
            .map(|mut node| {
                node.source_range = shift_range(node.source_range, delta)?;
                shift_kind_ranges(&mut node.kind, delta)?;
                Some(node)
            })
            .collect::<Option<Vec<_>>>()?;
        Some((root_ids, nodes))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NodeIdAllocator {
    next: u64,
}

impl NodeIdAllocator {
    pub(crate) fn new() -> Self {
        Self { next: 1 }
    }

    /// 分配一个不会与当前快照中已有节点冲突的新 ID。
    pub(crate) fn allocate(&mut self) -> NodeId {
        let id = NodeId(self.next);
        self.next = self.next.checked_add(1).expect("syntax node id exhausted");
        id
    }

    /// 从整棵旧树的分配进度继续，避免复用已经删掉、但宿主仍可能持有的节点 ID。
    pub(crate) fn after(snapshot: &SyntaxSnapshot) -> Self {
        Self {
            next: snapshot.next_node_id,
        }
    }

    pub(crate) fn next_id(&self) -> u64 {
        self.next
    }
}

pub(crate) fn shift_node_after(node: &mut SyntaxNode, delta: i64) -> Option<()> {
    node.source_range = shift_range(node.source_range, delta)?;
    shift_kind_ranges(&mut node.kind, delta)
}

pub(super) fn shift_kind_ranges(kind: &mut NodeKind, delta: i64) -> Option<()> {
    match kind {
        NodeKind::FencedCode {
            opening_range,
            content_range,
            closing_range,
            ..
        }
        | NodeKind::MathBlock {
            opening_range,
            content_range,
            closing_range,
            ..
        } => {
            *opening_range = shift_range(*opening_range, delta)?;
            *content_range = shift_range(*content_range, delta)?;
            if let Some(range) = closing_range {
                *range = shift_range(*range, delta)?;
            }
        }
        NodeKind::InlineCode { content_range }
        | NodeKind::InlineMath { content_range, .. }
        | NodeKind::EscapedText { content_range } => {
            *content_range = shift_range(*content_range, delta)?;
        }
        _ => {}
    }
    Some(())
}

pub(crate) fn shift_range(range: TextRange, delta: i64) -> Option<TextRange> {
    Some(TextRange::new(
        shift_offset(range.from, delta)?,
        shift_offset(range.to, delta)?,
    ))
}

pub(crate) fn shift_offset(offset: u32, delta: i64) -> Option<u32> {
    u32::try_from(i64::from(offset).checked_add(delta)?).ok()
}
