mod outline;

use editor_protocol::{
    DocumentId, ProjectionAxis, ProjectionMode, ProjectionRequest, ProjectionSlice,
    ProjectionWindow, RenderAttribute, RenderContent, RenderMode, RenderNode, RenderOperation,
    RenderPatch, RenderValue, Revision, TextRange,
};

use crate::{
    syntax::{
        BulletMarker, ListMarker, MathDelimiter, NodeId, NodeKind, OrderedDelimiter, SyntaxNode,
        SyntaxSnapshot, TableAlignment,
    },
    text::TextBuffer,
};

/// 从完整语法树生成指定轴和窗口的投影。一次请求可覆盖多个窗口，响应共用同一修订。
pub fn project(
    document_id: DocumentId,
    revision: Revision,
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    request: &ProjectionRequest,
) -> RenderPatch {
    finish(
        document_id,
        revision,
        request,
        request
            .slices
            .iter()
            .map(|slice| {
                if slice.axis == ProjectionAxis::HeadingSection {
                    heading_section_operation(text, syntax, slice, &request.mode, true)
                } else {
                    project_slice(text, syntax, slice, &request.mode, revision)
                }
            })
            .collect(),
    )
}

/// 从正在解析的树生成投影。已确认的根及其子节点可按 ID 查询，剩余根范围以源码显示。
/// 渲染端可在后续进度到达后重新请求这些窗口。
pub fn project_partial(
    document_id: DocumentId,
    revision: Revision,
    text: &TextBuffer,
    prefix: &SyntaxSnapshot,
    dirty_ranges: &[TextRange],
    request: &ProjectionRequest,
) -> RenderPatch {
    let operations = request
        .slices
        .iter()
        .map(|slice| {
            if slice.axis == ProjectionAxis::HeadingSection {
                heading_section_operation(text, prefix, slice, &request.mode, false)
            } else if slice.parent_id == "0" && slice.axis == ProjectionAxis::SyntaxChildren {
                project_partial_root(text, prefix, dirty_ranges, revision, slice, &request.mode)
            } else {
                project_slice(text, prefix, slice, &request.mode, revision)
            }
        })
        .collect();
    finish(document_id, revision, request, operations)
}

pub fn project_source_fallback(
    document_id: DocumentId,
    revision: Revision,
    text: &TextBuffer,
    request: &ProjectionRequest,
) -> RenderPatch {
    let operations = request
        .slices
        .iter()
        .map(|slice| {
            if matches!(
                slice.axis,
                ProjectionAxis::HeadingSection
                    | ProjectionAxis::HeadingOutline
                    | ProjectionAxis::QuoteLines
            ) {
                empty_operation(slice)
            } else if slice.axis == ProjectionAxis::SourceLines {
                source_line_operation(
                    text,
                    slice.parent_id.clone(),
                    text_range_for_all(text),
                    text.ends_with_lf(),
                    slice,
                )
            } else {
                let nodes = (text.utf16_len() > 0)
                    .then(|| fallback_node(revision, TextRange::new(0, text.utf16_len())))
                    .into_iter()
                    .collect::<Vec<_>>();
                window_operation(slice, nodes)
            }
        })
        .collect();
    finish(document_id, revision, request, operations)
}

fn project_slice(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    slice: &ProjectionSlice,
    mode: &ProjectionMode,
    revision: Revision,
) -> RenderOperation {
    let Some(parent) = parse_node_id(&slice.parent_id).and_then(|id| syntax.node(id)) else {
        return empty_operation(slice);
    };
    match slice.axis {
        ProjectionAxis::SyntaxChildren => {
            let total = u32_len(parent.children.len());
            let (from, to) = syntax_window(slice, total, syntax, parent);
            let inserted = parent.children[from as usize..to as usize]
                .iter()
                .filter_map(|id| syntax.node(*id))
                .map(|node| render_node(text, syntax, node, mode, slice.max_depth))
                .collect();
            replace_children(slice, from, to - from, total, inserted)
        }
        ProjectionAxis::SourceLines => {
            let (range, include_terminal_empty) = source_projection(parent, text);
            source_line_operation(
                text,
                slice.parent_id.clone(),
                range,
                include_terminal_empty,
                slice,
            )
        }
        ProjectionAxis::QuoteLines => {
            quote_line_operation(text, syntax, parent, slice, mode, revision)
        }
        ProjectionAxis::HeadingSection => {
            heading_section_operation(text, syntax, slice, mode, true)
        }
        ProjectionAxis::HeadingOutline => outline::operation(syntax, parent, slice, mode),
    }
}

/// A section is derived solely from confirmed root headings. A partial prefix
/// can prove an endpoint when the next same-or-higher heading is already known;
/// the end of that prefix is never treated as the end of the document.
fn heading_section_operation(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    slice: &ProjectionSlice,
    mode: &ProjectionMode,
    complete: bool,
) -> RenderOperation {
    let Some(id) = parse_node_id(&slice.parent_id) else {
        return empty_operation(slice);
    };
    let Some(heading) = syntax.node(id) else {
        return empty_operation(slice);
    };
    let Some((block, level, next)) = syntax.heading_section(id) else {
        return empty_operation(slice);
    };
    let confirmed = next.is_some() || complete;
    let mut attrs = Vec::new();
    number(&mut attrs, "level", u32::from(level));
    boolean(&mut attrs, "confirmed", confirmed);
    // The body's start follows the known heading, even while its end is unparsed.
    number(&mut attrs, "fromBlock", u32_len(block.saturating_add(1)));
    let prefix_end = heading
        .source_range
        .to
        .min(heading.source_range.from.saturating_add(16));
    let prefix = text
        .slice(TextRange::new(heading.source_range.from, prefix_end))
        .or_else(|_| {
            text.slice(TextRange::new(
                heading.source_range.from,
                prefix_end.saturating_sub(1),
            ))
        });
    if let Some(offset) = prefix
        .ok()
        .and_then(|source| crate::syntax::block::heading_safe_content_offset(&source))
    {
        number(
            &mut attrs,
            "contentSafeFrom",
            heading.source_range.from + offset,
        );
    }
    if confirmed {
        let mut from = heading.source_range.to;
        if from < text.utf16_len()
            && text
                .slice(TextRange::new(from, from + 1))
                .is_ok_and(|s| s == "\n")
        {
            from += 1;
        }
        let to = next
            .and_then(|index| syntax.block(index))
            .map_or_else(|| text.utf16_len(), |node| node.source_range.from);
        range_attribute(
            &mut attrs,
            "sectionRange",
            TextRange::new(from, to.max(from)),
        );
        number(
            &mut attrs,
            "toBlock",
            u32_len(next.unwrap_or_else(|| syntax.block_count())),
        );
    }
    let node = RenderNode {
        id: heading.id.0.to_string(),
        kind: "heading-section".to_owned(),
        source_range: heading.source_range,
        content_version: heading.content_version,
        mode: render_mode(mode),
        child_count: 0,
        attributes: attrs,
        content: RenderContent::Source,
    };
    window_operation(slice, vec![node])
}

