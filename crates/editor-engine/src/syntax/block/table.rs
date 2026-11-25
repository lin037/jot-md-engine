use std::{collections::HashMap, ops::Range};

use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock, SourceLine};
use crate::{
    position::utf16_len,
    syntax::{
        CompiledSyntaxProfile, NodeKind, ParseError, SyntaxNode, TableAlignment, inline,
        tree::NodeIdAllocator,
    },
};

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    analyze(context).is_some()
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let (header_cells, alignments) = analyze(context).ok_or(ParseError::InvalidParserState)?;
    let first = context.current_line();
    let table_id = ids.allocate();
    let mut row_ids = Vec::new();
    let mut descendants = Vec::new();
    append_row(
        first.clone(),
        &header_cells,
        true,
        &alignments,
        ids,
        &mut row_ids,
        &mut descendants,
    )?;

    // 对齐分隔行属于 Table 语法，不是可见数据行。
    let mut cursor = context.line_index + 2;
    while let Some(line) = context.line(cursor) {
        if line.is_blank() {
            break;
        }
        let Some(cells) = body_cells(line.text(), alignments.len(), context._profile) else {
            break;
        };
        append_row(
            line,
            &cells,
            false,
            &alignments,
            ids,
            &mut row_ids,
            &mut descendants,
        )?;
        cursor += 1;
    }

    let end = context
        .line(cursor - 1)
        .ok_or(ParseError::InvalidParserState)?
        .end_utf16;
    Ok(ParsedBlock {
        root: SyntaxNode {
            id: table_id,
            kind: NodeKind::Table { alignments },
            source_range: TextRange::new(first.start_utf16, end),
            children: row_ids,
            content_version: 0,
        },
        descendants,
        consumed_lines: cursor - context.line_index,
    })
}

fn analyze(context: &BlockContext<'_>) -> Option<(Vec<Range<usize>>, Vec<TableAlignment>)> {
    let header = split_cells(context.current_line().text())?;
    let delimiter_line = context.line(context.line_index + 1)?;
    let delimiter_cells = split_cells(delimiter_line.text())?;
    if header.is_empty() || header.len() != delimiter_cells.len() {
        return None;
    }
    let alignments: Option<Vec<_>> = delimiter_cells
        .iter()
        .map(|range| delimiter_alignment(&delimiter_line.text()[range.clone()]))
        .collect();
    Some((header, alignments?))
}

#[allow(clippy::too_many_arguments)]
fn append_row(
    line: SourceLine,
    cells: &[Range<usize>],
    header: bool,
    alignments: &[TableAlignment],
    ids: &mut NodeIdAllocator,
    row_ids: &mut Vec<super::super::NodeId>,
    descendants: &mut Vec<SyntaxNode>,
) -> Result<(), ParseError> {
    let row_id = ids.allocate();
    let mut cell_ids = Vec::with_capacity(cells.len());
    let mut cell_nodes = Vec::new();
    for (index, bytes) in cells.iter().enumerate() {
        let prefix = &line.text()[..bytes.start];
        let content = &line.text()[bytes.clone()];
        let from = line
            .start_utf16
            .checked_add(utf16_len(prefix).map_err(|_| ParseError::DocumentTooLarge)?)
            .ok_or(ParseError::DocumentTooLarge)?;
        let to = from
            .checked_add(utf16_len(content).map_err(|_| ParseError::DocumentTooLarge)?)
            .ok_or(ParseError::DocumentTooLarge)?;
        let inline = inline::parse_table_cell(content, from, ids)?;
        let cell_id = ids.allocate();
        cell_ids.push(cell_id);
        cell_nodes.push(SyntaxNode {
            id: cell_id,
            kind: NodeKind::TableCell {
                alignment: alignments[index].clone(),
            },
            source_range: TextRange::new(from, to),
            children: inline.roots,
            content_version: 0,
        });
        cell_nodes.extend(inline.nodes);
    }
    row_ids.push(row_id);
    descendants.push(SyntaxNode {
        id: row_id,
        kind: NodeKind::TableRow { header },
        source_range: TextRange::new(line.start_utf16, line.end_utf16),
        children: cell_ids,
        content_version: 0,
    });
    descendants.extend(cell_nodes);
    Ok(())
}

pub(crate) fn parse_standalone_row(
    line: SourceLine,
    header: bool,
    alignments: &[TableAlignment],
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
) -> Result<Option<ParsedBlock>, ParseError> {
    let cells = if header {
        split_cells(line.text()).filter(|cells| cells.len() == alignments.len())
    } else {
        body_cells(line.text(), alignments.len(), profile)
    };
    let Some(cells) = cells else {
        return Ok(None);
    };
    let mut row_ids = Vec::new();
    let mut nodes = Vec::new();
    append_row(
        line,
        &cells,
        header,
        alignments,
        ids,
        &mut row_ids,
        &mut nodes,
    )?;
    let row_id = row_ids[0];
    let root_index = nodes
        .iter()
        .position(|node| node.id == row_id)
        .ok_or(ParseError::InvalidParserState)?;
    let root = nodes.remove(root_index);
    Ok(Some(ParsedBlock {
        root,
        descendants: nodes,
        consumed_lines: 1,
    }))
}

