use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock, standalone_marker};
use crate::syntax::{NodeKind, ParseError, SyntaxNode, tree::NodeIdAllocator};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Closer {
    Bare,
    End,
    Tilde(usize),
}

pub(super) struct Opening {
    pub(super) language: Option<String>,
    pub(super) closer: Closer,
}

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    opening_with_profile(context.current_line().text(), context._profile)
        .is_some_and(|opener| context.fenced_closer_index(opener.closer).is_some())
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let first = context.current_line();
    let opening = opening_with_profile(first.text(), context._profile)
        .ok_or(ParseError::InvalidParserState)?;
    let closing_index = context
        .fenced_closer_index(opening.closer)
        .ok_or(ParseError::InvalidParserState)?;

    let content_start = context
        .line(context.line_index + 1)
        .map_or(first.end_utf16, |line| line.start_utf16);
    let last_index = closing_index;
    let last = context
        .line(last_index)
        .ok_or(ParseError::InvalidParserState)?;
    let content_end = match closing_index {
        index if index > context.line_index + 1 => {
            context
                .line(index - 1)
                .ok_or(ParseError::InvalidParserState)?
                .end_utf16
        }
        _ => content_start,
    };
    let end = last.end_utf16;
    let consumed_lines = last_index - context.line_index + 1;

    Ok(ParsedBlock {
        root: SyntaxNode {
            id: ids.allocate(),
            kind: NodeKind::FencedCode {
                language: opening.language,
                opening_range: TextRange::new(first.start_utf16, first.end_utf16),
                content_range: TextRange::new(content_start, content_end),
                closing_range: Some(TextRange::new(last.start_utf16, last.end_utf16)),
                closed: true,
            },
            source_range: TextRange::new(first.start_utf16, end),
            children: Vec::new(),
            content_version: 0,
        },
        descendants: Vec::new(),
        consumed_lines,
    })
}

#[cfg(test)]
fn opening(line: &str) -> Option<Opening> {
    opening_with_unspaced_language(line, false)
}

pub(super) fn opening_with_profile(
    line: &str,
    profile: &crate::syntax::CompiledSyntaxProfile,
) -> Option<Opening> {
    opening_with_unspaced_language(line, profile.unspaced_fence_language())
}

fn opening_with_unspaced_language(line: &str, allow_unspaced: bool) -> Option<Opening> {
    let marker = standalone_marker(line)?;
    if let Some((width, info)) = tilde_marker(marker) {
        return Some(Opening {
            language: info.split_whitespace().next().map(str::to_owned),
            closer: Closer::Tilde(width),
        });
    }
    let suffix = marker.strip_prefix("```")?;
    if suffix.is_empty() {
        return Some(Opening {
            language: None,
            closer: Closer::Bare,
        });
    }
    if suffix.contains('`') {
        return None;
    }
    if !suffix.starts_with(' ') {
        // The opt-in compatibility mode accepts only a single language token.
        // Explicit begin/end pairs still require the Jot space separator.
        if allow_unspaced
            && !suffix.bytes().any(|byte| byte.is_ascii_whitespace())
            && !matches!(suffix, "begin" | "end")
        {
            return Some(Opening {
                language: Some(suffix.to_owned()),
                closer: Closer::Bare,
            });
        }
        return None;
    }
    let tokens: Vec<_> = suffix.split_ascii_whitespace().collect();
    match tokens.as_slice() {
        [] => Some(Opening {
            language: None,
            closer: Closer::Bare,
        }),
        ["begin"] => Some(Opening {
            language: None,
            closer: Closer::End,
        }),
        [language] if *language != "end" => Some(Opening {
            language: Some((*language).to_owned()),
            closer: Closer::Bare,
        }),
        [language, "begin"] if !matches!(*language, "begin" | "end") => Some(Opening {
            language: Some((*language).to_owned()),
            closer: Closer::End,
        }),
        _ => None,
    }
}

pub(crate) fn opening_language(
    line: &str,
    profile: &crate::syntax::CompiledSyntaxProfile,
) -> Option<Option<String>> {
    opening_with_profile(line, profile).map(|opening| opening.language)
}

pub(crate) fn is_closing(line: &str) -> bool {
    closing(line).is_some()
}

pub(super) fn closing(line: &str) -> Option<Closer> {
    let marker = standalone_marker(line)?;
    if let Some((width, "")) = tilde_marker(marker) {
        return Some(Closer::Tilde(width));
    }
    backtick_closer(marker)
}

pub(super) fn backtick_closer(marker: &str) -> Option<Closer> {
    if marker == "```" {
        return Some(Closer::Bare);
    }
    let suffix = marker.strip_prefix("```")?;
    if !suffix.starts_with(' ') || suffix.contains('`') {
        return None;
    }
    let mut tokens = suffix.split_ascii_whitespace();
    let is_end = match (tokens.next(), tokens.next(), tokens.next()) {
        (Some("end"), None, None) => true,
        (Some(label), Some("end"), None) if !matches!(label, "begin" | "end") => true,
        _ => false,
    };
    if is_end {
        return Some(Closer::End);
    }
    None
}

pub(crate) fn pair_matches(
    opener: &str,
    closer: &str,
    profile: &crate::syntax::CompiledSyntaxProfile,
) -> bool {
    let Some(opening) = opening_with_profile(opener, profile) else {
        return false;
    };
    match (opening.closer, closing(closer)) {
        (Closer::Tilde(minimum), Some(Closer::Tilde(width))) => width >= minimum,
        (expected, actual) => actual == Some(expected),
    }
}

pub(super) fn tilde_marker(marker: &str) -> Option<(usize, &str)> {
    if !marker.starts_with("~~~") {
        return None;
    }
    let width = marker.bytes().take_while(|&byte| byte == b'~').count();
    Some((width, &marker[width..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_require_space_before_metadata_and_an_exclusive_line() {
        let profile = crate::syntax::CompiledSyntaxProfile::compile(Default::default());
        assert_eq!(
            opening("``` rust begin").unwrap().language.as_deref(),
            Some("rust")
        );
        assert!(opening("```rustbegin").is_none());
        assert!(opening("```ts").is_none());
        assert!(opening("```\tts").is_none());
        assert!(opening("```` ts").is_none());
        assert!(is_closing("``` end"));
        assert!(is_closing("``` rust end"));
        assert!(!is_closing("```rust end"));
        assert!(opening("``` rust end").is_none());
        assert!(!is_closing("```end"));
        assert!(!is_closing("``` end text"));
        assert!(pair_matches("```", "```   ", &profile));
        assert!(pair_matches("``` rust", "```", &profile));
        assert!(pair_matches("``` begin", "``` end", &profile));
        assert!(pair_matches("``` rust begin", "``` end", &profile));
        assert!(pair_matches("``` rust begin", "``` rust end", &profile));
        assert!(pair_matches("``` rust begin", "``` other end", &profile));
        assert!(!pair_matches("``` rust begin", "```", &profile));
        assert!(!pair_matches("``` rust", "``` end", &profile));
        assert_eq!(
            opening("``` beginlang").unwrap().language.as_deref(),
            Some("beginlang")
        );
        assert_eq!(
            opening("``` weekend begin").unwrap().language.as_deref(),
            Some("weekend")
        );
    }
}
