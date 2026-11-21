use super::{
    NodeKind, ProjectionMode, ProjectionSlice, ProjectionWindow, RenderContent, RenderNode,
    RenderOperation, SyntaxNode, SyntaxSnapshot, around, boolean, clamp, empty_operation, number,
    numbers, parse_node_id, render_mode, replace_children, u32_len,
};

/// A jump crosses an entire collapsed subtree, regardless of its number of headings.
/// Store only outermost folds, with cumulative offsets for both rank lookups.
#[derive(Default)]
struct HiddenHeadings {
    jumps: Vec<FoldJump>,
    count: usize,
}

struct FoldJump {
    first_hidden: usize,
    visible_after: usize,
    total_hidden: usize,
}

impl HiddenHeadings {
    fn new(syntax: &SyntaxSnapshot, collapsed: &[String]) -> Self {
        let headings = syntax.headings();
        let mut slots: Vec<_> = collapsed
            .iter()
            .filter_map(|id| syntax.heading_slot(parse_node_id(id)?))
            .collect();
        slots.sort_unstable();
        let mut result = Self::default();
        let mut previous_end = 0;
        for slot in slots {
            let from = slot + 1;
            let end = headings[slot].next.unwrap_or(headings.len());
            if slot < previous_end || from == end {
                continue;
            }
            let visible = from - result.count;
            result.count += end - from;
            result.jumps.push(FoldJump {
                first_hidden: from,
                visible_after: visible,
                total_hidden: result.count,
            });
            previous_end = end;
        }
        result
    }

    fn physical(&self, visible: usize) -> usize {
        let end = self
            .jumps
            .partition_point(|jump| jump.visible_after <= visible);
        visible + self.jumps[..end].last().map_or(0, |jump| jump.total_hidden)
    }

    fn visible(&self, physical: usize) -> usize {
        let end = self
            .jumps
            .partition_point(|jump| jump.first_hidden <= physical);
        self.jumps[..end].last().map_or(physical, |jump| {
            physical
                .saturating_sub(jump.total_hidden)
                .max(jump.visible_after - 1)
        })
    }
}

pub(super) fn operation(
    syntax: &SyntaxSnapshot,
    parent: &SyntaxNode,
    slice: &ProjectionSlice,
    mode: &ProjectionMode,
) -> RenderOperation {
    if parent.id != syntax.root().id {
        return empty_operation(slice);
    }
    let headings = syntax.headings();
    let hidden = HiddenHeadings::new(syntax, &slice.collapsed_headings);
    let total = u32_len(headings.len() - hidden.count);
    let (from, to) = match &slice.window {
        ProjectionWindow::Index { from, to_exclusive } => clamp(*from, *to_exclusive, total),
        ProjectionWindow::AroundRange {
            range,
            before,
            after,
        } => {
            let end = headings.partition_point(|item| {
                syntax
                    .node(item.id)
                    .is_some_and(|node| node.source_range.from <= range.from)
            });
            around(
                hidden.visible(end.saturating_sub(1)),
                *before,
                *after,
                total,
            )
        }
    };
    let inserted = (from as usize..to as usize)
        .map(|visible| {
            let index = hidden.physical(visible);
            let item = &headings[index];
            let heading = syntax.node(item.id).expect("indexed heading");
            let mut attrs = Vec::new();
            number(&mut attrs, "level", u32::from(item.level));
            number(&mut attrs, "depth", u32::from(item.depth));
            if let Some(parent) = item.parent {
                number(&mut attrs, "parentIndex", u32_len(hidden.visible(parent)));
            }
            if headings
                .get(index + 1)
                .is_some_and(|next| next.level > item.level)
            {
                boolean(&mut attrs, "hasChildren", true);
            }
            number(&mut attrs, "blockIndex", u32_len(item.block));
            if let Some(next) = headings
                .get(hidden.physical(visible + 1))
                .and_then(|item| syntax.node(item.id))
            {
                number(&mut attrs, "nextHeadingFrom", next.source_range.from);
            }
            // Labels use confirmed inline text ranges. A pathological single heading
            // must not make a viewport request traverse its entire inline tree.
            let mut ranges = Vec::new();
            let mut remaining = 128;
            if !collect_label(syntax, heading, &mut remaining, &mut ranges) {
                boolean(&mut attrs, "truncated", true);
            }
            numbers(&mut attrs, "labelRanges", ranges);
            RenderNode {
                id: item.id.0.to_string(),
                kind: "outline-heading".into(),
                source_range: heading.source_range,
                content_version: heading.content_version,
                mode: render_mode(mode),
                child_count: 0,
                attributes: attrs,
                content: RenderContent::Source,
            }
        })
        .collect();
    replace_children(slice, from, to - from, total, inserted)
}

