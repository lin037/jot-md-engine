use std::collections::HashSet;

use editor_protocol::{ChangedTextRange, ProjectionAxis, ProjectionRangeChange, TextRange};

use crate::{position::utf16_len, text::TextBuffer};

use super::{
    CompiledSyntaxProfile, NodeId, NodeKind, ParseError, SyntaxAnalysisSession, SyntaxCheckpoint,
    SyntaxNode, SyntaxSnapshot, WorkBudget,
    block::{parse_line_views, source_lines_with_base},
    inline, parse,
    tree::{NodeIdAllocator, shift_node_after, shift_offset, shift_range},
};

/// 增量解析完成后返回的新语法快照及受影响范围统计。
pub struct IncrementalResult {
    pub snapshot: SyntaxSnapshot,
    pub reparsed_range: TextRange,
    pub replaced_from: u32,
    pub removed_blocks: u32,
    pub changed_blocks: u32,
    pub projection_changes: Vec<ProjectionRangeChange>,
}

/// 就地修改完整语法树后报告的范围和投影变化。
/// 目前用于确认边界内的行内子树和表格正文行。调用方已持有可修改的完整快照，
/// 因此结果只记录受影响的窗口。
pub struct InPlaceIncrementalResult {
    pub reparsed_range: TextRange,
    pub replaced_from: u32,
    pub removed_blocks: u32,
    pub changed_blocks: u32,
    pub projection_changes: Vec<ProjectionRangeChange>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirtyStrategy {
    SingleParagraph,
    BlockWindow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirtyPlan {
    pub strategy: DirtyStrategy,
    pub block_index: Option<u32>,
    pub invalidated_range: TextRange,
}

/// 用同一语法配置重算受影响的窗口。能定位到安全的局部边界时保留无关节点。
pub fn reparse_change(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    removed_text: &str,
    inserted_text: &str,
    profile: &CompiledSyntaxProfile,
) -> Result<IncrementalResult, ParseError> {
    if let Some(result) = try_reparse_fast(
        previous,
        previous_text,
        text,
        change,
        removed_text,
        inserted_text,
        profile,
    )? {
        return Ok(result);
    }
    let plan = plan_dirty_change(previous, previous_text, change, removed_text, inserted_text);
    if plan.strategy != DirtyStrategy::SingleParagraph {
        return reparse_block_window(previous, previous_text, text, change, profile);
    }
    reparse_single_paragraph(previous, text, plan, change, profile)
        .or_else(|_| reparse_document(previous, text, profile))
}

/// 普通正文编辑可以只解析一个段落。可能改变块边界的编辑需要连同相邻块一起解析。
pub fn plan_dirty_change(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    change: ChangedTextRange,
    removed_text: &str,
    inserted_text: &str,
) -> DirtyPlan {
    if super::block::list_continuation_sensitive(previous_text, change.before) {
        return DirtyPlan {
            strategy: DirtyStrategy::BlockWindow,
            block_index: None,
            invalidated_range: change.before,
        };
    }
    let candidate = previous
        .root()
        .children
        .iter()
        .enumerate()
        .find_map(|(index, id)| {
            let block = previous.node(*id)?;
            (change.before.from >= block.source_range.from
                && change.before.to <= block.source_range.to)
                .then_some((index, block))
        });
    // 只有没有改变块结构字符时，才可能安全地局部重解析。
    let changed_characters_are_safe = !removed_text
        .bytes()
        .chain(inserted_text.bytes())
        .any(is_block_structural_byte);
    let candidate_has_no_block_syntax = candidate.is_some_and(|(_, block)| {
        let Ok(source) = previous_text.slice(block.source_range) else {
            return false;
        };
        !source.bytes().any(is_block_structural_byte)
    });
    // 普通段落内部的安全编辑只影响该段落，不需要重新扫描整篇文档。
    if let Some((index, block)) = candidate
        && block.kind == NodeKind::Paragraph
        && change.before.from > block.source_range.from
        && changed_characters_are_safe
        && candidate_has_no_block_syntax
    {
        let delta = i64::from(change.after.to - change.after.from)
            - i64::from(change.before.to - change.before.from);
        if let Some(to) = shift_offset(block.source_range.to, delta) {
            return DirtyPlan {
                strategy: DirtyStrategy::SingleParagraph,
                block_index: u32::try_from(index).ok(),
                invalidated_range: TextRange::new(block.source_range.from, to),
            };
        }
    }
    // 结构性内容变化从带一行/一 block 回看上下文的安全边界开始，
    // 到旧后缀重新对齐时停止，不再默认扩散到全文末尾。
    DirtyPlan {
        strategy: DirtyStrategy::BlockWindow,
        block_index: None,
        invalidated_range: change.before,
    }
}

/// 先检查围栏、表格及列表续行等块结构，再尝试处理单行内容。
/// 遇到仍需确认的结构变化时返回 None，让调用方选择更大的解析窗口。
#[allow(clippy::too_many_arguments)]
pub fn try_reparse_fast(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    removed_text: &str,
    inserted_text: &str,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    if let Some(result) = update_opaque_container(
        previous,
        previous_text,
        text,
        change,
        inserted_text,
        profile,
    )? {
        return Ok(Some(result));
    }
    if let Some(result) =
        update_container_boundary(previous, text, change, removed_text, inserted_text, profile)?
    {
        return Ok(Some(result));
    }
    if let Some(result) = reparse_table_row_window(previous, previous_text, text, change, profile)?
    {
        return Ok(Some(result));
    }
    if super::block::list_continuation_sensitive(previous_text, change.before)
        || super::block::list_continuation_sensitive(text, change.after)
    {
        return Ok(None);
    }
    if let Some(result) = reparse_heading_line(previous, previous_text, text, change, profile)? {
        return Ok(Some(result));
    }
    if let Some(result) = reparse_single_list_item(previous, previous_text, text, change, profile)?
    {
        return Ok(Some(result));
    }
    if let Some(result) = reparse_inline_owner(
        previous,
        previous_text,
        text,
        change,
        removed_text,
        inserted_text,
        profile,
    )? {
        return Ok(Some(result));
    }
    Ok(None)
}

/// 在确认快照只属于当前文档、且编辑只触及一个表格正文行时，原地更新该快照。
///
/// 现有的脱离式路径会为了平移编辑点之后的 UTF-16 范围而 clone 整个扁平节点
/// 数组。大型表格的语义变化通常只有一行，但这一步仍会复制所有 row/cell/inline
/// 节点，成为输入延迟的主要来源。这里先完整解析并校验新行，再一次性移除旧行
/// 子树、平移未受影响节点并追加新行；任何不满足安全边界的情况都返回 `None`，
/// 由调用方继续使用原有路径。
pub fn try_reparse_table_row_window_in_place(
    previous: &mut SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<InPlaceIncrementalResult>, ParseError> {
    let plan = {
        let previous_ref: &SyntaxSnapshot = &*previous;
        let candidate = previous_ref
            .root()
            .children
            .iter()
            .enumerate()
            .filter_map(|(block_index, id)| Some((block_index, previous_ref.node(*id)?)))
            .filter(|(_, node)| matches!(node.kind, NodeKind::Table { .. }))
            .find_map(|(block_index, table)| {
                let touched = children_touching_range(previous_ref, table, change.before)
                    .into_iter()
                    .filter(|(_, row)| matches!(row.kind, NodeKind::TableRow { header: false }))
                    .collect::<Vec<_>>();
                (!touched.is_empty()).then_some((block_index, table, touched))
            });
        let Some((block_index, table, touched)) = candidate else {
            return Ok(None);
        };
        let NodeKind::Table { alignments } = &table.kind else {
            return Err(ParseError::InvalidParserState);
        };
        let first_child = touched[0].0;
        let last_child = touched[touched.len() - 1].0;
        if last_child + 1 - first_child != touched.len() {
            return Ok(None);
        }
        let old_from = touched[0].1.source_range.from;
        let old_to = touched[touched.len() - 1].1.source_range.to;
        if !table_row_edit_is_contained(change.before, old_from, old_to) {
            return Ok(None);
        }
        let delta = i64::from(change.after.to - change.after.from)
            - i64::from(change.before.to - change.before.from);
        let new_to = shift_offset(old_to, delta).ok_or(ParseError::DocumentTooLarge)?;
        let new_range = TextRange::new(old_from, new_to);
        let source = text
            .slice(new_range)
            .map_err(|_| ParseError::InvalidParserState)?;
        let mut ids = NodeIdAllocator::after(previous_ref);
        let Some(mut parsed) =
            super::block::parse_table_rows(&source, old_from, alignments, profile, &mut ids)?
        else {
            return Ok(None);
        };
        let parsed_from = parsed
            .roots
            .first()
            .and_then(|id| parsed.nodes.iter().find(|node| node.id == *id))
            .map(|node| node.source_range.from);
        let parsed_to = parsed
            .roots
            .last()
            .and_then(|id| parsed.nodes.iter().find(|node| node.id == *id))
            .map(|node| node.source_range.to);
        if parsed_from != Some(old_from) || parsed_to != Some(new_to) {
            return Ok(None);
        }

        reconcile_reparsed_children(
            previous_ref,
            previous_text,
            text,
            change,
            &table.children[first_child..=last_child],
            &mut parsed.roots,
            &mut parsed.nodes,
        )?;

        let mut removed = HashSet::new();
        for (_, row) in &touched {
            collect_subtree(previous_ref, row.id, &mut removed)?;
        }
        let table_to =
            shift_offset(table.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
        let total_children = table
            .children
            .len()
            .checked_sub(touched.len())
            .and_then(|remaining| remaining.checked_add(parsed.roots.len()))
            .ok_or(ParseError::DocumentTooLarge)?;
        let projection_changes = vec![ProjectionRangeChange {
            parent_id: table.id.0.to_string(),
            axis: ProjectionAxis::SyntaxChildren,
            from: u32::try_from(first_child).unwrap_or(u32::MAX),
            remove_count: u32::try_from(touched.len()).unwrap_or(u32::MAX),
            insert_count: u32::try_from(parsed.roots.len()).unwrap_or(u32::MAX),
            total_children: u32::try_from(total_children).unwrap_or(u32::MAX),
        }];
        InPlaceTablePlan {
            root_id: previous_ref.root().id,
            root_content_version: previous_ref.root().content_version,
            table_id: table.id,
            table_content_version: table.content_version,
            table_to,
            change_before_to: change.before.to,
            delta,
            first_child,
            touched_count: touched.len(),
            parsed_roots: parsed.roots,
            parsed_nodes: parsed.nodes,
            removed,
            new_range,
            block_index: u32::try_from(block_index).unwrap_or(u32::MAX),
            projection_changes,
        }
    };

    {
        let nodes = previous.nodes_mut();
        nodes.retain(|node| !plan.removed.contains(&node.id));
        for node in nodes.iter_mut() {
            if node.id == plan.root_id {
                node.source_range = TextRange::new(0, text.utf16_len());
                node.content_version = plan.root_content_version.saturating_add(1);
            } else if node.id == plan.table_id {
                node.source_range.to = plan.table_to;
                node.children.splice(
                    plan.first_child..plan.first_child + plan.touched_count,
                    plan.parsed_roots.iter().copied(),
                );
                node.content_version = plan.table_content_version.saturating_add(1);
            } else if node.source_range.from >= plan.change_before_to {
                shift_node_after(node, plan.delta).ok_or(ParseError::DocumentTooLarge)?;
            }
        }
        nodes.extend(plan.parsed_nodes);
    }
    previous.rebuild_index();

    Ok(Some(InPlaceIncrementalResult {
        reparsed_range: plan.new_range,
        replaced_from: plan.block_index,
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes: plan.projection_changes,
    }))
}

/// Consuming a row terminator or a following block can change the table's
/// boundary. Both fast paths must yield to structural reparsing in that case.
fn table_row_edit_is_contained(edit: TextRange, from: u32, to: u32) -> bool {
    edit.from >= from && edit.to <= to && (edit.from == edit.to || edit.from < to)
}

struct InPlaceTablePlan {
    root_id: NodeId,
    root_content_version: u32,
    table_id: NodeId,
    table_content_version: u32,
    table_to: u32,
    change_before_to: u32,
    delta: i64,
    first_child: usize,
    touched_count: usize,
    parsed_roots: Vec<NodeId>,
    parsed_nodes: Vec<SyntaxNode>,
    removed: HashSet<NodeId>,
    new_range: TextRange,
    block_index: u32,
    projection_changes: Vec<ProjectionRangeChange>,
}

fn update_container_boundary(
    previous: &SyntaxSnapshot,
    text: &TextBuffer,
    change: ChangedTextRange,
    removed_text: &str,
    inserted_text: &str,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    if removed_text.contains(['\n', '\r']) || inserted_text.contains(['\n', '\r']) {
        return Ok(None);
    }
    let container = previous
        .root()
        .children
        .iter()
        .enumerate()
        .filter_map(|(index, id)| Some((index, previous.node(*id)?)))
        .find(|(_, node)| {
            matches!(
                node.kind,
                NodeKind::FencedCode { .. } | NodeKind::MathBlock { .. }
            ) && change.before.from >= node.source_range.from
                && change.before.to <= node.source_range.to
        });
    let Some((block_index, container)) = container else {
        return Ok(None);
    };
    let boundaries = container_boundaries(container)?;
    let in_opening = range_inside(change.before, boundaries.opening);
    let in_closing = boundaries
        .closing
        .is_some_and(|closing| range_inside(change.before, closing));
    if !in_opening && !in_closing {
        return Ok(None);
    }
    let new_line = physical_lines_covering(text, change.after)?;
    if new_line.trim_start().starts_with("~~~") {
        // Changing the run length can expose a closer in the body or an earlier opener.
        return Ok(None);
    }
    if matches!(container.kind, NodeKind::FencedCode { .. }) {
        let Some(closing) = boundaries.closing else {
            return Ok(None);
        };
        let delta = i64::from(change.after.to - change.after.from)
            - i64::from(change.before.to - change.before.from);
        let opening_line = if in_opening {
            new_line.clone()
        } else {
            text.slice(boundaries.opening)
                .map_err(|_| ParseError::InvalidParserState)?
        };
        let closing_line = if in_closing {
            new_line.clone()
        } else {
            let shifted = shift_range(closing, delta).ok_or(ParseError::DocumentTooLarge)?;
            text.slice(shifted)
                .map_err(|_| ParseError::InvalidParserState)?
        };
        // Changing only `begin` or `end` can make the old closing marker
        // incompatible, or reveal an earlier matching marker in the content.
        // In either case the maintained boundary must be reparsed.
        if !super::block::fenced_pair_matches(&opening_line, &closing_line, profile) {
            return Ok(None);
        }
    }
    let metadata = match (&container.kind, in_opening, in_closing) {
        (NodeKind::FencedCode { .. }, true, false) => {
            let Some(language) = super::block::fenced_code_language(&new_line, profile) else {
                return Ok(None);
            };
            ContainerMetadata::CodeLanguage(language)
        }
        (NodeKind::FencedCode { .. }, false, true) => {
            if !super::block::closes_fenced_code(&new_line) {
                return Ok(None);
            }
            ContainerMetadata::Unchanged
        }
        (NodeKind::MathBlock { delimiter, .. }, true, false) => {
            if super::block::opens_math_block(&new_line).as_ref() != Some(delimiter) {
                return Ok(None);
            }
            ContainerMetadata::Unchanged
        }
        (NodeKind::MathBlock { delimiter, .. }, false, true) => {
            if !super::block::closes_math_block(&new_line, delimiter) {
                return Ok(None);
            }
            ContainerMetadata::Unchanged
        }
        _ => return Ok(None),
    };
    update_container_ranges(
        previous,
        text,
        change,
        container,
        block_index,
        in_opening,
        metadata,
    )
    .map(Some)
}

enum ContainerMetadata {
    Unchanged,
    CodeLanguage(Option<String>),
}

struct ContainerBoundaries {
    opening: TextRange,
    closing: Option<TextRange>,
}

fn container_boundaries(node: &SyntaxNode) -> Result<ContainerBoundaries, ParseError> {
    match &node.kind {
        NodeKind::FencedCode {
            opening_range,
            closing_range,
            ..
        }
        | NodeKind::MathBlock {
            opening_range,
            closing_range,
            ..
        } => Ok(ContainerBoundaries {
            opening: *opening_range,
            closing: *closing_range,
        }),
        _ => Err(ParseError::InvalidParserState),
    }
}

fn range_inside(range: TextRange, container: TextRange) -> bool {
    range.from >= container.from && range.to <= container.to && range.from < container.to
}

fn update_container_ranges(
    previous: &SyntaxSnapshot,
    text: &TextBuffer,
    change: ChangedTextRange,
    container: &SyntaxNode,
    block_index: usize,
    opening_changed: bool,
    metadata: ContainerMetadata,
) -> Result<IncrementalResult, ParseError> {
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let mut descendants = Vec::with_capacity(previous.nodes().len().saturating_sub(1));
    for node in previous.nodes().iter().skip(1) {
        let mut node = node.clone();
        if node.id == container.id {
            node.source_range.to =
                shift_offset(node.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
            match &mut node.kind {
                NodeKind::FencedCode {
                    language,
                    opening_range,
                    content_range,
                    closing_range,
                    ..
                } => {
                    if let ContainerMetadata::CodeLanguage(next) = &metadata {
                        *language = next.clone();
                    }
                    if opening_changed {
                        opening_range.to = shift_offset(opening_range.to, delta)
                            .ok_or(ParseError::DocumentTooLarge)?;
                        *content_range = shift_range(*content_range, delta)
                            .ok_or(ParseError::DocumentTooLarge)?;
                        if let Some(range) = closing_range {
                            *range =
                                shift_range(*range, delta).ok_or(ParseError::DocumentTooLarge)?;
                        }
                    } else if let Some(range) = closing_range {
                        range.to =
                            shift_offset(range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
                    }
                }
                NodeKind::MathBlock {
                    opening_range,
                    content_range,
                    closing_range,
                    ..
                } => {
                    if opening_changed {
                        opening_range.to = shift_offset(opening_range.to, delta)
                            .ok_or(ParseError::DocumentTooLarge)?;
                        *content_range = shift_range(*content_range, delta)
                            .ok_or(ParseError::DocumentTooLarge)?;
                        if let Some(range) = closing_range {
                            *range =
                                shift_range(*range, delta).ok_or(ParseError::DocumentTooLarge)?;
                        }
                    } else if let Some(range) = closing_range {
                        range.to =
                            shift_offset(range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
                    }
                }
                _ => return Err(ParseError::InvalidParserState),
            }
            node.content_version = node.content_version.saturating_add(1);
        } else if node.source_range.from >= change.before.to {
            shift_node_after(&mut node, delta).ok_or(ParseError::DocumentTooLarge)?;
        }
        descendants.push(node);
    }
    let mut root = previous.root().clone();
    root.source_range = TextRange::new(0, text.utf16_len());
    root.content_version = root.content_version.saturating_add(1);
    Ok(IncrementalResult {
        snapshot: SyntaxSnapshot::new(root, descendants)
            .with_id_allocator(NodeIdAllocator::after(previous)),
        reparsed_range: change.after,
        replaced_from: u32::try_from(block_index).unwrap_or(u32::MAX),
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes: Vec::new(),
    })
}

fn reparse_heading_line(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    let heading = previous
        .root()
        .children
        .iter()
        .filter_map(|id| previous.node(*id))
        .find(|node| {
            matches!(node.kind, NodeKind::Heading { .. })
                && change.before.from >= node.source_range.from
                && change.before.to <= node.source_range.to
                && change.before.from < node.source_range.to
        });
    let Some(heading) = heading else {
        return Ok(None);
    };
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let to = shift_offset(heading.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
    let range = TextRange::new(heading.source_range.from, to);
    let source = text
        .slice(range)
        .map_err(|_| ParseError::InvalidParserState)?;
    if source.contains('\n') {
        return Ok(None);
    }
    let mut ids = NodeIdAllocator::after(previous);
    let lines = source_lines_with_base(&source, range.from)?;
    let parsed = parse_line_views(&lines, profile, &mut ids)?;
    if parsed.roots.len() != 1 {
        return Ok(None);
    }
    let root = parsed
        .nodes
        .iter()
        .find(|node| node.id == parsed.roots[0])
        .cloned()
        .ok_or(ParseError::InvalidParserState)?;
    if !matches!(root.kind, NodeKind::Heading { .. }) {
        return Ok(None);
    }
    replace_inline_subtree(
        previous,
        previous_text,
        text,
        change,
        heading.id,
        root.source_range,
        root.children.clone(),
        parsed
            .nodes
            .into_iter()
            .filter(|node| node.id != parsed.roots[0])
            .collect(),
        Some(root.kind),
    )
    .map(Some)
}

fn reparse_single_list_item(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    // 列表项保留自己的节点 ID。只有编辑前后的下一块边界一致时，才能只重建这一项。
    let Some((block_index, item)) =
        previous
            .root()
            .children
            .iter()
            .enumerate()
            .find_map(|(index, id)| {
                let node = previous.node(*id)?;
                (matches!(node.kind, NodeKind::ListItem { .. })
                    && change.before.from >= node.source_range.from
                    && change.before.to <= node.source_range.to)
                    .then_some((index, node))
            })
    else {
        return Ok(None);
    };
    let old_next_boundary = previous
        .root()
        .children
        .get(block_index + 1)
        .and_then(|id| previous.node(*id))
        .map_or_else(
            || previous.root().source_range.to,
            |node| node.source_range.from,
        );
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let expected_next =
        shift_offset(old_next_boundary, delta).ok_or(ParseError::DocumentTooLarge)?;
    let mut ids = NodeIdAllocator::after(previous);
    let Some(parsed) =
        super::block::parse_list_item_at(text, profile, item.source_range.from, &mut ids)?
    else {
        // 删除或修改 marker 会改变 block 类型；下面的有界 block-window 路径
        // 负责这个结构转换。
        return Ok(None);
    };
    if parsed.next_line_start != expected_next {
        // 插入或删除了换行，物理行分区已经变化，因此必须重建不止这一项。
        return Ok(None);
    }
    let root = parsed.parsed.root;
    replace_inline_subtree(
        previous,
        previous_text,
        text,
        change,
        item.id,
        root.source_range,
        root.children,
        parsed.parsed.descendants,
        Some(root.kind),
    )
    .map(Some)
}

fn reparse_table_row_window(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    if let Some(result) = reparse_table_body_window(previous, previous_text, text, change, profile)?
    {
        return Ok(Some(result));
    }
    reparse_table_single_row(previous, previous_text, text, change, profile)
}

fn reparse_table_body_window(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    let candidate = previous
        .root()
        .children
        .iter()
        .enumerate()
        .filter_map(|(block_index, id)| Some((block_index, previous.node(*id)?)))
        .filter(|(_, node)| matches!(node.kind, NodeKind::Table { .. }))
        .find_map(|(block_index, table)| {
            let touched = children_touching_range(previous, table, change.before)
                .into_iter()
                .filter(|(_, row)| matches!(row.kind, NodeKind::TableRow { header: false }))
                .collect::<Vec<_>>();
            (!touched.is_empty()).then_some((block_index, table, touched))
        });
    let Some((block_index, table, touched)) = candidate else {
        return Ok(None);
    };
    let NodeKind::Table { alignments } = &table.kind else {
        return Err(ParseError::InvalidParserState);
    };
    let first_child = touched[0].0;
    let last_child = touched[touched.len() - 1].0;
    if last_child + 1 - first_child != touched.len() {
        return Ok(None);
    }
    let old_from = touched[0].1.source_range.from;
    let old_to = touched[touched.len() - 1].1.source_range.to;
    if !table_row_edit_is_contained(change.before, old_from, old_to) {
        return Ok(None);
    }
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let new_to = shift_offset(old_to, delta).ok_or(ParseError::DocumentTooLarge)?;
    let new_range = TextRange::new(old_from, new_to);
    let source = text
        .slice(new_range)
        .map_err(|_| ParseError::InvalidParserState)?;
    let mut ids = NodeIdAllocator::after(previous);
    let Some(mut parsed) =
        super::block::parse_table_rows(&source, old_from, alignments, profile, &mut ids)?
    else {
        return Ok(None);
    };
    let parsed_from = parsed
        .roots
        .first()
        .and_then(|id| parsed.nodes.iter().find(|node| node.id == *id))
        .map(|node| node.source_range.from);
    let parsed_to = parsed
        .roots
        .last()
        .and_then(|id| parsed.nodes.iter().find(|node| node.id == *id))
        .map(|node| node.source_range.to);
    if parsed_from != Some(old_from) || parsed_to != Some(new_to) {
        return Ok(None);
    }

    reconcile_reparsed_children(
        previous,
        previous_text,
        text,
        change,
        &table.children[first_child..=last_child],
        &mut parsed.roots,
        &mut parsed.nodes,
    )?;

    let mut removed = HashSet::new();
    for (_, row) in &touched {
        collect_subtree(previous, row.id, &mut removed)?;
    }
    let mut descendants = Vec::with_capacity(previous.nodes().len() + parsed.nodes.len());
    for node in previous.nodes().iter().skip(1) {
        if removed.contains(&node.id) {
            continue;
        }
        let mut node = node.clone();
        if node.id == table.id {
            node.source_range.to =
                shift_offset(node.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
            node.children
                .splice(first_child..last_child + 1, parsed.roots.iter().copied());
            node.content_version = node.content_version.saturating_add(1);
        } else if node.source_range.from >= change.before.to {
            shift_node_after(&mut node, delta).ok_or(ParseError::DocumentTooLarge)?;
        }
        descendants.push(node);
    }
    descendants.extend(parsed.nodes);
    let mut root = previous.root().clone();
    root.source_range = TextRange::new(0, text.utf16_len());
    root.content_version = root.content_version.saturating_add(1);
    Ok(Some(IncrementalResult {
        snapshot: SyntaxSnapshot::new(root, descendants)
            .with_id_allocator(NodeIdAllocator::after(previous)),
        reparsed_range: new_range,
        replaced_from: u32::try_from(block_index).unwrap_or(u32::MAX),
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes: vec![ProjectionRangeChange {
            parent_id: table.id.0.to_string(),
            axis: ProjectionAxis::SyntaxChildren,
            from: u32::try_from(first_child).unwrap_or(u32::MAX),
            remove_count: u32::try_from(touched.len()).unwrap_or(u32::MAX),
            insert_count: u32::try_from(parsed.roots.len()).unwrap_or(u32::MAX),
            total_children: u32::try_from(
                table.children.len() - touched.len() + parsed.roots.len(),
            )
            .unwrap_or(u32::MAX),
        }],
    }))
}

fn range_touches_row(change: TextRange, row: TextRange) -> bool {
    if change.from == change.to {
        change.from >= row.from && change.from <= row.to
    } else {
        change.from <= row.to && change.to >= row.from
    }
}

fn children_touching_range<'snapshot>(
    snapshot: &'snapshot SyntaxSnapshot,
    parent: &SyntaxNode,
    range: TextRange,
) -> Vec<(usize, &'snapshot SyntaxNode)> {
    let first = parent.children.partition_point(|id| {
        snapshot
            .node(*id)
            .is_some_and(|child| child.source_range.to < range.from)
    });
    parent
        .children
        .iter()
        .enumerate()
        .skip(first)
        .map_while(|(index, id)| {
            let child = snapshot.node(*id)?;
            (child.source_range.from <= range.to).then_some((index, child))
        })
        .filter(|(_, child)| range_touches_row(range, child.source_range))
        .collect()
}

fn reparse_table_single_row(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    if change.before.from == change.before.to && change.before.from == text.utf16_len() {
        return Ok(None);
    }
    let row = previous
        .nodes()
        .iter()
        .filter(|node| matches!(node.kind, NodeKind::TableRow { .. }))
        .find(|node| {
            change.before.from >= node.source_range.from
                && change.before.to <= node.source_range.to
                && change.before.from < node.source_range.to
        });
    let Some(row) = row else {
        return Ok(None);
    };
    let path = path_to_node(previous, row.id).ok_or(ParseError::InvalidParserState)?;
    let table = path
        .iter()
        .filter_map(|id| previous.node(*id))
        .find(|node| matches!(node.kind, NodeKind::Table { .. }))
        .ok_or(ParseError::InvalidParserState)?;
    let NodeKind::Table { alignments } = &table.kind else {
        return Err(ParseError::InvalidParserState);
    };
    let NodeKind::TableRow { header } = row.kind else {
        return Err(ParseError::InvalidParserState);
    };
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let row_to = shift_offset(row.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
    let new_range = TextRange::new(row.source_range.from, row_to);
    let source = text
        .slice(new_range)
        .map_err(|_| ParseError::InvalidParserState)?;
    if source.contains('\n') {
        return Ok(None);
    }
    let mut ids = NodeIdAllocator::after(previous);
    let Some(parsed) = super::block::parse_table_row(
        &source,
        new_range.from,
        header,
        alignments,
        profile,
        &mut ids,
    )?
    else {
        return Ok(None);
    };
    replace_inline_subtree(
        previous,
        previous_text,
        text,
        change,
        row.id,
        new_range,
        parsed.root.children,
        parsed.descendants,
        None,
    )
    .map(Some)
}

fn update_opaque_container(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    inserted_text: &str,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    let container = previous
        .root()
        .children
        .iter()
        .enumerate()
        .filter_map(|(index, id)| Some((index, previous.node(*id)?)))
        .find(|(_, node)| {
            let content_range = match &node.kind {
                NodeKind::FencedCode { content_range, .. }
                | NodeKind::MathBlock { content_range, .. } => *content_range,
                _ => return false,
            };
            let closing_from = match &node.kind {
                NodeKind::FencedCode { closing_range, .. }
                | NodeKind::MathBlock { closing_range, .. } => {
                    closing_range.map(|range| range.from)
                }
                _ => None,
            };
            let insertion_at_content_end = change.before.from == change.before.to
                && change.before.from == content_range.to
                && (closing_from.is_none_or(|closing| content_range.to < closing)
                    || inserted_text.contains('\n'));
            change.before.from >= content_range.from
                && change.before.to <= content_range.to
                && (change.before.from < content_range.to || insertion_at_content_end)
        });
    let Some((block_index, container)) = container else {
        return Ok(None);
    };
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    if let NodeKind::MathBlock {
        opening_range,
        content_range,
        ..
    } = &container.kind
        && opening_range.to == content_range.from
    {
        // The body shares a physical line with its delimiters. Edits may
        // introduce an earlier closer, escape the closing slash or split the line.
        return Ok(None);
    }
    let shifted_existing_closer = container_boundaries(container)?
        .closing
        .and_then(|range| shift_offset(range.from, delta));
    let creates_closer = affected_lines_create_new_closer(
        text,
        change.after,
        container,
        shifted_existing_closer,
        profile,
    )?;
    if creates_closer {
        return Ok(None);
    }

    let previous_source_line_range = opaque_source_line_range(container, previous_text)?;
    if previous_source_line_range.from == previous_source_line_range.to {
        // Adjacent opening/closing lines have no projected SourceLines yet.
        // Inserting the first line changes an empty child sequence and the
        // content endpoint is before the inserted LF, not at the shifted
        // closer. Reparse instead of applying the non-empty splice shortcut.
        return Ok(None);
    }
    let source_line_range = TextRange::new(
        previous_source_line_range.from,
        shift_offset(previous_source_line_range.to, delta).ok_or(ParseError::DocumentTooLarge)?,
    );
    let source_line_change = opaque_source_line_change(
        container.id,
        previous_text,
        previous_source_line_range,
        change.before,
        text,
        source_line_range,
        change.after,
    )?;
    let mut descendants = Vec::with_capacity(previous.nodes().len().saturating_sub(1));
    for node in previous.nodes().iter().skip(1) {
        let mut node = node.clone();
        if node.id == container.id {
            node.source_range.to =
                shift_offset(node.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
            match &mut node.kind {
                NodeKind::FencedCode {
                    content_range,
                    closing_range,
                    ..
                }
                | NodeKind::MathBlock {
                    content_range,
                    closing_range,
                    ..
                } => {
                    content_range.to = shift_offset(content_range.to, delta)
                        .ok_or(ParseError::DocumentTooLarge)?;
                    if let Some(range) = closing_range {
                        *range = shift_range(*range, delta).ok_or(ParseError::DocumentTooLarge)?;
                    }
                }
                _ => return Err(ParseError::InvalidParserState),
            }
            node.content_version = node.content_version.saturating_add(1);
        } else if node.source_range.from >= change.before.to {
            shift_node_after(&mut node, delta).ok_or(ParseError::DocumentTooLarge)?;
        }
        descendants.push(node);
    }
    let mut root = previous.root().clone();
    root.source_range = TextRange::new(0, text.utf16_len());
    root.content_version = root.content_version.saturating_add(1);
    Ok(Some(IncrementalResult {
        snapshot: SyntaxSnapshot::new(root, descendants)
            .with_id_allocator(NodeIdAllocator::after(previous)),
        reparsed_range: change.after,
        replaced_from: u32::try_from(block_index).unwrap_or(u32::MAX),
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes: vec![source_line_change],
    }))
}

fn affected_lines_create_new_closer(
    text: &TextBuffer,
    range: TextRange,
    container: &SyntaxNode,
    shifted_existing_closer: Option<u32>,
    profile: &CompiledSyntaxProfile,
) -> Result<bool, ParseError> {
    let (affected_range, affected) = text
        .physical_lines_covering(range)
        .map_err(|_| ParseError::InvalidParserState)?;
    let fence_opening = match &container.kind {
        NodeKind::FencedCode { opening_range, .. } => Some(
            text.slice(*opening_range)
                .map_err(|_| ParseError::InvalidParserState)?,
        ),
        _ => None,
    };
    let mut line_start = affected_range.from;
    for line in affected.split('\n') {
        let is_existing_closer = shifted_existing_closer == Some(line_start);
        let is_closer = match &container.kind {
            NodeKind::FencedCode { .. } => fence_opening
                .as_ref()
                .is_some_and(|opening| super::block::fenced_pair_matches(opening, line, profile)),
            NodeKind::MathBlock { delimiter, .. } => {
                super::block::closes_math_block(line, delimiter)
            }
            _ => return Err(ParseError::InvalidParserState),
        };
        // A newly exposed delimiter inside this block can close an unmatched
        // opener *before* the block, changing which container owns these lines.
        let may_close_earlier = container.source_range.from > 0
            && (super::block::closes_fenced_code(line)
                || super::block::closes_math_block(line, &super::MathDelimiter::Bracket)
                || super::block::closes_math_block(line, &super::MathDelimiter::Dollar));
        if !is_existing_closer && (is_closer || may_close_earlier) {
            return Ok(true);
        }
        line_start = line_start
            .saturating_add(utf16_len(line).map_err(|_| ParseError::DocumentTooLarge)?)
            .saturating_add(1);
    }
    Ok(false)
}

fn opaque_source_line_range(
    container: &SyntaxNode,
    text: &TextBuffer,
) -> Result<TextRange, ParseError> {
    match &container.kind {
        NodeKind::FencedCode {
            content_range,
            closing_range,
            ..
        }
        | NodeKind::MathBlock {
            content_range,
            closing_range,
            ..
        } => Ok(TextRange::new(
            content_range.from,
            closing_range.map_or_else(|| text.utf16_len(), |range| range.from),
        )),
        _ => Err(ParseError::InvalidParserState),
    }
}

#[allow(clippy::too_many_arguments)]
fn opaque_source_line_change(
    parent_id: NodeId,
    previous_text: &TextBuffer,
    previous_source_line_range: TextRange,
    before: TextRange,
    text: &TextBuffer,
    source_line_range: TextRange,
    after: TextRange,
) -> Result<ProjectionRangeChange, ParseError> {
    let (previous_total, from, remove_count) =
        affected_source_lines(previous_text, previous_source_line_range, before)?;
    let (total_children, next_from, insert_count) =
        affected_source_lines(text, source_line_range, after)?;
    if previous_total == 0 || (total_children > 0 && from != next_from) {
        return Err(ParseError::InvalidParserState);
    }
    Ok(ProjectionRangeChange {
        parent_id: parent_id.0.to_string(),
        axis: ProjectionAxis::SourceLines,
        from,
        remove_count,
        insert_count,
        total_children,
    })
}

fn affected_source_lines(
    text: &TextBuffer,
    content_range: TextRange,
    changed: TextRange,
) -> Result<(u32, u32, u32), ParseError> {
    let (total, from) = text
        .line_index_in_range(content_range, changed.from)
        .map_err(|_| ParseError::InvalidParserState)?;
    if total == 0 {
        return Ok((0, 0, 0));
    }
    // 右边界特意使用正向关联。删除换行会把其后的物理行合并到编辑行中，因此
    // 后续行属于被替换的 source-line 子序列。
    let (_, to) = text
        .line_index_in_range(content_range, changed.to)
        .map_err(|_| ParseError::InvalidParserState)?;
    Ok((total, from, to.saturating_sub(from).saturating_add(1)))
}

fn physical_lines_covering(text: &TextBuffer, range: TextRange) -> Result<String, ParseError> {
    text.physical_lines_covering(range)
        .map(|(_, source)| source)
        .map_err(|_| ParseError::InvalidParserState)
}

#[allow(clippy::too_many_arguments)]
fn reparse_inline_owner(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    removed_text: &str,
    inserted_text: &str,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<IncrementalResult>, ParseError> {
    if removed_text.contains(['\n', '\r']) || inserted_text.contains(['\n', '\r']) {
        return Ok(None);
    }
    let owner = previous
        .nodes()
        .iter()
        .filter(|node| matches!(node.kind, NodeKind::Paragraph | NodeKind::TableCell { .. }))
        .filter(|node| {
            let insertion_at_end = change.before.from == change.before.to
                && change.before.from == node.source_range.to;
            change.before.from >= node.source_range.from
                && change.before.to <= node.source_range.to
                && (change.before.from < node.source_range.to || insertion_at_end)
        })
        .min_by_key(|node| node.source_range.to - node.source_range.from);
    let Some(owner) = owner else {
        return Ok(None);
    };
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let owner_to =
        shift_offset(owner.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
    let new_range = TextRange::new(owner.source_range.from, owner_to);
    let source = text
        .slice(new_range)
        .map_err(|_| ParseError::InvalidParserState)?;
    if source.contains('\n') {
        return Ok(None);
    }

    let mut ids = NodeIdAllocator::after(previous);
    let (children, replacement_nodes) = match owner.kind {
        NodeKind::Paragraph => {
            let old_source = previous_text
                .slice(owner.source_range)
                .map_err(|_| ParseError::InvalidParserState)?;
            let old_fence_boundary = super::block::fenced_code_language(&old_source, profile)
                .is_some()
                || super::block::closes_fenced_code(&old_source);
            let new_fence_boundary = super::block::fenced_code_language(&source, profile).is_some()
                || super::block::closes_fenced_code(&source);
            let old_math_boundary = super::block::is_math_block_boundary(&old_source);
            let new_math_boundary = super::block::is_math_block_boundary(&source);
            if old_fence_boundary || new_fence_boundary || old_math_boundary || new_math_boundary {
                return Ok(None);
            }
            if old_source.contains('|') || source.contains('|') {
                return Ok(None);
            }
            // 在这段物理行内容上重新运行 block probe。已闭合的 fence marker、list
            // marker、heading 等会拒绝 inline-only 路径，并扩大为 block window。
            let lines = source_lines_with_base(&source, new_range.from)?;
            let parsed = parse_line_views(&lines, profile, &mut ids)?;
            if parsed.roots.len() != 1 {
                return Ok(None);
            }
            let parsed_root = parsed
                .nodes
                .iter()
                .find(|node| node.id == parsed.roots[0])
                .ok_or(ParseError::InvalidParserState)?;
            if parsed_root.kind != NodeKind::Paragraph {
                return Ok(None);
            }
            (
                parsed_root.children.clone(),
                parsed
                    .nodes
                    .into_iter()
                    .filter(|node| node.id != parsed.roots[0])
                    .collect(),
            )
        }
        NodeKind::TableCell { .. } => {
            if removed_text
                .bytes()
                .chain(inserted_text.bytes())
                .any(|byte| matches!(byte, b'|' | b'`' | b'\\'))
            {
                return Ok(None);
            }
            let parsed = inline::parse_table_cell(&source, new_range.from, &mut ids)?;
            (parsed.roots, parsed.nodes)
        }
        _ => return Ok(None),
    };

    replace_inline_subtree(
        previous,
        previous_text,
        text,
        change,
        owner.id,
        new_range,
        children,
        replacement_nodes,
        None,
    )
    .map(Some)
}

#[allow(clippy::too_many_arguments)]
fn replace_inline_subtree(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    owner_id: NodeId,
    owner_range: TextRange,
    mut children: Vec<NodeId>,
    mut replacement_nodes: Vec<SyntaxNode>,
    owner_kind: Option<NodeKind>,
) -> Result<IncrementalResult, ParseError> {
    let path = path_to_node(previous, owner_id).ok_or(ParseError::InvalidParserState)?;
    let top_level_id = *path.get(1).ok_or(ParseError::InvalidParserState)?;
    let replaced_from = previous
        .root()
        .children
        .iter()
        .position(|id| *id == top_level_id)
        .and_then(|index| u32::try_from(index).ok())
        .ok_or(ParseError::InvalidParserState)?;
    let mut removed = HashSet::new();
    let owner = previous
        .node(owner_id)
        .ok_or(ParseError::InvalidParserState)?;
    reconcile_reparsed_children(
        previous,
        previous_text,
        text,
        change,
        &owner.children,
        &mut children,
        &mut replacement_nodes,
    )?;
    let projection_changes = projection_changes_for_inline_replacement(
        previous,
        &path,
        owner,
        &children,
        &replacement_nodes,
        None,
    )?;
    for child in &owner.children {
        collect_subtree(previous, *child, &mut removed)?;
    }
    let path_ids: HashSet<NodeId> = path.into_iter().collect();
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let mut descendants = Vec::with_capacity(previous.nodes().len() + replacement_nodes.len());
    for node in previous.nodes().iter().skip(1) {
        if removed.contains(&node.id) {
            continue;
        }
        let mut node = node.clone();
        if node.id == owner_id {
            node.source_range = owner_range;
            node.children = children.clone();
            if let Some(kind) = &owner_kind {
                node.kind = kind.clone();
            }
            node.content_version = node.content_version.saturating_add(1);
        } else if path_ids.contains(&node.id) {
            let next_to =
                shift_offset(node.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?;
            node.source_range.to = next_to;
            node.content_version = node.content_version.saturating_add(1);
        } else if node.source_range.from >= change.before.to {
            shift_node_after(&mut node, delta).ok_or(ParseError::DocumentTooLarge)?;
        }
        descendants.push(node);
    }
    descendants.extend(replacement_nodes);
    let mut root = previous.root().clone();
    root.source_range = TextRange::new(0, text.utf16_len());
    root.content_version = root.content_version.saturating_add(1);
    Ok(IncrementalResult {
        snapshot: SyntaxSnapshot::new(root, descendants)
            .with_id_allocator(NodeIdAllocator::after(previous)),
        reparsed_range: owner_range,
        replaced_from,
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes,
    })
}

pub(super) fn reconcile_reparsed_children(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    old_children: &[NodeId],
    new_children: &mut [NodeId],
    new_nodes: &mut [SyntaxNode],
) -> Result<(), ParseError> {
    let reconciler = IdentityReconciler {
        previous,
        previous_text,
        text,
        change,
        new_index: new_nodes
            .iter()
            .enumerate()
            .map(|(position, node)| (node.id, position))
            .collect(),
    };
    reconciler.children(old_children, new_children, new_nodes)
}

struct IdentityReconciler<'a> {
    previous: &'a SyntaxSnapshot,
    previous_text: &'a TextBuffer,
    text: &'a TextBuffer,
    change: ChangedTextRange,
    new_index: std::collections::HashMap<NodeId, usize>,
}

impl IdentityReconciler<'_> {
    fn children(
        &self,
        old: &[NodeId],
        new: &mut [NodeId],
        nodes: &mut [SyntaxNode],
    ) -> Result<(), ParseError> {
        let (mut old_index, mut new_index) = (0, 0);
        let (mut old_gap, mut new_gap) = (0, 0);
        while old_index < old.len() && new_index < new.len() {
            let old_node = self
                .previous
                .node(old[old_index])
                .ok_or(ParseError::InvalidParserState)?;
            let new_node = &nodes[self.new_index[&new[new_index]]];
            let Some(mapped) = self.mapped_start(old_node.source_range) else {
                old_index += 1;
                continue;
            };
            let from = new_node.source_range.from;
            if mapped <= from {
                old_index += 1;
            }
            if from <= mapped {
                new_index += 1;
            }
            if mapped == from
                && std::mem::discriminant(&old_node.kind) == std::mem::discriminant(&new_node.kind)
            {
                self.edited_gap(
                    &old[old_gap..old_index - 1],
                    &mut new[new_gap..new_index - 1],
                    nodes,
                )?;
                self.preserve(old_node, &mut new[new_index - 1], nodes)?;
                old_gap = old_index;
                new_gap = new_index;
            }
        }
        self.edited_gap(&old[old_gap..], &mut new[new_gap..], nodes)
    }

    fn mapped_start(&self, range: TextRange) -> Option<u32> {
        let from = range.from;
        if from < self.change.before.from {
            Some(from)
        } else if from >= self.change.before.to {
            Some(from - self.change.before.to + self.change.after.to)
        } else if from == self.change.before.from && self.change.after.from < self.change.after.to {
            // A replacement can split the edited node. Its leading fragment
            // keeps the boundary identity; a pure insertion maps to the suffix.
            Some(self.change.after.from)
        } else {
            None
        }
    }

    // Stable source anchors have priority. Between them a one-to-one edit
    // can preserve identity, but insertion/deletion must not slide IDs along
    // a run of siblings of the same kind.
    fn edited_gap(
        &self,
        old: &[NodeId],
        new: &mut [NodeId],
        nodes: &mut [SyntaxNode],
    ) -> Result<(), ParseError> {
        if old.len() != new.len() {
            return Ok(());
        }
        for (&id, new_id) in old.iter().zip(new) {
            let old = self
                .previous
                .node(id)
                .ok_or(ParseError::InvalidParserState)?;
            let next = &nodes[self.new_index[new_id]];
            let touches =
                |node: TextRange, edit: TextRange| node.from <= edit.to && edit.from <= node.to;
            // Cell ranges exclude horizontal padding. Clearing the content can
            // place the new empty caret at the next pipe, beyond the edit.
            // The one-to-one slot in this matched row still owns the edit.
            let emptied_cell = matches!(old.kind, NodeKind::TableCell { .. })
                && next.source_range.from == next.source_range.to
                && old.source_range.from <= self.change.before.from
                && self.change.before.to <= old.source_range.to;
            if touches(old.source_range, self.change.before)
                && (touches(next.source_range, self.change.after) || emptied_cell)
                && std::mem::discriminant(&old.kind) == std::mem::discriminant(&next.kind)
            {
                self.preserve(old, new_id, nodes)?;
            }
        }
        Ok(())
    }

    fn preserve(
        &self,
        old: &SyntaxNode,
        new_id: &mut NodeId,
        nodes: &mut [SyntaxNode],
    ) -> Result<(), ParseError> {
        let position = self.new_index[new_id];
        let mut children = std::mem::take(&mut nodes[position].children);
        self.children(&old.children, &mut children, nodes)?;
        let node = &mut nodes[position];
        node.id = old.id;
        node.children = children;
        preserve_node_version(self.previous_text, self.text, old, node);
        *new_id = old.id;
        Ok(())
    }
}

pub(super) fn preserve_node_version(
    previous_text: &TextBuffer,
    text: &TextBuffer,
    old: &SyntaxNode,
    node: &mut SyntaxNode,
) {
    let unchanged = old.children == node.children
        && old.source_range.to - old.source_range.from
            == node.source_range.to - node.source_range.from
        && (old.kind == node.kind || {
            let delta = i64::from(node.source_range.from) - i64::from(old.source_range.from);
            if delta == 0 {
                false
            } else {
                let mut shifted = old.kind.clone();
                super::tree::shift_kind_ranges(&mut shifted, delta).is_some()
                    && shifted == node.kind
            }
        })
        && previous_text.range_eq(old.source_range, text, node.source_range);
    node.content_version = if unchanged {
        old.content_version
    } else {
        old.content_version.saturating_add(1)
    };
}

pub(super) fn projection_changes_for_inline_replacement(
    previous: &SyntaxSnapshot,
    path: &[NodeId],
    owner: &SyntaxNode,
    inserted_children: &[NodeId],
    replacement_nodes: &[SyntaxNode],
    path_slots: Option<&[usize]>,
) -> Result<Vec<ProjectionRangeChange>, ParseError> {
    let mut changes = Vec::with_capacity(path.len());
    // 根子节点已经有精确的 BlockRangeChange。更深的每条边只使被修改子节点的
    // descriptor 失效，因此大型 List/Table 窗口保留所有未受影响的兄弟节点。
    for (edge_index, edge) in path.windows(2).enumerate().skip(1) {
        let parent = previous
            .node(edge[0])
            .ok_or(ParseError::InvalidParserState)?;
        let index = path_slots
            .and_then(|slots| slots.get(edge_index))
            .copied()
            .or_else(|| parent.children.iter().position(|id| *id == edge[1]))
            .ok_or(ParseError::InvalidParserState)?;
        changes.push(ProjectionRangeChange {
            parent_id: parent.id.0.to_string(),
            axis: ProjectionAxis::SyntaxChildren,
            from: u32::try_from(index).unwrap_or(u32::MAX),
            remove_count: 1,
            insert_count: 1,
            total_children: u32::try_from(parent.children.len()).unwrap_or(u32::MAX),
        });
    }
    let replacement_versions: std::collections::HashMap<_, _> = replacement_nodes
        .iter()
        .map(|node| (node.id, node.content_version))
        .collect();
    let unchanged = |old_id: NodeId, new_id: NodeId| {
        if old_id != new_id {
            return false;
        }
        let Some(old) = previous.node(old_id) else {
            return false;
        };
        replacement_versions
            .get(&new_id)
            .is_some_and(|version| *version == old.content_version)
    };
    let mut prefix = 0;
    while prefix < owner.children.len()
        && prefix < inserted_children.len()
        && unchanged(owner.children[prefix], inserted_children[prefix])
    {
        prefix += 1;
    }
    let mut old_suffix = owner.children.len();
    let mut new_suffix = inserted_children.len();
    while old_suffix > prefix
        && new_suffix > prefix
        && unchanged(
            owner.children[old_suffix - 1],
            inserted_children[new_suffix - 1],
        )
    {
        old_suffix -= 1;
        new_suffix -= 1;
    }
    if old_suffix > prefix || new_suffix > prefix {
        changes.push(ProjectionRangeChange {
            parent_id: owner.id.0.to_string(),
            axis: ProjectionAxis::SyntaxChildren,
            from: u32::try_from(prefix).unwrap_or(u32::MAX),
            remove_count: u32::try_from(old_suffix - prefix).unwrap_or(u32::MAX),
            insert_count: u32::try_from(new_suffix - prefix).unwrap_or(u32::MAX),
            total_children: u32::try_from(inserted_children.len()).unwrap_or(u32::MAX),
        });
    }
    Ok(changes)
}

fn path_to_node(snapshot: &SyntaxSnapshot, target: NodeId) -> Option<Vec<NodeId>> {
    fn visit(
        snapshot: &SyntaxSnapshot,
        current: NodeId,
        target: NodeId,
        path: &mut Vec<NodeId>,
    ) -> bool {
        path.push(current);
        if current == target {
            return true;
        }
        let found = snapshot.node(current).is_some_and(|node| {
            node.children
                .iter()
                .any(|child| visit(snapshot, *child, target, path))
        });
        if !found {
            path.pop();
        }
        found
    }
    let mut path = Vec::new();
    visit(snapshot, snapshot.root().id, target, &mut path).then_some(path)
}

fn reparse_block_window(
    previous: &SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<IncrementalResult, ParseError> {
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let fenced_opener =
        super::block::fenced_opener_for_closer_in_range(text, change.after, profile)?;
    let math_opener = super::block::math_opener_for_closer_in_range(text, change.after)?;
    let checkpoint = if let Some(opener) = fenced_opener.into_iter().chain(math_opener).min() {
        // 编辑前未匹配的 opener 是普通 paragraph。创建 closer 后，可能把 opener
        // 起始的每个物理行合并成一个 code/math block，因此普通的一个 block
        // look-behind 不够。
        let from = opener.min(change.before.from);
        SyntaxCheckpoint::for_change(previous, TextRange::new(from, change.before.to), delta)
    } else {
        SyntaxCheckpoint::for_structural_change(previous, change.before, delta)
    };
    let mut session = SyntaxAnalysisSession::from_checkpoint(text, profile.clone(), checkpoint)?;
    while !session.is_complete() {
        session.poll(WorkBudget::bounded(usize::MAX, usize::MAX, usize::MAX))?;
    }
    let parsed_snapshot = session
        .completed_snapshot()
        .ok_or(ParseError::InvalidParserState)?;
    let replaced_from = session.reused_prefix_blocks();
    let reused_suffix = session.reused_suffix_blocks();
    let removed_blocks = u32::try_from(previous.block_count())
        .unwrap_or(u32::MAX)
        .saturating_sub(replaced_from)
        .saturating_sub(reused_suffix);

    // checkpoint parser 有意重建较小的 dirty window。在该窗口内协调兼容根节点，
    // 使列表项按 Enter 等结构性编辑仍保留原 item 的稳定身份，只为真正新增的
    // 物理行分配 ID。
    let mut root = parsed_snapshot.root().clone();
    let mut roots = root.children.clone();
    let mut nodes = parsed_snapshot
        .nodes()
        .iter()
        .filter(|node| node.id != root.id)
        .cloned()
        .collect::<Vec<_>>();
    let old_from = usize::try_from(replaced_from).map_err(|_| ParseError::DocumentTooLarge)?;
    let old_to = previous
        .block_count()
        .saturating_sub(usize::try_from(reused_suffix).unwrap_or(usize::MAX));
    let new_to = roots
        .len()
        .saturating_sub(usize::try_from(reused_suffix).unwrap_or(usize::MAX));
    reconcile_reparsed_children(
        previous,
        previous_text,
        text,
        change,
        &previous.root().children[old_from..old_to],
        &mut roots[old_from..new_to],
        &mut nodes,
    )?;
    root.children = roots;
    let snapshot =
        SyntaxSnapshot::new(root, nodes).with_id_allocator(NodeIdAllocator::after(previous));
    Ok(IncrementalResult {
        snapshot,
        reparsed_range: session.reparsed_range(),
        replaced_from,
        removed_blocks,
        changed_blocks: session.parsed_new_blocks(),
        projection_changes: Vec::new(),
    })
}

fn reparse_single_paragraph(
    previous: &SyntaxSnapshot,
    text: &TextBuffer,
    plan: DirtyPlan,
    change: ChangedTextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<IncrementalResult, ParseError> {
    let block_index = usize::try_from(plan.block_index.ok_or(ParseError::InvalidParserState)?)
        .map_err(|_| ParseError::DocumentTooLarge)?;
    let old_block = previous
        .block(block_index)
        .ok_or(ParseError::InvalidParserState)?;
    let new_range = plan.invalidated_range;
    let source = text
        .slice(new_range)
        .map_err(|_| ParseError::InvalidParserState)?;
    if source.contains('\n') || source.is_empty() {
        return Err(ParseError::InvalidParserState);
    }
    let lines = source_lines_with_base(&source, new_range.from)?;
    let mut ids = NodeIdAllocator::after(previous);
    let parsed = parse_line_views(&lines, profile, &mut ids)?;
    if parsed.roots.len() != 1 {
        return Err(ParseError::InvalidParserState);
    }
    let new_root_id = parsed.roots[0];

    let mut removed = HashSet::new();
    collect_subtree(previous, old_block.id, &mut removed)?;
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let mut descendants = Vec::with_capacity(previous.nodes().len() + parsed.nodes.len());
    for node in previous.nodes().iter().skip(1) {
        if removed.contains(&node.id) {
            continue;
        }
        let mut node = node.clone();
        if node.source_range.from >= old_block.source_range.to {
            node.source_range =
                shift_range(node.source_range, delta).ok_or(ParseError::DocumentTooLarge)?;
        }
        descendants.push(node);
    }
    descendants.extend(parsed.nodes);

    let mut root = previous.root().clone();
    root.source_range = TextRange::new(0, text.utf16_len());
    root.children[block_index] = new_root_id;
    Ok(IncrementalResult {
        snapshot: SyntaxSnapshot::new(root, descendants)
            .with_id_allocator(NodeIdAllocator::after(previous)),
        reparsed_range: new_range,
        replaced_from: u32::try_from(block_index).unwrap_or(u32::MAX),
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes: Vec::new(),
    })
}

fn collect_subtree(
    snapshot: &SyntaxSnapshot,
    id: NodeId,
    collected: &mut HashSet<NodeId>,
) -> Result<(), ParseError> {
    if !collected.insert(id) {
        return Err(ParseError::InvalidParserState);
    }
    let node = snapshot.node(id).ok_or(ParseError::InvalidParserState)?;
    for child in &node.children {
        collect_subtree(snapshot, *child, collected)?;
    }
    Ok(())
}

fn is_block_structural_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'\n'
            | b'\r'
            | b'#'
            | b'>'
            | b'-'
            | b'+'
            | b'*'
            | b'_'
            | b'|'
            | b'`'
            | b'~'
            | b'$'
            | b'\\'
            | b'['
            | b']'
            | b'.'
            | b')'
            | b'0'..=b'9'
    )
}

fn reparse_document(
    previous: &SyntaxSnapshot,
    text: &TextBuffer,
    profile: &CompiledSyntaxProfile,
) -> Result<IncrementalResult, ParseError> {
    let snapshot = parse(text, profile)?;
    let changed_blocks = u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX);
    let removed_blocks = u32::try_from(previous.block_count()).unwrap_or(u32::MAX);
    Ok(IncrementalResult {
        snapshot,
        reparsed_range: TextRange::new(0, text.utf16_len()),
        replaced_from: 0,
        removed_blocks,
        changed_blocks,
        projection_changes: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syntax::CompiledSyntaxProfile;

    fn profile() -> CompiledSyntaxProfile {
        CompiledSyntaxProfile::compile(Default::default())
    }

    #[test]
    fn ordinary_interior_text_edit_reparses_only_one_paragraph() {
        let before = TextBuffer::from_source("first\nsecond\nthird");
        let previous = parse(&before, &profile()).unwrap();
        let after = TextBuffer::from_source("first\nseXond\nthird");
        let change = ChangedTextRange {
            before: TextRange::new(8, 9),
            after: TextRange::new(8, 9),
        };
        let result =
            reparse_change(&previous, &before, &after, change, "c", "X", &profile()).unwrap();
        assert_eq!(result.reparsed_range, TextRange::new(6, 12));
        assert_eq!(result.replaced_from, 1);
        assert_eq!(
            result.snapshot.block(0).unwrap().id,
            previous.block(0).unwrap().id
        );
        assert_eq!(
            result.snapshot.block(2).unwrap().id,
            previous.block(2).unwrap().id
        );
        assert_eq!(
            result.snapshot.block(1).unwrap().id,
            previous.block(1).unwrap().id
        );
        assert_eq!(
            result.snapshot.block(1).unwrap().children,
            previous.block(1).unwrap().children
        );
        let text_id = result.snapshot.block(1).unwrap().children[0];
        assert_eq!(
            result.snapshot.node(text_id).unwrap().content_version,
            previous
                .node(text_id)
                .unwrap()
                .content_version
                .saturating_add(1)
        );
    }

    #[test]
    fn potentially_structural_character_expands_to_a_safe_block_window() {
        let before = TextBuffer::from_source("a x\n--- | ---");
        let previous = parse(&before, &profile()).unwrap();
        let after = TextBuffer::from_source("a | x\n--- | ---");
        let change = ChangedTextRange {
            before: TextRange::new(2, 2),
            after: TextRange::new(2, 4),
        };
        let result =
            reparse_change(&previous, &before, &after, change, "", "| ", &profile()).unwrap();
        assert_eq!(result.reparsed_range, TextRange::new(0, after.utf16_len()));
        assert!(matches!(
            result.snapshot.block(0).unwrap().kind,
            NodeKind::Table { .. }
        ));
    }

    #[test]
    fn deleting_plain_text_from_a_structural_line_is_not_locally_reparsed() {
        let before = TextBuffer::from_source("--x--");
        let previous = parse(&before, &profile()).unwrap();
        let after = TextBuffer::from_source("----");
        let change = ChangedTextRange {
            before: TextRange::new(2, 3),
            after: TextRange::new(2, 2),
        };
        let result =
            reparse_change(&previous, &before, &after, change, "x", "", &profile()).unwrap();
        assert_eq!(result.reparsed_range, TextRange::new(0, 4));
        assert_eq!(
            result.snapshot.block(0).unwrap().kind,
            NodeKind::ThematicBreak
        );
    }
}