fn project_partial_root(
    text: &TextBuffer,
    prefix: &SyntaxSnapshot,
    dirty_ranges: &[TextRange],
    revision: Revision,
    slice: &ProjectionSlice,
    mode: &ProjectionMode,
) -> RenderOperation {
    // Select the window before materializing RenderNodes. Rendering the entire
    // growing prefix on every analysis tick turns bounded projections quadratic.
    let roots = &prefix.root().children;
    let dirty: Vec<_> = dirty_ranges
        .iter()
        .copied()
        .filter(|range| range.from < range.to)
        .collect();
    let total = u32_len(roots.len() + dirty.len());
    let (from, to) = match &slice.window {
        ProjectionWindow::Index { from, to_exclusive } => clamp(*from, *to_exclusive, total),
        ProjectionWindow::AroundRange {
            range,
            before,
            after,
        } => {
            let prefix_index = roots.partition_point(|id| {
                prefix
                    .node(*id)
                    .is_some_and(|node| node_ends_before_anchor(node.source_range, *range))
            });
            let index = if prefix_index == roots.len() {
                prefix_index + dirty.partition_point(|item| node_ends_before_anchor(*item, *range))
            } else {
                prefix_index
            };
            around(index, *before, *after, total)
        }
    };
    let inserted = (from as usize..to as usize)
        .filter_map(|index| {
            if let Some(id) = roots.get(index) {
                prefix
                    .node(*id)
                    .map(|node| render_node(text, prefix, node, mode, slice.max_depth))
            } else {
                Some(fallback_node(revision, dirty[index - roots.len()]))
            }
        })
        .collect();
    replace_children(slice, from, to - from, total, inserted)
}

fn render_node(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    node: &SyntaxNode,
    mode: &ProjectionMode,
    depth: u8,
) -> RenderNode {
    #[cfg(test)]
    RENDERED_NODES.with(|count| count.set(count.get() + 1));
    let children = if depth == 0 {
        Vec::new()
    } else {
        node.children
            .iter()
            .filter_map(|id| syntax.node(*id))
            .map(|child| render_node(text, syntax, child, mode, depth - 1))
            .collect()
    };
    let content = match content_model(&node.kind) {
        ContentModel::Structured if depth > 0 => RenderContent::Structured { children },
        ContentModel::Structured | ContentModel::Opaque => RenderContent::Deferred,
        ContentModel::Source => RenderContent::Source,
    };
    RenderNode {
        id: node.id.0.to_string(),
        kind: node.kind.wire_name(),
        source_range: node.source_range,
        content_version: node.content_version,
        mode: render_mode(mode),
        child_count: u32_len(node.children.len()),
        attributes: attributes(text, syntax, node),
        content,
    }
}

/// Project only the requested physical lines. Nesting comes from the confirmed
/// syntax tree, so a literal `>` inside a quoted code fence is never guessed
/// to be another quote. The line's inline owner is bounded independently.
fn quote_line_operation(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    parent: &SyntaxNode,
    slice: &ProjectionSlice,
    mode: &ProjectionMode,
    revision: Revision,
) -> RenderOperation {
    if !matches!(parent.kind, NodeKind::BlockQuote) {
        return empty_operation(slice);
    }
    let range = parent.source_range;
    let total = text.line_ranges(range, 0, 0).map_or(0, |(total, _)| total);
    let (from, to) = match &slice.window {
        ProjectionWindow::Index { from, to_exclusive } => clamp(*from, *to_exclusive, total),
        ProjectionWindow::AroundRange {
            range: anchor,
            before,
            after,
        } => {
            let (_, index) = text
                .line_index_in_range(range, anchor.from)
                .unwrap_or((0, 0));
            around(
                usize::try_from(index).unwrap_or(usize::MAX),
                *before,
                *after,
                total,
            )
        }
    };
    let ranges = text
        .line_ranges(range, from, to)
        .map_or_else(|_| Vec::new(), |(_, ranges)| ranges);
    let inserted = ranges
        .into_iter()
        .map(|line| {
            let line_end = if line.to > line.from
                && text
                    .slice(TextRange::new(line.to - 1, line.to))
                    .is_ok_and(|s| s == "\n")
            {
                line.to - 1
            } else {
                line.to
            };
            let mut current = parent;
            let (mut depth, mut opens, mut closes) = (0_u32, 0_u32, 0_u32);
            let leaf = loop {
                depth += 1;
                if line.from <= current.source_range.from && current.source_range.from <= line_end {
                    opens += 1;
                }
                if line.from <= current.source_range.to && current.source_range.to <= line_end {
                    closes += 1;
                }
                let start = current.children.partition_point(|id| {
                    syntax
                        .node(*id)
                        .is_some_and(|node| node.source_range.to < line.from)
                });
                let child = current.children[start..]
                    .iter()
                    .filter_map(|id| syntax.node(*id))
                    .find(|node| {
                        node.source_range.from <= line_end && line.from <= node.source_range.to
                    });
                match child {
                    Some(node) if matches!(node.kind, NodeKind::BlockQuote) => current = node,
                    other => break other,
                }
            };
            // One marker comprises at most three leading ASCII spaces, `>` and
            // one optional space/tab. Never copy an arbitrarily long body line.
            let prefix_end = line
                .from
                .saturating_add(depth.saturating_mul(5))
                .min(line_end);
            let marker_to = text
                .slice(TextRange::new(line.from, prefix_end))
                .or_else(|_| {
                    text.slice(TextRange::new(
                        line.from,
                        prefix_end.saturating_sub(1).max(line.from),
                    ))
                })
                .ok()
                .and_then(|prefix| crate::syntax::block::quote_prefix_len(&prefix, depth))
                .and_then(|length| u32::try_from(length).ok())
                .and_then(|length| line.from.checked_add(length));
            let mut attrs = Vec::new();
            number(&mut attrs, "quoteDepth", depth);
            number(&mut attrs, "quoteOpen", opens);
            number(&mut attrs, "quoteClose", closes);
            if let Some(marker_to) = marker_to {
                range_attribute(
                    &mut attrs,
                    "markerRange",
                    TextRange::new(line.from, marker_to),
                );
            }
            let children = leaf
                .filter(|node| {
                    matches!(
                        node.kind,
                        NodeKind::Paragraph
                            | NodeKind::Heading { .. }
                            | NodeKind::ListItem { .. }
                            | NodeKind::BlankLine
                            | NodeKind::FencedCode { .. }
                    )
                })
                .map(|node| {
                    render_node(
                        text,
                        syntax,
                        node,
                        mode,
                        if node.children.len() <= 64 {
                            slice.max_depth.min(4)
                        } else {
                            0
                        },
                    )
                })
                .into_iter()
                .collect::<Vec<_>>();
            RenderNode {
                id: format!("{}:quote-line:{}", parent.id.0, line.from),
                kind: "quote-line".to_owned(),
                source_range: line,
                content_version: revision.0,
                mode: render_mode(mode),
                child_count: u32_len(children.len()),
                attributes: attrs,
                content: RenderContent::Structured { children },
            }
        })
        .collect();
    replace_children(slice, from, to - from, total, inserted)
}

