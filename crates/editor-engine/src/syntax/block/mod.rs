mod blank_line;
mod block_quote;
mod fenced_code;
mod heading;
mod list;
mod math;
mod paragraph;
mod table;
mod thematic_break;

pub(crate) use heading::safe_content_offset as heading_safe_content_offset;

use std::{
    collections::{BTreeMap, HashMap},
    ops::Range,
    sync::Arc,
};

use super::{CompiledSyntaxProfile, ParseError, SyntaxNode, tree::NodeIdAllocator};
use crate::{position::utf16_len, text::TextBuffer};

pub(crate) struct ParsedBlocks {
    pub(crate) roots: Vec<super::NodeId>,
    pub(crate) nodes: Vec<SyntaxNode>,
}

pub(crate) struct ParsedBlock {
    pub(crate) root: SyntaxNode,
    pub(crate) descendants: Vec<SyntaxNode>,
    pub(crate) consumed_lines: usize,
}

pub(crate) struct ParsedListItem {
    pub(crate) parsed: ParsedBlock,
    pub(crate) next_line_start: u32,
}

/// A standalone block marker allows up to three leading spaces and trailing horizontal space.
fn standalone_marker(line: &str) -> Option<&str> {
    let content = line.trim_start_matches(' ');
    (line.len() - content.len() <= 3).then(|| content.trim_end_matches([' ', '\t']))
}

#[derive(Clone)]
pub(crate) struct SourceLine {
    source: Arc<str>,
    bytes: Range<usize>,
    pub(crate) start_utf16: u32,
    pub(crate) end_utf16: u32,
}

impl SourceLine {
    pub(crate) fn text(&self) -> &str {
        &self.source[self.bytes.clone()]
    }

    pub(crate) fn is_blank(&self) -> bool {
        self.text().bytes().all(|byte| matches!(byte, b' ' | b'\t'))
    }

    pub(crate) fn view_from(&self, relative_byte: usize, start_utf16: u32) -> Option<Self> {
        let byte_start = self.bytes.start.checked_add(relative_byte)?;
        if byte_start > self.bytes.end || !self.source.is_char_boundary(byte_start) {
            return None;
        }
        Some(Self {
            source: Arc::clone(&self.source),
            bytes: byte_start..self.bytes.end,
            start_utf16,
            end_utf16: self.end_utf16,
        })
    }
}

pub(crate) struct BlockIndex {
    tilde_closer: HashMap<usize, usize>,
    fenced_bare_closer_after: Vec<u32>,
    fenced_end_closer_after: Vec<u32>,
    math_dollar_closer_after: Vec<u32>,
    math_bracket_closer_after: Vec<u32>,
}

impl BlockIndex {
    pub(crate) fn new(lines: &[SourceLine]) -> Self {
        let mut fenced_bare_closer_after = vec![u32::MAX; lines.len()];
        let mut fenced_end_closer_after = vec![u32::MAX; lines.len()];
        let mut math_dollar_closer_after = vec![u32::MAX; lines.len()];
        let mut math_bracket_closer_after = vec![u32::MAX; lines.len()];
        let mut next_fenced_bare_closer = u32::MAX;
        let mut next_fenced_end_closer = u32::MAX;
        let mut next_math_dollar_closer = u32::MAX;
        let mut next_math_bracket_closer = u32::MAX;
        let mut tilde_closer = HashMap::new();
        // Candidate widths decrease from left to right. A nearer, equally long
        // or longer closer dominates all shorter candidates behind it.
        let mut tilde_candidates: Vec<(usize, usize)> = Vec::new();
        for index in (0..lines.len()).rev() {
            fenced_bare_closer_after[index] = next_fenced_bare_closer;
            fenced_end_closer_after[index] = next_fenced_end_closer;
            math_dollar_closer_after[index] = next_math_dollar_closer;
            math_bracket_closer_after[index] = next_math_bracket_closer;
            let Some(marker) = standalone_marker(lines[index].text()) else {
                continue;
            };
            let encoded = u32::try_from(index).unwrap_or(u32::MAX);
            if let Some((width, info)) = fenced_code::tilde_marker(marker) {
                let count = tilde_candidates.partition_point(|&(_, candidate)| candidate >= width);
                if count > 0 {
                    tilde_closer.insert(index, tilde_candidates[count - 1].0);
                }
                if info.is_empty() {
                    tilde_candidates.truncate(
                        tilde_candidates.partition_point(|&(_, candidate)| candidate > width),
                    );
                    tilde_candidates.push((index, width));
                }
            } else if marker == "$$" {
                next_math_dollar_closer = encoded;
            } else if marker == "\\]" {
                next_math_bracket_closer = encoded;
            } else {
                match fenced_code::backtick_closer(marker) {
                    Some(fenced_code::Closer::Bare) => next_fenced_bare_closer = encoded,
                    Some(fenced_code::Closer::End) => next_fenced_end_closer = encoded,
                    _ => {}
                }
            }
        }
        Self {
            tilde_closer,
            fenced_bare_closer_after,
            fenced_end_closer_after,
            math_dollar_closer_after,
            math_bracket_closer_after,
        }
    }
}

