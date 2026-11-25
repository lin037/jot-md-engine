use std::{collections::HashMap, ops::Range};

use crate::syntax::MathDelimiter;

#[derive(Clone, Debug)]
pub(super) enum AtomKind {
    Escape {
        content: Range<usize>,
    },
    Code {
        content: Range<usize>,
    },
    Math {
        delimiter: MathDelimiter,
        content: Range<usize>,
    },
    Link {
        label: Range<usize>,
        destination: String,
        title: Option<String>,
        image: bool,
        literal_label: bool,
    },
}

#[derive(Clone, Debug)]
pub(super) struct Atom {
    pub(super) bytes: Range<usize>,
    pub(super) kind: AtomKind,
}

pub(super) fn scan(source: &str, range: Range<usize>, table_cell: bool) -> Vec<Atom> {
    let mut atoms = Vec::new();
    // Memoize the actual label scanner's nested matches. Repeatedly searching
    // the suffix for every unmatched `[` makes one long line quadratic.
    let mut brackets = HashMap::new();
    let has_closing_bracket = source.as_bytes()[range.clone()].contains(&b']');
    let has_closing_parenthesis = source.as_bytes()[range.clone()].contains(&b')');
    let mut cursor = range.start;
    while cursor < range.end {
        let atom = escape_at(source, cursor, range.end, table_cell)
            .or_else(|| code_at(source, cursor, range.end))
            .or_else(|| math_at(source, cursor, range.end))
            .or_else(|| {
                link_at(
                    source,
                    cursor,
                    range.end,
                    &mut brackets,
                    has_closing_bracket && has_closing_parenthesis,
                )
            })
            .or_else(|| autolink_at(source, cursor, range.end));
        if let Some(atom) = atom {
            cursor = atom.bytes.end;
            atoms.push(atom);
        } else {
            cursor += source[cursor..]
                .chars()
                .next()
                .expect("inline cursor is a character boundary")
                .len_utf8();
        }
    }
    atoms
}

fn escape_at(source: &str, start: usize, end: usize, table_cell: bool) -> Option<Atom> {
    let bytes = source.as_bytes();
    if start + 1 >= end
        || bytes[start] != b'\\'
        || !(bytes[start + 1] == b'~' || table_cell && matches!(bytes[start + 1], b'|' | b'\\'))
        || (!table_cell && escaped(bytes, start))
    {
        return None;
    }
    Some(Atom {
        bytes: start..start + 2,
        kind: AtomKind::Escape {
            content: start + 1..start + 2,
        },
    })
}

fn code_at(source: &str, start: usize, end: usize) -> Option<Atom> {
    let bytes = source.as_bytes();
    if bytes.get(start) != Some(&b'`') || escaped(bytes, start) {
        return None;
    }
    let mut open_end = start;
    while open_end < end && bytes[open_end] == b'`' {
        open_end += 1;
    }
    let count = open_end - start;
    let mut search = open_end;
    while search < end {
        if bytes[search] != b'`' {
            search += 1;
            continue;
        }
        let close_start = search;
        while search < end && bytes[search] == b'`' {
            search += 1;
        }
        if search - close_start == count {
            let content = trim_code_content(source, open_end..close_start);
            return Some(Atom {
                bytes: start..search,
                kind: AtomKind::Code { content },
            });
        }
    }
    None
}

fn trim_code_content(source: &str, range: Range<usize>) -> Range<usize> {
    let content = &source[range.clone()];
    if content.starts_with(' ')
        && content.ends_with(' ')
        && content.bytes().any(|byte| byte != b' ')
    {
        range.start + 1..range.end - 1
    } else {
        range
    }
}

fn math_at(source: &str, start: usize, end: usize) -> Option<Atom> {
    let bytes = source.as_bytes();
    if bytes.get(start) == Some(&b'$') && !escaped(bytes, start) {
        let close =
            ((start + 1)..end).find(|&index| bytes[index] == b'$' && !escaped(bytes, index))?;
        let content = trim_ascii(source, start + 1..close);
        if content.is_empty() {
            return None;
        }
        return Some(Atom {
            bytes: start..close + 1,
            kind: AtomKind::Math {
                delimiter: MathDelimiter::Dollar,
                content,
            },
        });
    }
    if source[start..end].starts_with("\\(") && !escaped(bytes, start) {
        let relative = source[start + 2..end].find("\\)")?;
        let close = start + 2 + relative;
        let content = trim_ascii(source, start + 2..close);
        if content.is_empty() {
            return None;
        }
        return Some(Atom {
            bytes: start..close + 2,
            kind: AtomKind::Math {
                delimiter: MathDelimiter::Bracket,
                content,
            },
        });
    }
    None
}