fn source_line_operation(
    text: &TextBuffer,
    parent_id: String,
    range: TextRange,
    include_terminal_empty: bool,
    slice: &ProjectionSlice,
) -> RenderOperation {
    let base_total = text.line_ranges(range, 0, 0).map_or(0, |(total, _)| total);
    let total = base_total.saturating_add(u32::from(include_terminal_empty));
    let (requested_from, requested_to) = match &slice.window {
        ProjectionWindow::Index { from, to_exclusive } => (*from, *to_exclusive),
        ProjectionWindow::AroundRange {
            range: anchor,
            before,
            after,
        } => {
            let (_, index) = text
                .line_index_in_range(range, anchor.from)
                .unwrap_or((0, 0));
            (
                index.saturating_sub(*before),
                index.saturating_add(*after).saturating_add(1).min(total),
            )
        }
    };
    let from = requested_from.min(total);
    let to = requested_to.min(total).max(from);
    let mut ranges = text
        .line_ranges(range, from.min(base_total), to.min(base_total))
        .map_or_else(|_| Vec::new(), |(_, ranges)| ranges);
    if include_terminal_empty && from <= base_total && to > base_total {
        ranges.push(TextRange::new(range.to, range.to));
    }
    let inserted = ranges
        .into_iter()
        .map(|range| RenderNode {
            id: format!("{parent_id}:line:{}", range.from),
            kind: "source-line".to_owned(),
            source_range: range,
            content_version: 0,
            mode: RenderMode::Source,
            child_count: 0,
            attributes: Vec::new(),
            content: RenderContent::Source,
        })
        .collect();
    replace_children(slice, from, to - from, total, inserted)
}

fn source_projection(node: &SyntaxNode, text: &TextBuffer) -> (TextRange, bool) {
    match &node.kind {
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
            let to = closing_range.map_or_else(|| text.utf16_len(), |range| range.from);
            // Adjacent code fences have one display row at the start of the closer.
            let empty_code = matches!(node.kind, NodeKind::FencedCode { .. })
                && closing_range.is_some()
                && content_range.from == to;
            (
                TextRange::new(content_range.from, to),
                empty_code
                    || (closing_range.is_none() && to == text.utf16_len() && text.ends_with_lf()),
            )
        }
        NodeKind::InlineCode { content_range }
        | NodeKind::InlineMath { content_range, .. }
        | NodeKind::EscapedText { content_range } => (*content_range, false),
        _ => (node.source_range, false),
    }
}

enum ContentModel {
    Structured,
    Opaque,
    Source,
}

fn content_model(kind: &NodeKind) -> ContentModel {
    match kind {
        NodeKind::Document
        | NodeKind::Paragraph
        | NodeKind::Heading { .. }
        | NodeKind::BlockQuote
        | NodeKind::ListItem { .. }
        | NodeKind::Table { .. }
        | NodeKind::TableRow { .. }
        | NodeKind::TableCell { .. }
        | NodeKind::Emphasis
        | NodeKind::Strong
        | NodeKind::Strikethrough
        | NodeKind::Link { .. } => ContentModel::Structured,
        NodeKind::FencedCode { .. } | NodeKind::MathBlock { .. } => ContentModel::Opaque,
        NodeKind::BlankLine
        | NodeKind::ThematicBreak
        | NodeKind::Text
        | NodeKind::EscapedText { .. }
        | NodeKind::SoftBreak
        | NodeKind::HardBreak
        | NodeKind::TaskMarker { .. }
        | NodeKind::InlineCode { .. }
        | NodeKind::InlineMath { .. }
        | NodeKind::Image { .. } => ContentModel::Source,
    }
}

