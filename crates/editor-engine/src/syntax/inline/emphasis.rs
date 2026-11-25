use std::{cmp::Reverse, ops::Range};

use super::{
    InlineInput, ParsedInline,
    atom::{self, Atom, AtomKind},
};
use crate::syntax::{NodeKind, ParseError, SyntaxNode, tree::NodeIdAllocator};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MatchKind {
    Emphasis,
    Strong,
    Strikethrough,
}

#[derive(Clone, Debug)]
struct Delimiter {
    marker: u8,
    bytes: Range<usize>,
    count: usize,
    can_open: bool,
    can_close: bool,
    open_consumed: usize,
    close_consumed: usize,
}

#[derive(Clone, Debug)]
struct DelimiterMatch {
    kind: MatchKind,
    open_bytes: Range<usize>,
    close_bytes: Range<usize>,
}

pub(super) fn parse(
    input: &InlineInput,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    parse_range(input, 0..input.text().len(), ids)
}

fn parse_range(
    input: &InlineInput,
    range: Range<usize>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    let source = input.text();
    let atoms = atom::scan(source, range.clone(), input.table_cell);
    let mut delimiters = scan_delimiters(source, &range, &atoms);
    let mut matches = resolve_delimiters(&mut delimiters);
    matches.sort_unstable_by_key(|matched| {
        (matched.open_bytes.start, Reverse(matched.close_bytes.end))
    });
    build_segment(input, range, &matches, &atoms, ids)
}

fn scan_delimiters(source: &str, range: &Range<usize>, atoms: &[Atom]) -> Vec<Delimiter> {
    let bytes = source.as_bytes();
    let mut delimiters = Vec::new();
    let mut cursor = range.start;
    let mut atom_index = 0;

    while cursor < range.end {
        // atom::scan returns disjoint atoms in source order. Advancing one
        // cursor avoids searching every atom for each ordinary character.
        while atom_index < atoms.len() && atoms[atom_index].bytes.start < cursor {
            atom_index += 1;
        }
        if let Some(atom) = atoms
            .get(atom_index)
            .filter(|atom| atom.bytes.start == cursor)
        {
            cursor = atom.bytes.end;
            atom_index += 1;
            continue;
        }
        if matches!(bytes[cursor], b'*' | b'_' | b'~') && !is_escaped(bytes, cursor) {
            let marker = bytes[cursor];
            let start = cursor;
            while cursor < range.end && bytes.get(cursor) == Some(&marker) {
                cursor += 1;
            }
            let (can_open, can_close) = flanking(source, start, cursor, marker);
            if marker == b'~' && cursor - start != 2 {
                continue;
            }
            delimiters.push(Delimiter {
                marker,
                bytes: start..cursor,
                count: cursor - start,
                can_open,
                can_close,
                open_consumed: 0,
                close_consumed: 0,
            });
        } else {
            let ch = source[cursor..]
                .chars()
                .next()
                .expect("cursor must be on a character boundary");
            cursor += ch.len_utf8();
        }
    }

    delimiters
}