fn link_at(
    source: &str,
    start: usize,
    end: usize,
    brackets: &mut HashMap<usize, Option<usize>>,
    has_link_closers: bool,
) -> Option<Atom> {
    let image = source[start..end].starts_with("![");
    let label_open = start + usize::from(image);
    if !has_link_closers
        || source.as_bytes().get(label_open) != Some(&b'[')
        || escaped(source.as_bytes(), start)
    {
        return None;
    }
    let label_close = matching_bracket_cached(source, label_open, end, brackets)?;
    if source.as_bytes().get(label_close + 1) != Some(&b'(') {
        return None;
    }
    let destination_close = matching_destination(source, label_close + 2, end)?;
    let inside = source[label_close + 2..destination_close].trim();
    let (destination, title) = parse_destination(inside)?;
    Some(Atom {
        bytes: start..destination_close + 1,
        kind: AtomKind::Link {
            label: label_open + 1..label_close,
            destination,
            title,
            image,
            literal_label: false,
        },
    })
}

fn autolink_at(source: &str, start: usize, end: usize) -> Option<Atom> {
    let bytes = source.as_bytes();
    if bytes.get(start) != Some(&b'<') || escaped(bytes, start) {
        return None;
    }
    let mut close = start + 1;
    while close < end && !matches!(bytes[close], b'<' | b'>' | 0..=b' ' | 127) {
        close += 1;
    }
    if bytes.get(close) != Some(&b'>') || close >= end {
        return None;
    }
    let label = &source[start + 1..close];
    let destination = if let Some((scheme, _)) = label.split_once(':') {
        if !(2..=32).contains(&scheme.len())
            || !scheme.as_bytes()[0].is_ascii_alphabetic()
            || !scheme
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
        {
            return None;
        }
        label.to_owned()
    } else {
        let (local, domain) = label.split_once('@')?;
        if local.is_empty()
            || !local
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&b))
            || domain.is_empty()
            || !domain.split('.').all(|part| {
                !part.is_empty()
                    && part.len() <= 63
                    && !part.starts_with('-')
                    && !part.ends_with('-')
                    && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return None;
        }
        format!("mailto:{label}")
    };
    Some(Atom {
        bytes: start..close + 1,
        kind: AtomKind::Link {
            label: start + 1..close,
            destination,
            title: None,
            image: false,
            literal_label: true,
        },
    })
}

fn matching_bracket_cached(
    source: &str,
    open: usize,
    end: usize,
    cache: &mut HashMap<usize, Option<usize>>,
) -> Option<usize> {
    if let Some(result) = cache.get(&open) {
        return *result;
    }
    let bytes = source.as_bytes();
    let mut openings = Vec::new();
    let mut index = open;
    while index < end {
        if bytes[index] == b'`' && !escaped(bytes, index) {
            if let Some(code) = code_at(source, index, end) {
                index = code.bytes.end;
                continue;
            }
            while index < end && bytes[index] == b'`' {
                index += 1;
            }
            continue;
        }
        if matches!(bytes[index], b'[' | b']') && !escaped(bytes, index) {
            if bytes[index] == b'[' {
                openings.push(index);
            } else if let Some(matched) = openings.pop() {
                cache.insert(matched, Some(index));
                if matched == open {
                    return Some(index);
                }
            }
        }
        index += 1;
    }
    for unmatched in openings {
        cache.insert(unmatched, None);
    }
    None
}