fn attributes(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    node: &SyntaxNode,
) -> Vec<RenderAttribute> {
    let mut result = Vec::new();
    match &node.kind {
        NodeKind::TaskMarker { checked } => boolean(&mut result, "checked", *checked),
        NodeKind::Heading { level } => number(&mut result, "level", u32::from(*level)),
        NodeKind::ListItem {
            marker,
            indent_columns,
        } => {
            number(&mut result, "indentColumns", *indent_columns);
            match marker {
                ListMarker::Unordered { marker } => string(&mut result, "marker", bullet(marker)),
                ListMarker::Ordered {
                    number: start,
                    delimiter,
                } => {
                    number(&mut result, "number", *start);
                    string(&mut result, "delimiter", ordered_delimiter(delimiter));
                }
            }
        }
        NodeKind::FencedCode {
            language,
            opening_range,
            content_range,
            closing_range,
            closed,
        } => {
            if let Some(language) = language {
                string(&mut result, "language", language);
            }
            let quote_depth = enclosing_quote_depth(syntax, node);
            if quote_depth > 0 {
                number(&mut result, "quoteDepth", quote_depth);
            }
            boolean(&mut result, "closed", *closed);
            range_attribute(&mut result, "openingRange", *opening_range);
            range_attribute(&mut result, "contentRange", *content_range);
            if let Some(range) = closing_range {
                range_attribute(&mut result, "closingRange", *range);
            }
        }
        NodeKind::MathBlock {
            delimiter,
            opening_range,
            content_range,
            closing_range,
            closed,
        } => {
            string(&mut result, "delimiter", math_delimiter(delimiter));
            boolean(&mut result, "closed", *closed);
            range_attribute(&mut result, "openingRange", *opening_range);
            range_attribute(&mut result, "contentRange", *content_range);
            if let Some(range) = closing_range {
                range_attribute(&mut result, "closingRange", *range);
            }
        }
        NodeKind::Table { alignments } => {
            strings(
                &mut result,
                "alignments",
                alignments
                    .iter()
                    .map(|alignment| table_alignment(alignment).to_owned())
                    .collect(),
            );
            let summary = table_layout_summary(text, syntax, node, alignments.len());
            number(&mut result, "layoutRowCount", summary.row_count);
            numbers(
                &mut result,
                "layoutTotalDisplayColumns",
                summary.total_display_columns,
            );
            numbers(
                &mut result,
                "layoutMaxDisplayColumns",
                summary.max_display_columns,
            );
            numbers(
                &mut result,
                "layoutMaxUnbreakableColumns",
                summary.max_unbreakable_columns,
            );
            numbers(&mut result, "layoutNonEmptyCells", summary.non_empty_cells);
            numbers(&mut result, "layoutDemandWeights", summary.demand_weights);
        }
        NodeKind::TableRow { header } => boolean(&mut result, "header", *header),
        NodeKind::TableCell { alignment } => {
            string(&mut result, "alignment", table_alignment(alignment));
            let (display_columns, max_unbreakable_columns) =
                table_cell_layout_hint(text, syntax, node);
            number(&mut result, "displayColumns", display_columns);
            number(
                &mut result,
                "maxUnbreakableColumns",
                max_unbreakable_columns,
            );
        }
        NodeKind::EscapedText { content_range } => {
            range_attribute(&mut result, "contentRange", *content_range)
        }
        NodeKind::InlineCode { content_range } => {
            range_attribute(&mut result, "contentRange", *content_range)
        }
        NodeKind::InlineMath {
            delimiter,
            content_range,
        } => {
            string(&mut result, "delimiter", math_delimiter(delimiter));
            range_attribute(&mut result, "contentRange", *content_range);
        }
        NodeKind::Link { destination, title } => {
            string(&mut result, "destination", destination);
            if let Some(title) = title {
                string(&mut result, "title", title);
            }
        }
        NodeKind::Image {
            destination,
            title,
            alt,
        } => {
            string(&mut result, "destination", destination);
            string(&mut result, "alt", alt);
            if let Some(title) = title {
                string(&mut result, "title", title);
            }
        }
        _ => {}
    }
    result
}

/// Code plugins receive logical code, so retain the confirmed number of quote
/// ancestors when the underlying content range crosses physical quote markers.
fn enclosing_quote_depth(syntax: &SyntaxSnapshot, target: &SyntaxNode) -> u32 {
    let mut current = syntax.root();
    let mut depth = 0_u32;
    while current.id != target.id {
        let index = current.children.partition_point(|id| {
            syntax
                .node(*id)
                .is_some_and(|child| child.source_range.to < target.source_range.to)
        });
        let Some(child) = current.children.get(index).and_then(|id| syntax.node(*id)) else {
            return 0;
        };
        if child.source_range.from > target.source_range.from
            || child.source_range.to < target.source_range.to
        {
            return 0;
        }
        if matches!(child.kind, NodeKind::BlockQuote) {
            depth += 1;
        }
        current = child;
    }
    depth
}

/// 提供给 PreText 的有限字符级布局提示。这里故意不输出 CSS 像素或比例：字体、
/// 主题和容器宽度属于前端；Rust 只复用已经解析好的 inline 叶子节点，给出有界的
/// 显示列数和不可断 token 下限，避免前端再次解析 Markdown。
fn table_cell_layout_hint(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    node: &SyntaxNode,
) -> (u32, u32) {
    const MAX_HINT_COLUMNS: u32 = 28;
    const MAX_HINT_UTF16: u32 = 2048;
    if !node.children.is_empty() {
        return node
            .children
            .iter()
            .filter_map(|id| syntax.node(*id))
            .map(|child| table_cell_layout_hint(text, syntax, child))
            .fold(
                (0, 0),
                |(display, unbreakable), (next_display, next_unbreakable)| {
                    (
                        display.saturating_add(next_display).min(MAX_HINT_COLUMNS),
                        unbreakable.max(next_unbreakable).min(MAX_HINT_COLUMNS),
                    )
                },
            );
    }

    let range = match &node.kind {
        NodeKind::InlineCode { content_range }
        | NodeKind::InlineMath { content_range, .. }
        | NodeKind::EscapedText { content_range } => *content_range,
        _ => node.source_range,
    };
    let bounded = TextRange::new(
        range.from,
        range.to.min(range.from.saturating_add(MAX_HINT_UTF16)),
    );
    let Ok(source) = text.slice(bounded) else {
        return (0, 0);
    };
    let mut display = 0_u32;
    let mut run = 0_u32;
    let mut max_run = 0_u32;
    for character in source.chars() {
        if character.is_whitespace() {
            run = 0;
            display = display.saturating_add(1);
            continue;
        }
        let width = if wide_character(character) { 2 } else { 1 };
        display = display.saturating_add(width).min(MAX_HINT_COLUMNS);
        run = run.saturating_add(width).min(MAX_HINT_COLUMNS);
        max_run = max_run.max(run).min(MAX_HINT_COLUMNS);
    }
    (display, max_run)
}