fn resolve_delimiters(delimiters: &mut [Delimiter]) -> Vec<DelimiterMatch> {
    let mut matches = Vec::new();
    // Tildes did not previously participate in delimiter matching. Keep an
    // explicit stack so a long line of unmatched closing `~~` cannot cause a
    // quadratic backward search on otherwise ordinary source text.
    let mut tilde_openers: Vec<usize> = Vec::new();

    for closer_index in 0..delimiters.len() {
        if delimiters[closer_index].marker == b'~' {
            if delimiters[closer_index].can_close
                && let Some(opener_index) = tilde_openers.pop()
            {
                let open_end = delimiters[opener_index].bytes.end;
                let close_start = delimiters[closer_index].bytes.start;
                matches.push(DelimiterMatch {
                    kind: MatchKind::Strikethrough,
                    open_bytes: open_end - 2..open_end,
                    close_bytes: close_start..close_start + 2,
                });
                delimiters[opener_index].open_consumed = 2;
                delimiters[closer_index].close_consumed = 2;
            }
            if delimiters[closer_index].can_open && delimiters[closer_index].close_consumed == 0 {
                tilde_openers.push(closer_index);
            }
            continue;
        }
        while delimiters[closer_index].can_close
            && delimiters[closer_index].close_consumed < delimiters[closer_index].count
        {
            let opener_index = (0..closer_index).rev().find(|&candidate| {
                let opener = &delimiters[candidate];
                opener.can_open
                    && opener.marker == delimiters[closer_index].marker
                    && opener.open_consumed < opener.count
                    && passes_rule_of_three(opener, &delimiters[closer_index])
            });
            let Some(opener_index) = opener_index else {
                break;
            };

            let opener_remaining =
                delimiters[opener_index].count - delimiters[opener_index].open_consumed;
            let closer_remaining =
                delimiters[closer_index].count - delimiters[closer_index].close_consumed;
            // 两侧都有两个 marker 时，strong 消费两个 marker。剩余的单个 marker
            // 会再次处理，并可能形成外层或内层 emphasis 节点；这使 ***x*** 的
            // 结果保持确定。
            let use_count = usize::from(opener_remaining >= 2 && closer_remaining >= 2) + 1;

            let opener = &delimiters[opener_index];
            let open_end = opener.bytes.end - opener.open_consumed;
            let open_start = open_end - use_count;
            let closer = &delimiters[closer_index];
            let close_start = closer.bytes.start + closer.close_consumed;
            let close_end = close_start + use_count;

            matches.push(DelimiterMatch {
                kind: if use_count == 2 {
                    MatchKind::Strong
                } else {
                    MatchKind::Emphasis
                },
                open_bytes: open_start..open_end,
                close_bytes: close_start..close_end,
            });

            delimiters[opener_index].open_consumed += use_count;
            delimiters[closer_index].close_consumed += use_count;
        }
    }

    matches
}

fn passes_rule_of_three(opener: &Delimiter, closer: &Delimiter) -> bool {
    if !(opener.can_close || closer.can_open) {
        return true;
    }
    let sum_is_multiple_of_three = (opener.count + closer.count).is_multiple_of(3);
    let both_are_multiples_of_three =
        opener.count.is_multiple_of(3) && closer.count.is_multiple_of(3);
    !sum_is_multiple_of_three || both_are_multiples_of_three
}

fn flanking(source: &str, start: usize, end: usize, marker: u8) -> (bool, bool) {
    let before = source[..start].chars().next_back();
    let after = source[end..].chars().next();
    let before_whitespace = before.is_none_or(char::is_whitespace);
    let after_whitespace = after.is_none_or(char::is_whitespace);
    let before_punctuation = before.is_some_and(is_punctuation_or_symbol);
    let after_punctuation = after.is_some_and(is_punctuation_or_symbol);

    let left_flanking =
        !after_whitespace && (!after_punctuation || before_whitespace || before_punctuation);
    let right_flanking =
        !before_whitespace && (!before_punctuation || after_whitespace || after_punctuation);

    if marker == b'_' {
        (
            left_flanking && (!right_flanking || before_punctuation),
            right_flanking && (!left_flanking || after_punctuation),
        )
    } else {
        (left_flanking, right_flanking)
    }
}

fn is_punctuation_or_symbol(ch: char) -> bool {
    // CommonMark 在 delimiter 两侧判断中把 Unicode 标点和符号同等处理。`std`
    // 不提供通用类别，因此这里的保守分类精确覆盖字母/数字/空白，并把剩余可见
    // 字符（包括 emoji）视为标点/符号。
    !ch.is_alphanumeric() && !ch.is_whitespace()
}

fn is_escaped(bytes: &[u8], marker_start: usize) -> bool {
    let mut slash_count = 0;
    let mut cursor = marker_start;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        slash_count += 1;
        cursor -= 1;
    }
    slash_count % 2 == 1
}