#[cfg(test)]
fn matching_bracket(source: &str, open: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = open;
    while index < end {
        if bytes[index] == b'`' && !escaped(bytes, index) {
            if let Some(code) = code_at(source, index, end) {
                index = code.bytes.end;
                continue;
            }
            while index < end && bytes[index] == b'`' {
                index += 1;
            }
            continue;
        }
        if !matches!(bytes[index], b'[' | b']') || escaped(bytes, index) {
            index += 1;
            continue;
        }
        match bytes[index] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn matching_destination(source: &str, start: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut angle = false;
    let mut quote = None;
    let mut seen_nonspace = false;
    for index in start..end {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == delimiter && !escaped(bytes, index) {
                quote = None;
            }
            continue;
        }
        if angle {
            if byte == b'>' && !escaped(bytes, index) {
                angle = false;
            }
            continue;
        }
        if matches!(byte, b'<' | b'(' | b')' | b'\'' | b'"') && escaped(bytes, index) {
            continue;
        }
        if !seen_nonspace && byte == b'<' {
            angle = true;
            seen_nonspace = true;
            continue;
        }
        if matches!(byte, b'\'' | b'"') && index > start && bytes[index - 1].is_ascii_whitespace() {
            quote = Some(byte);
            continue;
        }
        if !byte.is_ascii_whitespace() {
            seen_nonspace = true;
        }
        match byte {
            b'(' => depth += 1,
            b')' if depth == 0 => return Some(index),
            b')' => depth -= 1,
            _ => {}
        }
    }
    None
}

fn parse_destination(inside: &str) -> Option<(String, Option<String>)> {
    if inside.is_empty() {
        return Some((String::new(), None));
    }
    let (destination, rest) = if let Some(after) = inside.strip_prefix('<') {
        let close = after
            .bytes()
            .enumerate()
            .find(|(index, byte)| *byte == b'>' && !escaped(after.as_bytes(), *index))?
            .0;
        (&after[..close], after[close + 1..].trim())
    } else {
        let split = inside.find(char::is_whitespace).unwrap_or(inside.len());
        (&inside[..split], inside[split..].trim())
    };
    if !inside.starts_with('<') && destination.chars().any(char::is_whitespace) {
        return None;
    }
    let title = if rest.is_empty() {
        None
    } else {
        let first = rest.chars().next()?;
        let last = rest.chars().next_back()?;
        if !matches!((first, last), ('"', '"') | ('\'', '\'') | ('(', ')')) {
            return None;
        }
        Some(unescape_punctuation(
            &rest[first.len_utf8()..rest.len() - last.len_utf8()],
        ))
    };
    Some((unescape_punctuation(destination), title))
}

pub(super) fn unescape_punctuation(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
            result.push(chars.next().expect("peeked punctuation"));
        } else {
            result.push(ch);
        }
    }
    result
}

fn trim_ascii(source: &str, mut range: Range<usize>) -> Range<usize> {
    while range.start < range.end && matches!(source.as_bytes()[range.start], b' ' | b'\t') {
        range.start += 1;
    }
    while range.end > range.start && matches!(source.as_bytes()[range.end - 1], b' ' | b'\t') {
        range.end -= 1;
    }
    range
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
    fn trims_formula_inner_spacing_and_protects_code_first() {
        let source = "`$x$` $ y $ \\( z \\)";
        let atoms = scan(source, 0..source.len(), false);
        assert!(matches!(atoms[0].kind, AtomKind::Code { .. }));
        assert!(matches!(atoms[1].kind, AtomKind::Math { .. }));
        assert!(matches!(atoms[2].kind, AtomKind::Math { .. }));
    }

    #[test]
    fn indexed_brackets_match_the_original_scanner_across_mixed_input() {
        let alphabet = ["[", "]", "`", "\\", "a", "(", ")", "!", "中", "😀"];
        let mut state = 0x51ea_2026_u64;
        for _ in 0..12_000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let length = (state as usize % 65) + 1;
            let mut source = String::new();
            for _ in 0..length {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                source.push_str(alphabet[state as usize % alphabet.len()]);
            }
            let mut pairs = HashMap::new();
            let mut cursor = 0;
            while cursor < source.len() {
                if source.as_bytes()[cursor] == b'[' && !escaped(source.as_bytes(), cursor) {
                    assert_eq!(
                        matching_bracket_cached(&source, cursor, source.len(), &mut pairs),
                        matching_bracket(&source, cursor, source.len()),
                        "{source:?} at {cursor}"
                    );
                }
                cursor += source[cursor..].chars().next().unwrap().len_utf8();
            }
        }
    }

    #[test]
    fn unmatched_brackets_in_a_single_large_line_stay_plain_text() {
        for source in [
            "[".repeat(1_000_000),
            "[".repeat(100_000) + "]",
            "[".repeat(100_000) + "`]",
            "[".repeat(100_000) + "`]x()",
            "[a](".repeat(250_000),
        ] {
            assert!(scan(&source, 0..source.len(), false).is_empty());
        }
    }
}