/// 表格级布局证据。它只使用 Rust 已经解析出的 cell 语义，不依赖 DOM/CSS 像素。
///
/// Preview 只挂载可视行，不能靠浏览器完整扫描 2,000 行表格；因此这里把每一列的
/// 总显示列数、最大显示列数和不可断 token 上限一次性投影给前端。前端仍负责把
/// 这些逻辑单位转换成当前字体和容器下的实际像素宽度。
struct TableLayoutSummary {
    row_count: u32,
    total_display_columns: Vec<u32>,
    max_display_columns: Vec<u32>,
    max_unbreakable_columns: Vec<u32>,
    non_empty_cells: Vec<u32>,
    demand_weights: Vec<u32>,
}

fn table_layout_summary(
    text: &TextBuffer,
    syntax: &SyntaxSnapshot,
    table: &SyntaxNode,
    column_count: usize,
) -> TableLayoutSummary {
    let mut summary = TableLayoutSummary {
        row_count: u32::try_from(table.children.len()).unwrap_or(u32::MAX),
        total_display_columns: vec![0; column_count],
        max_display_columns: vec![0; column_count],
        max_unbreakable_columns: vec![0; column_count],
        non_empty_cells: vec![0; column_count],
        demand_weights: vec![0; column_count],
    };

    for row_id in &table.children {
        let Some(row) = syntax.node(*row_id) else {
            continue;
        };
        for (column, cell_id) in row.children.iter().take(column_count).enumerate() {
            let Some(cell) = syntax.node(*cell_id) else {
                continue;
            };
            let (display, unbreakable) = table_cell_layout_hint(text, syntax, cell);
            summary.total_display_columns[column] =
                summary.total_display_columns[column].saturating_add(display);
            summary.max_display_columns[column] = summary.max_display_columns[column].max(display);
            summary.max_unbreakable_columns[column] =
                summary.max_unbreakable_columns[column].max(unbreakable);
            if display > 0 {
                summary.non_empty_cells[column] = summary.non_empty_cells[column].saturating_add(1);
            }
        }
    }
    for column in 0..column_count {
        let count = summary.non_empty_cells[column];
        if count == 0 {
            continue;
        }
        // 4 个逻辑列是一个紧凑 cell 的基准。超出平均值的最大 cell 代表
        // 少数长内容带来的换行压力；平均值本身用于避免所有内容都偏长时
        // 仍然把这列当成完全没有弹性。这里输出无量纲整数权重，CSS 像素
        // 仍由前端按当前字体、padding 和容器宽度完成换算。
        let average = summary.total_display_columns[column] / count;
        let maximum =
            summary.max_display_columns[column].max(summary.max_unbreakable_columns[column]);
        let outlier_pressure = maximum.saturating_sub(average.max(4));
        let density_pressure = average.saturating_sub(4);
        summary.demand_weights[column] = outlier_pressure
            .saturating_mul(2)
            .saturating_add(density_pressure);
    }
    summary
}

fn wide_character(character: char) -> bool {
    matches!(
        character as u32,
        0x1100..=0x115f
            | 0x2329..=0x232a
            | 0x2e80..=0xa4cf
            | 0xac00..=0xd7a3
            | 0xf900..=0xfaff
            | 0xfe10..=0xfe19
            | 0xfe30..=0xfe6f
            | 0xff00..=0xff60
            | 0xffe0..=0xffe6
    )
}

fn string(attributes: &mut Vec<RenderAttribute>, name: &str, value: &str) {
    attributes.push(RenderAttribute {
        name: name.to_owned(),
        value: RenderValue::String(value.to_owned()),
    });
}

fn number(attributes: &mut Vec<RenderAttribute>, name: &str, value: u32) {
    attributes.push(RenderAttribute {
        name: name.to_owned(),
        value: RenderValue::Number(value),
    });
}

fn boolean(attributes: &mut Vec<RenderAttribute>, name: &str, value: bool) {
    attributes.push(RenderAttribute {
        name: name.to_owned(),
        value: RenderValue::Boolean(value),
    });
}

fn range_attribute(attributes: &mut Vec<RenderAttribute>, name: &str, value: TextRange) {
    attributes.push(RenderAttribute {
        name: name.to_owned(),
        value: RenderValue::Range(value),
    });
}

fn strings(attributes: &mut Vec<RenderAttribute>, name: &str, value: Vec<String>) {
    attributes.push(RenderAttribute {
        name: name.to_owned(),
        value: RenderValue::Strings(value),
    });
}

fn numbers(attributes: &mut Vec<RenderAttribute>, name: &str, value: Vec<u32>) {
    attributes.push(RenderAttribute {
        name: name.to_owned(),
        value: RenderValue::Numbers(value),
    });
}

fn bullet(marker: &BulletMarker) -> &'static str {
    match marker {
        BulletMarker::Dash => "-",
        BulletMarker::Plus => "+",
        BulletMarker::Asterisk => "*",
    }
}

fn ordered_delimiter(delimiter: &OrderedDelimiter) -> &'static str {
    match delimiter {
        OrderedDelimiter::Period => ".",
        OrderedDelimiter::Parenthesis => ")",
    }
}

fn math_delimiter(delimiter: &MathDelimiter) -> &'static str {
    match delimiter {
        MathDelimiter::Dollar => "dollar",
        MathDelimiter::Bracket => "bracket",
    }
}

fn table_alignment(alignment: &TableAlignment) -> &'static str {
    match alignment {
        TableAlignment::None => "none",
        TableAlignment::Left => "left",
        TableAlignment::Center => "center",
        TableAlignment::Right => "right",
    }
}

fn fallback_node(revision: Revision, range: TextRange) -> RenderNode {
    RenderNode {
        id: format!("dirty:r{}:{}:{}", revision.0, range.from, range.to),
        kind: "dirty-source".to_owned(),
        source_range: range,
        content_version: revision.0,
        mode: RenderMode::Source,
        child_count: 0,
        attributes: Vec::new(),
        content: RenderContent::Source,
    }
}