fn build_segment(
    input: &InlineInput,
    segment: Range<usize>,
    matches: &[DelimiterMatch],
    atoms: &[Atom],
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    let mut roots = Vec::new();
    let mut nodes = Vec::new();
    let mut cursor = segment.start;

    while let Some(matched) = next_outer_match(matches, cursor, segment.end) {
        append_plain(
            input,
            cursor..matched.open_bytes.start,
            ids,
            &mut roots,
            &mut nodes,
            atoms,
        )?;

        let node_id = ids.allocate();
        let children = build_segment(
            input,
            matched.open_bytes.end..matched.close_bytes.start,
            matches,
            atoms,
            ids,
        )?;
        let kind = match matched.kind {
            MatchKind::Emphasis => NodeKind::Emphasis,
            MatchKind::Strong => NodeKind::Strong,
            MatchKind::Strikethrough => NodeKind::Strikethrough,
        };
        roots.push(node_id);
        nodes.push(SyntaxNode {
            id: node_id,
            kind,
            source_range: input.text_range(matched.open_bytes.start..matched.close_bytes.end)?,
            children: children.roots,
            content_version: 0,
        });
        nodes.extend(children.nodes);
        cursor = matched.close_bytes.end;
    }

    append_plain(
        input,
        cursor..segment.end,
        ids,
        &mut roots,
        &mut nodes,
        atoms,
    )?;
    Ok(ParsedInline { roots, nodes })
}

fn next_outer_match(
    matches: &[DelimiterMatch],
    cursor: usize,
    segment_end: usize,
) -> Option<&DelimiterMatch> {
    let first = matches.partition_point(|matched| matched.open_bytes.start < cursor);
    matches[first..]
        .iter()
        .find(|matched| matched.close_bytes.end <= segment_end)
}

fn append_plain(
    input: &InlineInput,
    range: Range<usize>,
    ids: &mut NodeIdAllocator,
    roots: &mut Vec<super::super::NodeId>,
    nodes: &mut Vec<SyntaxNode>,
    atoms: &[Atom],
) -> Result<(), ParseError> {
    let mut cursor = range.start;
    for atom in atoms
        .iter()
        .filter(|atom| atom.bytes.start >= range.start && atom.bytes.end <= range.end)
    {
        append_leaf(
            input,
            cursor..atom.bytes.start,
            NodeKind::Text,
            ids,
            roots,
            nodes,
        )?;
        append_atom(input, atom, ids, roots, nodes)?;
        cursor = atom.bytes.end;
    }
    append_leaf(input, cursor..range.end, NodeKind::Text, ids, roots, nodes)
}

fn append_atom(
    input: &InlineInput,
    atom: &Atom,
    ids: &mut NodeIdAllocator,
    roots: &mut Vec<super::super::NodeId>,
    nodes: &mut Vec<SyntaxNode>,
) -> Result<(), ParseError> {
    let id = ids.allocate();
    let (kind, children, child_nodes) = match &atom.kind {
        AtomKind::Escape { content } => (
            NodeKind::EscapedText {
                content_range: input.text_range(content.clone())?,
            },
            Vec::new(),
            Vec::new(),
        ),
        AtomKind::Code { content } => (
            NodeKind::InlineCode {
                content_range: input.text_range(content.clone())?,
            },
            Vec::new(),
            Vec::new(),
        ),
        AtomKind::Math { delimiter, content } => (
            NodeKind::InlineMath {
                delimiter: delimiter.clone(),
                content_range: input.text_range(content.clone())?,
            },
            Vec::new(),
            Vec::new(),
        ),
        AtomKind::Link {
            label,
            destination,
            title,
            image,
            literal_label,
        } => {
            let parsed = if *literal_label {
                // An autolink's label is also its address. Markdown syntax
                // inside it is literal, unlike an ordinary link's label.
                let mut roots = Vec::new();
                let mut nodes = Vec::new();
                append_leaf(
                    input,
                    label.clone(),
                    NodeKind::Text,
                    ids,
                    &mut roots,
                    &mut nodes,
                )?;
                ParsedInline { roots, nodes }
            } else {
                parse_range(input, label.clone(), ids)?
            };
            let kind = if *image {
                NodeKind::Image {
                    destination: destination.clone(),
                    title: title.clone(),
                    alt: atom::unescape_punctuation(&input.text()[label.clone()]),
                }
            } else {
                NodeKind::Link {
                    destination: destination.clone(),
                    title: title.clone(),
                }
            };
            (kind, parsed.roots, parsed.nodes)
        }
    };
    roots.push(id);
    nodes.push(SyntaxNode {
        id,
        kind,
        source_range: input.text_range(atom.bytes.clone())?,
        children,
        content_version: 0,
    });
    nodes.extend(child_nodes);
    Ok(())
}