// Extra columns must be added to both header and delimiter. Keep an
// oversized body draft as visible source, including every character.
fn body_cells(
    line: &str,
    columns: usize,
    profile: &CompiledSyntaxProfile,
) -> Option<Vec<Range<usize>>> {
    // An opener is a block boundary even if its language token contains a
    // pipe. Its own rule decides whether it actually has a matching closer.
    if super::fenced_code::opening_with_profile(line, profile).is_some()
        || super::math::compact_bracket_body(line).is_some()
    {
        return None;
    }
    split_cells(line).filter(|cells| cells.len() <= columns)
}

fn split_cells(line: &str) -> Option<Vec<Range<usize>>> {
    let bytes = line.as_bytes();
    let mut pipes = Vec::new();
    let mut tick_ends = HashMap::new();
    let mut code_spans = HashMap::new();
    let mut end = bytes.len();
    while let Some(start) = bytes[..end].iter().rposition(|&byte| byte == b'`') {
        let mut run_start = start;
        while run_start > 0 && bytes[run_start - 1] == b'`' {
            run_start -= 1;
        }
        if let Some(close) = tick_ends.insert(start + 1 - run_start, start + 1) {
            code_spans.insert(run_start, close);
        }
        end = run_start;
    }
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'`'
            && let Some(&end) = code_spans.get(&cursor).filter(|_| !escaped(bytes, cursor))
        {
            cursor = end;
            continue;
        }
        if bytes[cursor] == b'|' && !escaped(bytes, cursor) {
            pipes.push(cursor);
        }
        cursor += 1;
    }
    let bounds = trimmed_range(line, 0..line.len());
    // One opening pipe is a draft, not a separator between cells or a pair
    // of outer pipes. Keep the physical line outside the table while typing.
    if pipes.is_empty() || pipes.as_slice() == [bounds.start] {
        return None;
    }

    let mut cells = Vec::new();
    let mut start = 0;
    for pipe in &pipes {
        cells.push(trimmed_range(line, start..*pipe));
        start = pipe + 1;
    }
    cells.push(trimmed_range(line, start..line.len()));
    if pipes.first() == Some(&bounds.start) {
        cells.remove(0);
    }
    if pipes.last() == Some(&(bounds.end - 1)) && (pipes.len() > 1 || bounds.end == line.len()) {
        cells.pop();
    }
    Some(cells)
}

fn trimmed_range(line: &str, mut range: Range<usize>) -> Range<usize> {
    while range.start < range.end && matches!(line.as_bytes()[range.start], b' ' | b'\t') {
        range.start += 1;
    }
    while range.end > range.start && matches!(line.as_bytes()[range.end - 1], b' ' | b'\t') {
        range.end -= 1;
    }
    range
}

fn delimiter_alignment(cell: &str) -> Option<TableAlignment> {
    let bytes = cell.as_bytes();
    let left = bytes.first() == Some(&b':');
    let right = bytes.last() == Some(&b':');
    let from = usize::from(left);
    let to = cell.len().checked_sub(usize::from(right))?;
    if from > to {
        return None;
    }
    let dashes = &cell[from..to];
    if dashes.len() < 3 || !dashes.bytes().all(|byte| byte == b'-') {
        return None;
    }
    Some(match (left, right) {
        (true, true) => TableAlignment::Center,
        (true, false) => TableAlignment::Left,
        (false, true) => TableAlignment::Right,
        (false, false) => TableAlignment::None,
    })
}

fn escaped(bytes: &[u8], at: usize) -> bool {
    let mut cursor = at;
    let mut slashes = 0;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        cursor -= 1;
        slashes += 1;
    }
    slashes % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_pipe_and_understands_alignment() {
        assert!(split_cells("a b").is_none());
        assert_eq!(split_cells("| a | b |").unwrap().len(), 2);
        assert_eq!(delimiter_alignment(":---:"), Some(TableAlignment::Center));
        assert_eq!(delimiter_alignment("--"), None);
    }

    #[test]
    fn escaped_and_code_span_pipes_do_not_split_cells() {
        assert_eq!(split_cells(r"a \| b | c").unwrap().len(), 2);
        assert_eq!(split_cells("`a|b` | c").unwrap().len(), 2);
    }

    #[test]
    fn an_opening_pipe_alone_never_owns_the_physical_line() {
        for draft in ["|", " | ", "| 内容", r"| a\|b", "| `a|b`"] {
            assert!(split_cells(draft).is_none(), "{draft:?}");
        }
        for row in ["|内容|", "||", "| |", "| A | B", "A | B", "A |"] {
            assert!(!split_cells(row).unwrap().is_empty(), "{row:?}");
        }
    }

    #[test]
    fn outer_pipes_in_a_full_row_allow_surrounding_space() {
        assert_eq!(split_cells("  |x|y| \t").unwrap().len(), 2);
        assert_eq!(split_cells("x | ").unwrap().len(), 2);
    }
}