fn window_operation(slice: &ProjectionSlice, nodes: Vec<RenderNode>) -> RenderOperation {
    let total = u32_len(nodes.len());
    let (from, to) = render_window(slice, total, &nodes);
    replace_children(
        slice,
        from,
        to - from,
        total,
        nodes
            .into_iter()
            .skip(from as usize)
            .take((to - from) as usize)
            .collect(),
    )
}

fn empty_operation(slice: &ProjectionSlice) -> RenderOperation {
    replace_children(slice, 0, 0, 0, Vec::new())
}

fn replace_children(
    slice: &ProjectionSlice,
    from: u32,
    remove_count: u32,
    total_children: u32,
    inserted: Vec<RenderNode>,
) -> RenderOperation {
    RenderOperation::ReplaceChildren {
        parent_id: slice.parent_id.clone(),
        axis: slice.axis.clone(),
        from,
        remove_count,
        total_children,
        inserted,
    }
}

fn syntax_window(
    slice: &ProjectionSlice,
    total: u32,
    syntax: &SyntaxSnapshot,
    parent: &SyntaxNode,
) -> (u32, u32) {
    match &slice.window {
        ProjectionWindow::Index { from, to_exclusive } => clamp(*from, *to_exclusive, total),
        ProjectionWindow::AroundRange {
            range,
            before,
            after,
        } => around(
            parent.children.partition_point(|id| {
                syntax
                    .node(*id)
                    .is_some_and(|node| node_ends_before_anchor(node.source_range, *range))
            }),
            *before,
            *after,
            total,
        ),
    }
}

fn render_window(slice: &ProjectionSlice, total: u32, nodes: &[RenderNode]) -> (u32, u32) {
    match &slice.window {
        ProjectionWindow::Index { from, to_exclusive } => clamp(*from, *to_exclusive, total),
        ProjectionWindow::AroundRange {
            range,
            before,
            after,
        } => around(
            nodes.partition_point(|node| node_ends_before_anchor(node.source_range, *range)),
            *before,
            *after,
            total,
        ),
    }
}

/// 零宽节点（尤其是空白行）仍然是源码拓扑的一部分。
///
/// `to <= anchor.from` 对普通区间成立，但会把 `from == to == anchor.from`
/// 的空白节点误判为已经位于窗口之前。只有非空区间在锚点处结束时，才应该
/// 移到窗口之前；零宽节点必须留给当前窗口消费。
fn node_ends_before_anchor(node: TextRange, anchor: TextRange) -> bool {
    node.to < anchor.from || (node.to == anchor.from && node.from < node.to)
}

fn around(index: usize, before: u32, after: u32, total: u32) -> (u32, u32) {
    if total == 0 {
        return (0, 0);
    }
    let index = u32::try_from(index).unwrap_or(u32::MAX).min(total - 1);
    (
        index.saturating_sub(before),
        index.saturating_add(after).saturating_add(1).min(total),
    )
}

fn clamp(from: u32, to_exclusive: u32, total: u32) -> (u32, u32) {
    let from = from.min(total);
    (from, to_exclusive.min(total).max(from))
}

fn parse_node_id(id: &str) -> Option<NodeId> {
    id.parse::<u64>().ok().map(NodeId)
}

fn text_range_for_all(text: &TextBuffer) -> TextRange {
    TextRange::new(0, text.utf16_len())
}

fn u32_len(length: usize) -> u32 {
    u32::try_from(length).unwrap_or(u32::MAX)
}

fn finish(
    document_id: DocumentId,
    revision: Revision,
    request: &ProjectionRequest,
    operations: Vec<RenderOperation>,
) -> RenderPatch {
    RenderPatch {
        document_id,
        document_revision: revision,
        view_revision: request.view_revision,
        operations,
    }
}

fn render_mode(mode: &ProjectionMode) -> RenderMode {
    match mode {
        ProjectionMode::Source => RenderMode::Source,
        ProjectionMode::Preview => RenderMode::Preview,
        ProjectionMode::Hybrid => RenderMode::Hybrid,
    }
}