pub(crate) struct BlockContext<'lines> {
    lines: &'lines [SourceLine],
    index: &'lines BlockIndex,
    pub(crate) _profile: &'lines CompiledSyntaxProfile,
    pub(crate) line_index: usize,
}

impl BlockContext<'_> {
    pub(crate) fn current_line(&self) -> SourceLine {
        self.lines[self.line_index].clone()
    }

    pub(crate) fn line(&self, index: usize) -> Option<SourceLine> {
        self.lines.get(index).cloned()
    }

    fn fenced_closer_index(&self, closer: fenced_code::Closer) -> Option<usize> {
        let closers = match closer {
            fenced_code::Closer::Tilde(_) => {
                return self.index.tilde_closer.get(&self.line_index).copied();
            }
            fenced_code::Closer::Bare => &self.index.fenced_bare_closer_after,
            fenced_code::Closer::End => &self.index.fenced_end_closer_after,
        };
        closers
            .get(self.line_index)
            .copied()
            .filter(|index| *index != u32::MAX)
            .and_then(|index| usize::try_from(index).ok())
    }

    pub(crate) fn math_closer_index(&self, delimiter: &super::MathDelimiter) -> Option<usize> {
        let closers = match delimiter {
            super::MathDelimiter::Dollar => &self.index.math_dollar_closer_after,
            super::MathDelimiter::Bracket => &self.index.math_bracket_closer_after,
        };
        closers
            .get(self.line_index)
            .copied()
            .filter(|index| *index != u32::MAX)
            .and_then(|index| usize::try_from(index).ok())
    }
}

type BlockProbe = for<'lines> fn(&BlockContext<'lines>) -> bool;
type BlockParser =
    for<'lines> fn(&BlockContext<'lines>, &mut NodeIdAllocator) -> Result<ParsedBlock, ParseError>;

struct BlockRule {
    probe: BlockProbe,
    parse: BlockParser,
}

// 一行可以匹配多条块规则，分派时取第一个匹配项。
const BLOCK_RULES: &[BlockRule] = &[
    BlockRule {
        probe: fenced_code::matches,
        parse: fenced_code::parse,
    },
    BlockRule {
        probe: math::matches,
        parse: math::parse,
    },
    BlockRule {
        probe: heading::matches,
        parse: heading::parse,
    },
    // Thematic break 必须排在 list 之前，因为 `* * *` 和 `- - -` 作为分隔线时
    // 优先级高于项目符号 marker。
    BlockRule {
        probe: thematic_break::matches,
        parse: thematic_break::parse,
    },
    BlockRule {
        probe: list::matches,
        parse: list::parse,
    },
    BlockRule {
        probe: block_quote::matches,
        parse: block_quote::parse,
    },
    BlockRule {
        probe: table::matches,
        parse: table::parse,
    },
];