fn collect_label(
    syntax: &SyntaxSnapshot,
    node: &SyntaxNode,
    remaining: &mut usize,
    ranges: &mut Vec<u32>,
) -> bool {
    for child in node.children.iter().filter_map(|id| syntax.node(*id)) {
        if *remaining == 0 {
            return false;
        }
        *remaining -= 1;
        let range = match child.kind {
            NodeKind::Text => child.source_range,
            NodeKind::EscapedText { content_range }
            | NodeKind::InlineCode { content_range }
            | NodeKind::InlineMath { content_range, .. } => content_range,
            _ => {
                if !collect_label(syntax, child, remaining, ranges) {
                    return false;
                }
                continue;
            }
        };
        ranges.extend([range.from, range.to]);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        syntax::{CompiledSyntaxProfile, parse},
        text::TextBuffer,
    };
    use editor_protocol::{
        DocumentId, ProjectionAxis, ProjectionRequest, RenderValue, Revision, TextRange,
    };

    fn request(window: ProjectionWindow) -> ProjectionRequest {
        ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            mode: ProjectionMode::Preview,
            active_range: None,
            slices: vec![ProjectionSlice {
                parent_id: "0".into(),
                axis: ProjectionAxis::HeadingOutline,
                window,
                max_depth: 0,
                collapsed_headings: Vec::new(),
            }],
        }
    }

    #[test]
    fn label_uses_inline_ranges_and_distinguishes_empty_and_duplicate_root_headings() {
        let text = TextBuffer::from_source(
            "# **中😀** [link](url) ![alt](img) `code` \\~ ##\n> # quoted\n``` md\n# fenced\n```\n$$\n# math\n$$\n###\n# same\n# same",
        );
        let syntax = parse(&text, &CompiledSyntaxProfile::compile(Default::default())).unwrap();
        let req = request(ProjectionWindow::Index {
            from: 0,
            to_exclusive: 20,
        });
        let patch =
            super::super::project(DocumentId("a".into()), Revision(0), &text, &syntax, &req);
        let RenderOperation::ReplaceChildren {
            inserted,
            total_children,
            ..
        } = &patch.operations[0];
        assert_eq!(*total_children, 4);
        let labels: Vec<String> = inserted
            .iter()
            .map(|node| {
                let RenderValue::Numbers(spans) = &node
                    .attributes
                    .iter()
                    .find(|a| a.name == "labelRanges")
                    .unwrap()
                    .value
                else {
                    panic!("expected ranges")
                };
                let (ranges, remainder) = spans.as_chunks::<2>();
                assert!(remainder.is_empty());
                ranges
                    .iter()
                    .map(|&[from, to]| text.slice(TextRange::new(from, to)).unwrap())
                    .collect()
            })
            .collect();
        assert_eq!(labels, ["中😀 link alt code ~", "", "same", "same"]);
        assert_ne!(inserted[2].id, inserted[3].id);
        let fallback =
            super::super::project_source_fallback(DocumentId("a".into()), Revision(0), &text, &req);
        assert!(matches!(
            &fallback.operations[0],
            RenderOperation::ReplaceChildren {
                total_children: 0,
                ..
            }
        ));
        let prefix = TextBuffer::from_source("# confirmed\n");
        let confirmed =
            parse(&prefix, &CompiledSyntaxProfile::compile(Default::default())).unwrap();
        let partial = super::super::project_partial(
            DocumentId("a".into()),
            Revision(0),
            &text,
            &confirmed,
            &[TextRange::new(prefix.utf16_len(), text.utf16_len())],
            &req,
        );
        assert!(matches!(
            &partial.operations[0],
            RenderOperation::ReplaceChildren {
                total_children: 1,
                ..
            }
        ));
    }

    #[test]
    fn folded_windows_skip_descendants_and_map_hidden_anchors_to_the_visible_parent() {
        let text =
            TextBuffer::from_source("# A\n### sub\n###### deep\n## sibling\n# B\n#### child\n# C");
        let syntax = parse(&text, &CompiledSyntaxProfile::compile(Default::default())).unwrap();
        let ids: Vec<_> = syntax
            .headings()
            .iter()
            .map(|h| h.id.0.to_string())
            .collect();
        // Exhaust the fold combinations, including nested, empty and nonadjacent branches.
        for mask in 0..(1 << ids.len()) {
            let mut req = request(ProjectionWindow::Index {
                from: 0,
                to_exclusive: 2,
            });
            let slice = &mut req.slices[0];
            let mut visible = Vec::new();
            let mut hidden_under = None;
            for (slot, heading) in syntax.headings().iter().enumerate() {
                let collapsed = mask & (1 << slot) != 0;
                if collapsed {
                    slice.collapsed_headings.push(ids[slot].clone());
                }
                if hidden_under.is_some_and(|level| heading.level > level) {
                    continue;
                }
                visible.push(slot);
                hidden_under = collapsed.then_some(heading.level);
            }
            slice.collapsed_headings.push("deleted".into());
            for from in 0..=visible.len() {
                slice.window = ProjectionWindow::Index {
                    from: from as u32,
                    to_exclusive: from as u32 + 2,
                };
                let RenderOperation::ReplaceChildren {
                    total_children,
                    inserted,
                    ..
                } = operation(&syntax, syntax.root(), slice, &req.mode);
                assert_eq!(total_children as usize, visible.len());
                assert!(
                    inserted
                        .iter()
                        .map(|node| &node.id)
                        .eq(visible[from..].iter().take(2).map(|&slot| &ids[slot]))
                );
            }
            for (slot, heading) in syntax.headings().iter().enumerate() {
                slice.window = ProjectionWindow::AroundRange {
                    range: syntax.node(heading.id).unwrap().source_range,
                    before: 0,
                    after: 0,
                };
                let RenderOperation::ReplaceChildren { inserted, .. } =
                    operation(&syntax, syntax.root(), slice, &req.mode);
                let previous = visible[visible.partition_point(|&at| at <= slot) - 1];
                assert_eq!(inserted[0].id, ids[previous]);
            }
        }
    }

    #[test]
    fn late_windows_materialize_only_requested_headings_and_bound_inline_work() {
        let mut source = (0..10_000)
            .map(|i| format!("# {i}\nbody\n"))
            .collect::<String>();
        let last_from = source.len() as u32;
        source.push_str(&format!("## {}", "**a** ".repeat(400)));
        let text = TextBuffer::from_source(&source);
        let syntax = parse(&text, &CompiledSyntaxProfile::compile(Default::default())).unwrap();
        for window in [
            ProjectionWindow::Index {
                from: 9_998,
                to_exclusive: u32::MAX,
            },
            ProjectionWindow::AroundRange {
                range: TextRange::new(last_from + 2, last_from + 2),
                before: 2,
                after: 0,
            },
        ] {
            let req = request(window);
            let RenderOperation::ReplaceChildren {
                from,
                inserted,
                total_children,
                ..
            } = operation(&syntax, syntax.root(), &req.slices[0], &req.mode);
            assert_eq!((from, total_children, inserted.len()), (9_998, 10_001, 3));
            let last = &inserted[2];
            assert!(
                last.attributes
                    .iter()
                    .any(|a| a.name == "truncated" && a.value == RenderValue::Boolean(true))
            );
            assert!(last.attributes.iter().any(|a| a.name == "labelRanges"
                && matches!(&a.value, RenderValue::Numbers(spans) if spans.len() <= 256)));
        }
    }
}