#[cfg(test)]
thread_local! {
    static RENDERED_NODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syntax::{CompiledSyntaxProfile, SyntaxAnalysisSession, WorkBudget};

    fn section(
        syntax: &SyntaxSnapshot,
        text: &TextBuffer,
        id: NodeId,
        complete: bool,
    ) -> RenderNode {
        let slice = ProjectionSlice {
            parent_id: id.0.to_string(),
            axis: ProjectionAxis::HeadingSection,
            window: ProjectionWindow::Index {
                from: 0,
                to_exclusive: 1,
            },
            max_depth: 0,
            collapsed_headings: Vec::new(),
        };
        let RenderOperation::ReplaceChildren { mut inserted, .. } =
            heading_section_operation(text, syntax, &slice, &ProjectionMode::Hybrid, complete);
        inserted.remove(0)
    }

    fn attr<'a>(node: &'a RenderNode, name: &str) -> Option<&'a RenderValue> {
        node.attributes
            .iter()
            .find(|attr| attr.name == name)
            .map(|attr| &attr.value)
    }

    #[test]
    fn quote_lines_preserve_confirmed_nesting_and_literal_fence_content() {
        let source = "> 上层\n> >>>\n> >>>>深层 **加粗**\n> 普通\n> ``` ts\n> > literal\n> ```\n";
        let text = TextBuffer::from_source(source);
        let syntax =
            crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                .unwrap();
        let root = syntax.block(0).unwrap();
        let slice = ProjectionSlice {
            parent_id: root.id.0.to_string(),
            axis: ProjectionAxis::QuoteLines,
            window: ProjectionWindow::Index {
                from: 0,
                to_exclusive: 7,
            },
            max_depth: 4,
            collapsed_headings: Vec::new(),
        };
        let RenderOperation::ReplaceChildren {
            total_children,
            inserted,
            ..
        } = quote_line_operation(
            &text,
            &syntax,
            root,
            &slice,
            &ProjectionMode::Hybrid,
            Revision(7),
        );
        assert_eq!(total_children, 7);
        assert_eq!(inserted.len(), 7);
        let depths: Vec<_> = inserted
            .iter()
            .map(|node| attr(node, "quoteDepth").cloned())
            .collect();
        assert_eq!(
            depths,
            vec![1, 4, 5, 1, 1, 1, 1]
                .into_iter()
                .map(|d| Some(RenderValue::Number(d)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            attr(&inserted[1], "quoteOpen"),
            Some(&RenderValue::Number(3))
        );
        assert_eq!(
            attr(&inserted[2], "quoteOpen"),
            Some(&RenderValue::Number(1))
        );
        assert_eq!(
            attr(&inserted[2], "quoteClose"),
            Some(&RenderValue::Number(4))
        );
        let Some(RenderValue::Range(prefix)) = attr(&inserted[5], "markerRange") else {
            panic!("missing marker range")
        };
        assert_eq!(
            text.slice(*prefix).unwrap(),
            "> ",
            "literal code `>` is not a quote marker"
        );
        assert!(inserted.iter().all(|node| node.content_version == 7));
        let RenderContent::Structured { children } = &inserted[2].content else {
            panic!("missing inline owner")
        };
        assert_eq!(children[0].kind, "paragraph");
        assert!(
            matches!(&children[0].content, RenderContent::Structured { children } if children.iter().any(|child| child.kind == "strong"))
        );
        let RenderContent::Structured { children } = &inserted[5].content else {
            panic!("missing code owner")
        };
        assert_eq!(children[0].kind, "fenced-code");
        assert_eq!(
            attr(&children[0], "quoteDepth"),
            Some(&RenderValue::Number(1))
        );
    }

    #[test]
    fn quote_lines_request_only_a_bounded_window_of_a_large_quote() {
        let source = (0..20_000)
            .map(|i| format!("> line {i}\n"))
            .collect::<String>();
        let text = TextBuffer::from_source(&source);
        let syntax =
            crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                .unwrap();
        let root = syntax.block(0).unwrap();
        let slice = ProjectionSlice {
            parent_id: root.id.0.to_string(),
            axis: ProjectionAxis::QuoteLines,
            window: ProjectionWindow::Index {
                from: 10_000,
                to_exclusive: 10_003,
            },
            max_depth: 1,
            collapsed_headings: Vec::new(),
        };
        let RenderOperation::ReplaceChildren {
            from,
            total_children,
            inserted,
            ..
        } = quote_line_operation(
            &text,
            &syntax,
            root,
            &slice,
            &ProjectionMode::Hybrid,
            Revision(0),
        );
        assert_eq!((from, total_children, inserted.len()), (10_000, 20_000, 3));
        assert!(
            text.slice(inserted[0].source_range)
                .unwrap()
                .contains("line 10000")
        );
    }

    #[test]
    fn quote_lines_handle_whitespace_and_a_very_long_unicode_line() {
        let source = format!(
            ">    > 两层😀\n>     > 字面符号\n> > {}😀",
            "中文".repeat(200_000)
        );
        let text = TextBuffer::from_source(&source);
        let syntax =
            crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                .unwrap();
        let root = syntax.block(0).unwrap();
        let slice = ProjectionSlice {
            parent_id: root.id.0.to_string(),
            axis: ProjectionAxis::QuoteLines,
            window: ProjectionWindow::Index {
                from: 0,
                to_exclusive: 3,
            },
            max_depth: 4,
            collapsed_headings: Vec::new(),
        };
        let RenderOperation::ReplaceChildren { inserted, .. } = quote_line_operation(
            &text,
            &syntax,
            root,
            &slice,
            &ProjectionMode::Hybrid,
            Revision(0),
        );
        assert_eq!(inserted.len(), 3);
        assert_eq!(
            attr(&inserted[0], "quoteDepth"),
            Some(&RenderValue::Number(2))
        );
        assert_eq!(
            attr(&inserted[1], "quoteDepth"),
            Some(&RenderValue::Number(1))
        );
        assert_eq!(
            attr(&inserted[2], "quoteDepth"),
            Some(&RenderValue::Number(2))
        );
        let Some(RenderValue::Range(prefix)) = attr(&inserted[2], "markerRange") else {
            panic!("missing prefix")
        };
        assert_eq!(text.slice(*prefix).unwrap(), "> > ");
        assert!(inserted[2].source_range.to - inserted[2].source_range.from > 400_000);
    }

    #[test]
    fn heading_sections_use_only_confirmed_root_syntax_and_preserve_line_boundaries() {
        let source = "# A😀\nbody\n> # quote\n``` ts\n# code\n```\n## child\nchild body\n# B\nend";
        let text = TextBuffer::from_source(source);
        let syntax =
            crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                .unwrap();
        let headings: Vec<_> = syntax
            .root()
            .children
            .iter()
            .filter_map(|id| {
                let node = syntax.node(*id)?;
                matches!(node.kind, NodeKind::Heading { .. }).then_some(node)
            })
            .collect();
        assert_eq!(headings.len(), 3);
        let parent = section(&syntax, &text, headings[0].id, true);
        assert_eq!(
            attr(&parent, "confirmed"),
            Some(&RenderValue::Boolean(true))
        );
        let Some(RenderValue::Range(range)) = attr(&parent, "sectionRange") else {
            panic!("missing range")
        };
        assert_eq!(
            text.slice(*range).unwrap(),
            "body\n> # quote\n``` ts\n# code\n```\n## child\nchild body\n"
        );
        let child = section(&syntax, &text, headings[1].id, true);
        let Some(RenderValue::Range(range)) = attr(&child, "sectionRange") else {
            panic!("missing child range")
        };
        assert_eq!(text.slice(*range).unwrap(), "child body\n");
        assert_eq!(
            attr(&section(&syntax, &text, headings[0].id, false), "confirmed"),
            Some(&RenderValue::Boolean(true))
        );
        let partial = section(&syntax, &text, headings[2].id, false);
        assert_eq!(
            attr(&partial, "confirmed"),
            Some(&RenderValue::Boolean(false))
        );
        let following_block = syntax
            .root()
            .children
            .iter()
            .position(|id| *id == headings[2].id)
            .unwrap()
            + 1;
        assert_eq!(
            attr(&partial, "fromBlock"),
            Some(&RenderValue::Number(u32_len(following_block)))
        );
        assert_eq!(attr(&partial, "toBlock"), None);
        assert_eq!(attr(&partial, "sectionRange"), None);
    }

    #[test]
    fn heading_section_respects_requested_projection_window() {
        let text = TextBuffer::from_source("# A\nbody\n# B");
        let syntax =
            crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                .unwrap();
        let id = syntax.block(0).unwrap().id;
        for (requested_from, requested_to, expected_from, expected_count) in
            [(0, 0, 0, 0), (0, 1, 0, 1), (1, 2, 1, 0), (4, 5, 1, 0)]
        {
            let slice = ProjectionSlice {
                parent_id: id.0.to_string(),
                axis: ProjectionAxis::HeadingSection,
                window: ProjectionWindow::Index {
                    from: requested_from,
                    to_exclusive: requested_to,
                },
                max_depth: 0,
                collapsed_headings: Vec::new(),
            };
            let RenderOperation::ReplaceChildren {
                from,
                remove_count,
                total_children,
                inserted,
                ..
            } = heading_section_operation(&text, &syntax, &slice, &ProjectionMode::Hybrid, true);
            assert_eq!(
                (from, remove_count, total_children),
                (expected_from, expected_count, 1)
            );
            assert_eq!(inserted.len(), expected_count as usize);
        }
    }

    #[test]
    fn unclosed_fence_and_heading_level_changes_invalidate_section_boundaries() {
        let text = TextBuffer::from_source("# A\n``` ts\n# B\nbody");
        let mut syntax =
            crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                .unwrap();
        let ids: Vec<_> = syntax
            .root()
            .children
            .iter()
            .copied()
            .filter(|id| matches!(syntax.node(*id).unwrap().kind, NodeKind::Heading { .. }))
            .collect();
        assert_eq!(ids.len(), 2);
        let before = section(&syntax, &text, ids[0], true);
        let Some(RenderValue::Range(range)) = attr(&before, "sectionRange") else {
            panic!("missing range")
        };
        assert_eq!(text.slice(*range).unwrap(), "``` ts\n");
        syntax
            .nodes_mut()
            .iter_mut()
            .find(|node| node.id == ids[1])
            .unwrap()
            .kind = NodeKind::Heading { level: 2 };
        syntax.rebuild_index();
        let after = section(&syntax, &text, ids[0], true);
        let Some(RenderValue::Range(range)) = attr(&after, "sectionRange") else {
            panic!("missing range")
        };
        assert_eq!(text.slice(*range).unwrap(), "``` ts\n# B\nbody");
    }

    #[test]
    fn heading_index_matches_independent_forward_scan_for_mixed_documents() {
        let mut seed = 0x591d_ba77_u32;
        let mut random = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed >> 8
        };
        let lines = [
            "# A",
            "## B",
            "### 中😀",
            "#### D",
            "> # quote",
            "ordinary",
            "``` ts",
            "```",
            "$$",
            "",
            "- item",
            "\\# escaped",
        ];
        for _ in 0..180 {
            let source = (0..85)
                .map(|_| lines[random() as usize % lines.len()])
                .collect::<Vec<_>>()
                .join("\n");
            let text = TextBuffer::from_source(&source);
            let syntax =
                crate::syntax::parse(&text, &CompiledSyntaxProfile::compile(Default::default()))
                    .unwrap();
            for block in 0..syntax.block_count() {
                let heading = syntax.block(block).unwrap();
                let NodeKind::Heading { level } = heading.kind else {
                    continue;
                };
                let expected = (block + 1..syntax.block_count()).find(|index| {
                    matches!(syntax.block(*index).unwrap().kind, NodeKind::Heading { level: next } if next <= level)
                });
                assert_eq!(
                    syntax.heading_section(heading.id),
                    Some((block, level, expected))
                );
                let projected = section(&syntax, &text, heading.id, true);
                assert_eq!(
                    attr(&projected, "toBlock"),
                    Some(&RenderValue::Number(u32_len(
                        expected.unwrap_or(syntax.block_count())
                    )))
                );
            }
        }
    }

    #[test]
    fn partial_windows_match_eager_projection_without_rendering_the_prefix() {
        let source = "# heading **bold**\n\nparagraph\n".repeat(2000);
        let text = TextBuffer::from_source(&source);
        let mut session = SyntaxAnalysisSession::from_text(
            &text,
            CompiledSyntaxProfile::compile(Default::default()),
        )
        .unwrap();
        session.poll(WorkBudget::new(5000, 5000)).unwrap();
        let prefix = session.prefix_snapshot();
        assert!(prefix.block_count() > 1000);
        let end = prefix.root().source_range.to;
        let dirty = [
            TextRange::new(end, end),
            TextRange::new(end, text.utf16_len()),
        ];
        let mut eager: Vec<_> = prefix
            .root()
            .children
            .iter()
            .map(|id| {
                render_node(
                    &text,
                    &prefix,
                    prefix.node(*id).unwrap(),
                    &ProjectionMode::Preview,
                    1,
                )
            })
            .collect();
        eager.push(fallback_node(Revision(0), dirty[1]));
        let count = u32_len(eager.len());
        let mut windows = vec![
            ProjectionWindow::Index {
                from: 0,
                to_exclusive: 3,
            },
            ProjectionWindow::Index {
                from: count - 2,
                to_exclusive: count + 4,
            },
            ProjectionWindow::Index {
                from: count + 1,
                to_exclusive: count + 2,
            },
        ];
        for anchor in [0, 19, end.saturating_sub(1), end, text.utf16_len()] {
            windows.push(ProjectionWindow::AroundRange {
                range: TextRange::new(anchor, anchor),
                before: 1,
                after: 1,
            });
        }
        for window in windows {
            let slice = ProjectionSlice {
                parent_id: "0".into(),
                axis: ProjectionAxis::SyntaxChildren,
                window,
                max_depth: 1,
                collapsed_headings: Vec::new(),
            };
            let expected = window_operation(&slice, eager.clone());
            RENDERED_NODES.with(|count| count.set(0));
            let actual = project_partial_root(
                &text,
                &prefix,
                &dirty,
                Revision(0),
                &slice,
                &ProjectionMode::Preview,
            );
            assert_eq!(actual, expected);
            // Up to three roots, plus their inline children, independently of prefix size.
            assert!(RENDERED_NODES.with(|count| count.get()) <= 12);
        }
    }
}