/// 按当前语法配置解析整篇文档的块节点。
pub(crate) fn parse_blocks(
    text: &TextBuffer,
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlocks, ParseError> {
    let lines = source_lines_from_buffer(text)?;
    parse_line_views(&lines, profile, ids)
}

pub(super) fn parse_line_views(
    lines: &[SourceLine],
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlocks, ParseError> {
    let index = BlockIndex::new(lines);
    parse_indexed_line_views(lines, &index, profile, ids)
}

fn parse_indexed_line_views(
    lines: &[SourceLine],
    index: &BlockIndex,
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlocks, ParseError> {
    let mut roots = Vec::new();
    let mut nodes = Vec::new();
    let mut cursor = 0;

    while cursor < lines.len() {
        let (parsed, next_cursor) = parse_next(lines, index, profile, ids, cursor)?;
        if let Some(parsed) = parsed {
            roots.push(parsed.root.id);
            nodes.push(parsed.root);
            nodes.extend(parsed.descendants);
        }
        cursor = next_cursor;
    }

    Ok(ParsedBlocks { roots, nodes })
}

pub(crate) fn parse_next(
    lines: &[SourceLine],
    index: &BlockIndex,
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
    cursor: usize,
) -> Result<(Option<ParsedBlock>, usize), ParseError> {
    let context = BlockContext {
        lines,
        index,
        _profile: profile,
        line_index: cursor,
    };
    let line = context.current_line();
    if line.is_blank() {
        let parsed = blank_line::parse(&context, ids)?;
        return Ok((Some(parsed), cursor + 1));
    }

    let parsed = if let Some(rule) = matching_rule(&context) {
        (rule.parse)(&context, ids)?
    } else {
        // Jot 方言有意把每个普通物理行作为独立 paragraph。只有显式容器规则才
        // 可以消费多个 SourceLine。
        paragraph::parse(&context, 1, ids)?
    };
    if parsed.consumed_lines == 0 {
        return Err(ParseError::InvalidParserState);
    }
    let next_cursor = cursor
        .checked_add(parsed.consumed_lines)
        .ok_or(ParseError::DocumentTooLarge)?;
    if next_cursor > lines.len() {
        return Err(ParseError::InvalidParserState);
    }
    Ok((Some(parsed), next_cursor))
}

fn matching_rule(context: &BlockContext<'_>) -> Option<&'static BlockRule> {
    BLOCK_RULES.iter().find(|rule| (rule.probe)(context))
}

/// 直接从分块文本存储构造 parser 行视图。每行只持有自己的 `Arc<str>`，因此
/// parser 不需要一次性分配文档大小的连续字符串，也不依赖 Rope 的具体类型。
pub(crate) fn source_lines_from_buffer(text: &TextBuffer) -> Result<Vec<SourceLine>, ParseError> {
    let mut lines = Vec::new();
    let mut start_utf16 = 0_u32;
    for raw in text.raw_lines() {
        let line = raw.strip_suffix('\n').unwrap_or(&raw);
        let line_len = utf16_len(line).map_err(|_| ParseError::DocumentTooLarge)?;
        let end_utf16 = start_utf16
            .checked_add(line_len)
            .ok_or(ParseError::DocumentTooLarge)?;
        let source: Arc<str> = Arc::from(line);
        lines.push(SourceLine {
            bytes: 0..source.len(),
            source,
            start_utf16,
            end_utf16,
        });
        start_utf16 = end_utf16
            .checked_add(u32::from(raw.ends_with('\n')))
            .ok_or(ParseError::DocumentTooLarge)?;
    }
    if text.ends_with_lf() {
        lines.push(SourceLine {
            source: Arc::from(""),
            bytes: 0..0,
            start_utf16,
            end_utf16: start_utf16,
        });
    }
    Ok(lines)
}

/// 投影引用中的每一行时，按已确认的层数跳过引用标记。返回 UTF-8 字节数。
pub(crate) fn quote_prefix_len(line: &str, depth: u32) -> Option<usize> {
    let mut end = 0;
    for _ in 0..depth {
        end += block_quote::marker_end(&line[end..])?;
    }
    Some(end)
}

pub(crate) fn fenced_opener_for_closer_in_range(
    text: &TextBuffer,
    range: editor_protocol::TextRange,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<u32>, ParseError> {
    let lines = source_lines_from_buffer(text)?;
    let mut tilde_openers = BTreeMap::<usize, u32>::new();
    let mut earliest = u32::MAX;
    let mut bare_opener = None;
    let mut end_opener = None;
    for line in lines.iter().take_while(|line| line.start_utf16 <= range.to) {
        let intersects = range.from <= line.end_utf16;
        match fenced_code::closing(line.text()) {
            Some(fenced_code::Closer::Tilde(width)) => {
                // An opener matched here cannot reach a later edit. This
                // symmetric marker can itself open a subsequent block.
                while let Some(entry) = tilde_openers.first_entry() {
                    if *entry.key() > width {
                        break;
                    }
                    let opener = entry.remove();
                    if intersects {
                        earliest = earliest.min(opener);
                    }
                }
                tilde_openers.entry(width).or_insert(line.start_utf16);
            }
            Some(fenced_code::Closer::Bare) => {
                if intersects && let Some(opener) = bare_opener {
                    earliest = earliest.min(opener);
                }
                // A bare marker is symmetric. Remember it as a possible
                // opener as well; a prior scan cannot tell whether an earlier
                // enclosing block consumed it, so this deliberately over-reads.
                bare_opener = Some(line.start_utf16);
            }
            Some(fenced_code::Closer::End) => {
                if intersects && let Some(opener) = end_opener {
                    earliest = earliest.min(opener);
                }
                end_opener = None;
            }
            None => {
                if let Some(opener) = fenced_code::opening_with_profile(line.text(), profile) {
                    match opener.closer {
                        fenced_code::Closer::Tilde(width) => {
                            tilde_openers.entry(width).or_insert(line.start_utf16)
                        }
                        fenced_code::Closer::Bare => bare_opener.get_or_insert(line.start_utf16),
                        fenced_code::Closer::End => end_opener.get_or_insert(line.start_utf16),
                    };
                }
            }
        }
    }
    Ok((earliest != u32::MAX).then_some(earliest))
}

pub(crate) fn math_opener_for_closer_in_range(
    text: &TextBuffer,
    range: editor_protocol::TextRange,
) -> Result<Option<u32>, ParseError> {
    let lines = source_lines_from_buffer(text)?;
    let mut dollar_opener = None;
    let mut bracket_opener = None;
    for line in &lines {
        let intersects = line.start_utf16 <= range.to && range.from <= line.end_utf16;
        match math::opening(line.text()) {
            Some(super::MathDelimiter::Dollar) => {
                if let Some(opener) = dollar_opener {
                    if intersects {
                        return Ok(Some(opener));
                    }
                    dollar_opener = None;
                } else {
                    dollar_opener = Some(line.start_utf16);
                }
            }
            Some(super::MathDelimiter::Bracket) if bracket_opener.is_none() => {
                bracket_opener = Some(line.start_utf16);
            }
            _ if math::is_closing(line.text(), &super::MathDelimiter::Bracket) => {
                if intersects && let Some(opener) = bracket_opener {
                    return Ok(Some(opener));
                }
                bracket_opener = None;
            }
            _ => {}
        }
        if line.start_utf16 > range.to {
            break;
        }
    }
    Ok(None)
}

pub(crate) fn closes_fenced_code(line: &str) -> bool {
    fenced_code::is_closing(line)
}

pub(crate) fn fenced_pair_matches(
    opener: &str,
    closer: &str,
    profile: &CompiledSyntaxProfile,
) -> bool {
    fenced_code::pair_matches(opener, closer, profile)
}

pub(crate) fn fenced_code_language(
    line: &str,
    profile: &CompiledSyntaxProfile,
) -> Option<Option<String>> {
    fenced_code::opening_language(line, profile)
}

pub(crate) fn opens_math_block(line: &str) -> Option<super::MathDelimiter> {
    math::opening(line)
}

pub(crate) fn closes_math_block(line: &str, delimiter: &super::MathDelimiter) -> bool {
    math::is_closing(line, delimiter)
}

pub(crate) fn is_math_block_boundary(line: &str) -> bool {
    math::compact_bracket_body(line).is_some()
        || math::opening(line).is_some()
        || math::is_closing(line, &super::MathDelimiter::Bracket)
}

pub(crate) fn parse_table_row(
    source: &str,
    base_utf16: u32,
    header: bool,
    alignments: &[super::TableAlignment],
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
) -> Result<Option<ParsedBlock>, ParseError> {
    let lines = source_lines_with_base(source, base_utf16)?;
    if lines.len() != 1 {
        return Ok(None);
    }
    table::parse_standalone_row(lines[0].clone(), header, alignments, profile, ids)
}

pub(crate) fn parse_table_rows(
    source: &str,
    base_utf16: u32,
    alignments: &[super::TableAlignment],
    profile: &CompiledSyntaxProfile,
    ids: &mut NodeIdAllocator,
) -> Result<Option<ParsedBlocks>, ParseError> {
    let lines = source_lines_with_base(source, base_utf16)?;
    if lines.is_empty() {
        return Ok(None);
    }
    let mut roots = Vec::with_capacity(lines.len());
    let mut nodes = Vec::new();
    for line in lines {
        if line.is_blank() {
            return Ok(None);
        }
        let Some(parsed) = table::parse_standalone_row(line, false, alignments, profile, ids)?
        else {
            return Ok(None);
        };
        roots.push(parsed.root.id);
        nodes.push(parsed.root);
        nodes.extend(parsed.descendants);
    }
    Ok(Some(ParsedBlocks { roots, nodes }))
}

pub(crate) fn parse_list_item_at(
    text: &TextBuffer,
    profile: &CompiledSyntaxProfile,
    start_utf16: u32,
    ids: &mut NodeIdAllocator,
) -> Result<Option<ParsedListItem>, ParseError> {
    // Read only the candidate's explicit hard-break chain from the Rope.
    let (range, source) = text
        .physical_lines_covering(editor_protocol::TextRange::new(start_utf16, start_utf16))
        .map_err(|_| ParseError::InvalidParserState)?;
    if range.from != start_utf16 {
        return Ok(None);
    }
    let mut next_line_start = range.to + u32::from(range.to < text.utf16_len());
    let source: Arc<str> = Arc::from(source);
    let mut lines = vec![SourceLine {
        bytes: 0..source.len(),
        source,
        start_utf16: range.from,
        end_utf16: range.to,
    }];
    let Some(content_indent) = list::marker_content_indent(lines[0].text()) else {
        return Ok(None);
    };
    // Gathering may over-read an empty marker's following line, but the list
    // parser itself decides consumption from the stripped body, not padding.
    while lines
        .last()
        .is_some_and(|line| list::has_explicit_break(line.text()))
        && next_line_start <= text.utf16_len()
        && next_line_start > lines.last().unwrap().end_utf16
    {
        let (range, source) = text
            .physical_lines_covering(editor_protocol::TextRange::new(
                next_line_start,
                next_line_start,
            ))
            .map_err(|_| ParseError::InvalidParserState)?;
        let source: Arc<str> = Arc::from(source);
        let next = SourceLine {
            bytes: 0..source.len(),
            source,
            start_utf16: range.from,
            end_utf16: range.to,
        };
        if list::continuation_view(&next, content_indent)?.is_none() {
            break;
        }
        next_line_start = range.to + u32::from(range.to < text.utf16_len());
        lines.push(next);
    }
    let context = BlockContext {
        lines: &lines,
        index: &BlockIndex::new(&lines),
        _profile: profile,
        line_index: 0,
    };
    let parsed = list::parse(&context, ids)?;
    let end = lines[parsed.consumed_lines - 1].end_utf16;
    Ok(Some(ParsedListItem {
        parsed,
        next_line_start: end + u32::from(end < text.utf16_len()),
    }))
}

/// A trailing hard break can change a neighbouring line's owner even if the
/// edit contains no newline. Inspect only touched physical lines and one
/// predecessor; this is a conservative fast-path guard, not another parser.
pub(crate) fn list_continuation_sensitive(
    text: &TextBuffer,
    range: editor_protocol::TextRange,
) -> bool {
    let Ok((physical, source)) = text.physical_lines_covering(range) else {
        return true;
    };
    if source.split('\n').any(list::has_explicit_break) {
        return true;
    }
    if physical.from == 0 {
        return false;
    }
    text.physical_lines_covering(editor_protocol::TextRange::new(
        physical.from - 1,
        physical.from - 1,
    ))
    .map_or(true, |(_, source)| list::has_explicit_break(&source))
}

pub(crate) fn source_lines_with_base(
    source: &str,
    base_utf16: u32,
) -> Result<Vec<SourceLine>, ParseError> {
    let mut lines = Vec::new();
    let mut start_utf16 = base_utf16;
    let source: Arc<str> = Arc::from(source);
    let mut start_byte = 0;

    for raw in source.split_inclusive('\n') {
        let text = raw.strip_suffix('\n').unwrap_or(raw);
        let text_len = utf16_len(text).map_err(|_| ParseError::DocumentTooLarge)?;
        let end_utf16 = start_utf16
            .checked_add(text_len)
            .ok_or(ParseError::DocumentTooLarge)?;
        lines.push(SourceLine {
            source: Arc::clone(&source),
            bytes: start_byte..start_byte + text.len(),
            start_utf16,
            end_utf16,
        });
        start_byte += raw.len();
        start_utf16 = end_utf16
            .checked_add(u32::from(raw.ends_with('\n')))
            .ok_or(ParseError::DocumentTooLarge)?;
    }

    if source.ends_with('\n') {
        lines.push(SourceLine {
            source: Arc::clone(&source),
            bytes: source.len()..source.len(),
            start_utf16,
            end_utf16: start_utf16,
        });
    }

    Ok(lines)
}