fn append_leaf(
    input: &InlineInput,
    range: Range<usize>,
    kind: NodeKind,
    ids: &mut NodeIdAllocator,
    roots: &mut Vec<super::super::NodeId>,
    nodes: &mut Vec<SyntaxNode>,
) -> Result<(), ParseError> {
    if range.is_empty() {
        return Ok(());
    }
    let id = ids.allocate();
    roots.push(id);
    nodes.push(SyntaxNode {
        id,
        kind,
        source_range: input.text_range(range)?,
        children: Vec::new(),
        content_version: 0,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use editor_protocol::TextRange;

    use super::*;

    fn parsed(source: &str) -> ParsedInline {
        let input = InlineInput::from_lines(&[super::super::InlineLine {
            text: source,
            start_utf16: 0,
            end_utf16: crate::position::utf16_len(source).unwrap(),
        }])
        .unwrap();
        parse(&input, &mut NodeIdAllocator::new()).unwrap()
    }

    fn root(parsed: &ParsedInline, index: usize) -> &SyntaxNode {
        let id = parsed.roots[index];
        parsed.nodes.iter().find(|node| node.id == id).unwrap()
    }

    fn child<'a>(parsed: &'a ParsedInline, node: &SyntaxNode, index: usize) -> &'a SyntaxNode {
        let id = node.children[index];
        parsed
            .nodes
            .iter()
            .find(|candidate| candidate.id == id)
            .unwrap()
    }

    #[test]
    fn parses_single_and_double_delimiters() {
        let emphasis = parsed("*italic*");
        assert_eq!(root(&emphasis, 0).kind, NodeKind::Emphasis);
        assert_eq!(child(&emphasis, root(&emphasis, 0), 0).kind, NodeKind::Text);

        let strong = parsed("__bold__");
        assert_eq!(root(&strong, 0).kind, NodeKind::Strong);
    }

    #[test]
    fn strong_consumes_two_then_remaining_markers_form_emphasis() {
        let parsed = parsed("***both***");
        let outer = root(&parsed, 0);
        assert_eq!(outer.kind, NodeKind::Emphasis);
        assert_eq!(child(&parsed, outer, 0).kind, NodeKind::Strong);
    }

    #[test]
    fn inner_emphasis_closes_before_outer_strong() {
        let parsed = parsed("**bold *italic***");
        let outer = root(&parsed, 0);
        assert_eq!(outer.kind, NodeKind::Strong);
        assert_eq!(child(&parsed, outer, 1).kind, NodeKind::Emphasis);
    }

    #[test]
    fn asymmetric_triple_runs_keep_the_unmatched_marker_as_text() {
        let closing_extra = parsed("**bold***");
        assert_eq!(root(&closing_extra, 0).kind, NodeKind::Strong);
        assert_eq!(root(&closing_extra, 1).kind, NodeKind::Text);

        let opening_extra = parsed("***bold**");
        assert_eq!(root(&opening_extra, 0).kind, NodeKind::Text);
        assert_eq!(root(&opening_extra, 1).kind, NodeKind::Strong);
    }

    #[test]
    fn triple_runs_can_wrap_strong_inside_emphasis_from_either_side() {
        let first = parsed("***bold** tail*");
        let first_outer = root(&first, 0);
        assert_eq!(first_outer.kind, NodeKind::Emphasis);
        assert_eq!(child(&first, first_outer, 0).kind, NodeKind::Strong);

        let second = parsed("*head **bold***");
        let second_outer = root(&second, 0);
        assert_eq!(second_outer.kind, NodeKind::Emphasis);
        assert_eq!(child(&second, second_outer, 1).kind, NodeKind::Strong);
    }

    #[test]
    fn underscore_does_not_create_intraword_emphasis() {
        let parsed = parsed("foo_bar_baz");
        assert_eq!(parsed.roots.len(), 1);
        assert_eq!(root(&parsed, 0).kind, NodeKind::Text);
    }

    #[test]
    fn whitespace_and_escape_disable_delimiters() {
        assert_eq!(root(&parsed("* no*"), 0).kind, NodeKind::Text);
        assert_eq!(root(&parsed("\\*no emphasis*"), 0).kind, NodeKind::Text);
    }

    #[test]
    fn source_ranges_use_utf16_offsets() {
        let parsed = parsed("😀 **好**");
        assert_eq!(root(&parsed, 1).kind, NodeKind::Strong);
        assert_eq!(root(&parsed, 1).source_range, TextRange::new(3, 8));
    }
}
