use crate::common::assert_same_syntax;
use editor_engine::{
    syntax::{
        CompiledSyntaxProfile, MathDelimiter, NodeKind, SyntaxNode, SyntaxSnapshot, TableAlignment,
        parse, reparse_change,
    },
    text::TextBuffer,
};
use editor_protocol::{ChangedTextRange, ExtensionVersion, SyntaxProfile, TextRange};

fn parse_syntax(source: &str) -> SyntaxSnapshot {
    parse(
        &TextBuffer::from_source(source),
        &CompiledSyntaxProfile::compile(Default::default()),
    )
    .unwrap()
}

fn node<'a>(syntax: &'a SyntaxSnapshot, parent: &SyntaxNode, index: usize) -> &'a SyntaxNode {
    syntax.node(parent.children[index]).unwrap()
}

#[test]
fn strikethrough_respects_code_and_nested_formatting() {
    let syntax = parse_syntax("~~删除 **重要**~~ `~~源码~~` ~单个~");
    let paragraph = syntax.block(0).unwrap();
    let strike = node(&syntax, paragraph, 0);
    assert_eq!(strike.kind, NodeKind::Strikethrough);
    assert!(
        strike
            .children
            .iter()
            .any(|id| syntax.node(*id).unwrap().kind == NodeKind::Strong)
    );
    assert!(
        paragraph
            .children
            .iter()
            .any(|id| matches!(syntax.node(*id).unwrap().kind, NodeKind::InlineCode { .. }))
    );
    assert!(
        !paragraph
            .children
            .iter()
            .skip(1)
            .any(|id| syntax.node(*id).unwrap().kind == NodeKind::Strikethrough)
    );
}

#[test]
fn tilde_delimiters_respect_escaping_nesting_and_protected_atoms() {
    fn count(
        syntax: &SyntaxSnapshot,
        node: &SyntaxNode,
        predicate: &impl Fn(&NodeKind) -> bool,
    ) -> usize {
        usize::from(predicate(&node.kind))
            + node
                .children
                .iter()
                .map(|id| count(syntax, syntax.node(*id).unwrap(), predicate))
                .sum::<usize>()
    }
    for (source, strikes, escaped) in [
        ("~单波浪~", 0, 0),
        ("~~删除~~", 1, 0),
        ("~~未闭合", 0, 0),
        ("~~~连续~~~", 0, 0),
        (r"\~~转义开头~~", 0, 1),
        (r"~~删除 \~ 保留~~", 1, 1),
        (r"\\~~双反斜杠后删除~~", 1, 0),
        (r"\\\~~三反斜杠后不成对~~", 0, 1),
        ("~~*斜体*~~", 1, 0),
        ("*~~删除~~*", 1, 0),
        ("~~**粗体**~~", 1, 0),
        ("**~~删除~~**", 1, 0),
        ("`~~代码~~` $~~公式~~$", 0, 0),
        ("[~~链接文字~~](https://example.com)", 1, 0),
    ] {
        let syntax = parse_syntax(source);
        let root = syntax.block(0).unwrap();
        assert_eq!(
            count(&syntax, root, &|kind| matches!(
                kind,
                NodeKind::Strikethrough
            )),
            strikes,
            "{source:?}"
        );
        assert_eq!(
            count(&syntax, root, &|kind| matches!(
                kind,
                NodeKind::EscapedText { .. }
            )),
            escaped,
            "{source:?}"
        );
    }
}

#[test]
fn crossing_tilde_and_emphasis_leave_unmatched_source_visible() {
    for (source, kind, inner, tail) in [
        ("~~*词~~ tail*", NodeKind::Strikethrough, "*词", " tail*"),
        ("*词 ~~删* 尾~~", NodeKind::Emphasis, "词 ~~删", " 尾~~"),
    ] {
        let syntax = parse_syntax(source);
        let root = syntax.block(0).unwrap();
        let outer = node(&syntax, root, 0);
        assert_eq!(outer.kind, kind);
        let buffer = TextBuffer::from_source(source);
        assert_eq!(
            buffer.slice(node(&syntax, outer, 0).source_range).unwrap(),
            inner
        );
        assert_eq!(
            buffer.slice(node(&syntax, root, 1).source_range).unwrap(),
            tail
        );
    }
}

#[test]
fn dense_unmatched_and_matched_tildes_remain_parseable() {
    let source = format!("{}{}", "x~~ ".repeat(20_000), "~~ok~~ ".repeat(2_000));
    let syntax = parse_syntax(&source);
    assert_eq!(syntax.block_count(), 1);
    assert_eq!(
        syntax
            .block(0)
            .unwrap()
            .children
            .iter()
            .filter(|id| syntax.node(**id).unwrap().kind == NodeKind::Strikethrough)
            .count(),
        2_000
    );
}

#[test]
fn task_marker_is_a_list_child_with_a_precise_source_range() {
    for (source, checked) in [
        ("- [ ] 写文档", false),
        ("1. [x] 完成", true),
        ("- [X]", true),
    ] {
        let syntax = parse_syntax(source);
        let item = syntax.block(0).unwrap();
        assert!(matches!(item.kind, NodeKind::ListItem { .. }));
        let paragraph = node(&syntax, item, 0);
        let marker = node(&syntax, paragraph, 0);
        assert_eq!(marker.kind, NodeKind::TaskMarker { checked });
        assert_eq!(
            TextBuffer::from_source(source)
                .slice(marker.source_range)
                .unwrap()
                .len(),
            3
        );
    }
    for source in ["[x] 正文", "- [x]suffix", "- `[x]`"] {
        let syntax = parse_syntax(source);
        let root = syntax.block(0).unwrap();
        fn has_task(syntax: &SyntaxSnapshot, node: &SyntaxNode) -> bool {
            matches!(node.kind, NodeKind::TaskMarker { .. })
                || node
                    .children
                    .iter()
                    .any(|id| has_task(syntax, syntax.node(*id).unwrap()))
        }
        assert!(!has_task(&syntax, root), "{source}");
    }
}

#[test]
fn links_preserve_balanced_parentheses_and_angle_autolinks() {
    for (source, expected) in [
        (
            "[中文](https://example.com/a_(b_(c)) \"标题\")",
            "https://example.com/a_(b_(c))",
        ),
        ("[a [nested]](https://example.com/)", "https://example.com/"),
        ("[`a]b`](https://example.com/)", "https://example.com/"),
        (
            r"[x](https://example.com/a\(b\))",
            "https://example.com/a(b)",
        ),
        ("<https://example.com/a_(b)>", "https://example.com/a_(b)"),
        (
            "<https://example.com/a_~~b~~_*c*>",
            "https://example.com/a_~~b~~_*c*",
        ),
        ("<person@example.com>", "mailto:person@example.com"),
    ] {
        let syntax = parse_syntax(source);
        let link = node(&syntax, syntax.block(0).unwrap(), 0);
        let NodeKind::Link { destination, .. } = &link.kind else {
            panic!("expected link: {source}")
        };
        assert_eq!(destination, expected);
        assert_eq!(
            TextBuffer::from_source(source)
                .slice(link.source_range)
                .unwrap(),
            source
        );
    }
    let syntax = parse_syntax("`<https://example.com>` <not a link>");
    let paragraph = syntax.block(0).unwrap();
    assert!(matches!(
        node(&syntax, paragraph, 0).kind,
        NodeKind::InlineCode { .. }
    ));
    assert!(
        paragraph
            .children
            .iter()
            .all(|id| !matches!(syntax.node(*id).unwrap().kind, NodeKind::Link { .. }))
    );
}

#[test]
fn autolink_label_preserves_delimiters_as_address_text() {
    for source in [
        "<https://example.com/a_~~b~~_*c*>",
        "<person~~name@example.com>",
    ] {
        let syntax = parse_syntax(source);
        let link = node(&syntax, syntax.block(0).unwrap(), 0);
        assert!(matches!(link.kind, NodeKind::Link { .. }));
        assert_eq!(link.children.len(), 1);
        let label = node(&syntax, link, 0);
        assert_eq!(label.kind, NodeKind::Text);
        assert_eq!(
            TextBuffer::from_source(source)
                .slice(label.source_range)
                .unwrap(),
            &source[1..source.len() - 1]
        );
    }
}

#[test]
fn unspaced_fence_language_requires_explicit_compatibility_profile() {
    let source = "intro\n```mermaid\ngantt\n```\n## 后续正文\n```ts\nlet x = 1;\n```\nend";
    let compatible = CompiledSyntaxProfile::compile(SyntaxProfile {
        enabled_extensions: vec![ExtensionVersion {
            id: "commonmark-fence-language".into(),
            version: "1.0.0".into(),
        }],
        ..Default::default()
    });
    let syntax = parse(&TextBuffer::from_source(source), &compatible).unwrap();
    assert_eq!(syntax.block_count(), 5);
    assert!(
        matches!(&syntax.block(1).unwrap().kind, NodeKind::FencedCode { language: Some(language), .. } if language == "mermaid")
    );
    assert!(matches!(
        syntax.block(2).unwrap().kind,
        NodeKind::Heading { .. }
    ));
    assert!(
        matches!(&syntax.block(3).unwrap().kind, NodeKind::FencedCode { language: Some(language), .. } if language == "ts")
    );

    let default = parse_syntax(source);
    assert_eq!(default.block(1).unwrap().kind, NodeKind::Paragraph);
    let unknown_version = CompiledSyntaxProfile::compile(SyntaxProfile {
        enabled_extensions: vec![ExtensionVersion {
            id: "commonmark-fence-language".into(),
            version: "2.0.0".into(),
        }],
        ..Default::default()
    });
    assert_eq!(
        parse(&TextBuffer::from_source(source), &unknown_version)
            .unwrap()
            .block(1)
            .unwrap()
            .kind,
        NodeKind::Paragraph
    );
    for invalid in [
        "```begin\ncode\n``` end",
        "```rust begin\ncode\n``` end",
        "```\tts\ncode\n```",
        "```mermaid\ngantt",
    ] {
        let syntax = parse(&TextBuffer::from_source(invalid), &compatible).unwrap();
        assert!(
            syntax
                .block(0)
                .is_some_and(|node| node.kind == NodeKind::Paragraph),
            "{invalid:?}"
        );
    }
}

#[test]
fn every_ordinary_physical_line_is_a_paragraph() {
    let syntax = parse_syntax("first\nsecond\nthird");
    assert_eq!(syntax.block_count(), 3);
    for index in 0..3 {
        assert_eq!(syntax.block(index).unwrap().kind, NodeKind::Paragraph);
    }
}

#[test]
fn explicit_code_fence_requires_an_exclusive_end_line() {
    let source = "``` rust begin\nlet x = 1;\n``` end\nafter";
    let syntax = parse_syntax(source);
    assert_eq!(syntax.block_count(), 2);
    let code = syntax.block(0).unwrap();
    let NodeKind::FencedCode {
        language,
        content_range,
        closed,
        ..
    } = &code.kind
    else {
        panic!("expected fenced code");
    };
    assert_eq!(language.as_deref(), Some("rust"));
    assert_eq!(
        &source[content_range.from as usize..content_range.to as usize],
        "let x = 1;"
    );
    assert!(*closed);

    let unclosed_source = "```rustbegin\ncode\n``` end trailing\nafter";
    let unclosed = parse_syntax(unclosed_source);
    assert_eq!(unclosed.block_count(), 4);
    assert!(
        (0..unclosed.block_count())
            .all(|index| unclosed.block(index).unwrap().kind == NodeKind::Paragraph)
    );
}

#[test]
fn bare_and_explicit_fences_have_matching_closers_and_exact_content() {
    for (opener, closer, language, body) in [
        ("```", "```", None, ""),
        ("``` ts", "```", Some("ts"), "const x = 1;"),
        ("``` begin", "``` end", None, "content"),
        (
            "``` rust begin",
            "``` end",
            Some("rust"),
            "line\n```\n# still code",
        ),
        ("``` rust begin", "``` rust end", Some("rust"), "same label"),
        (
            "``` rust begin",
            "``` typescript end",
            Some("rust"),
            "other label",
        ),
        ("``` beginlang", "```", Some("beginlang"), "x"),
        ("``` weekend begin", "``` end", Some("weekend"), "x"),
        (" ```   ts  ", "  ``` \t", Some("ts"), "x"),
    ] {
        let source = format!("before\n{opener}\n{body}\n{closer}\nafter");
        let syntax = parse_syntax(&source);
        assert_eq!(syntax.block_count(), 3, "{source:?}");
        let NodeKind::FencedCode {
            language: actual,
            content_range,
            closed,
            ..
        } = &syntax.block(1).unwrap().kind
        else {
            panic!("expected fenced code for {source:?}");
        };
        assert!(*closed);
        assert_eq!(actual.as_deref(), language, "{source:?}");
        assert_eq!(
            &source[content_range.from as usize..content_range.to as usize],
            body,
            "{source:?}"
        );
        assert_eq!(syntax.block(2).unwrap().kind, NodeKind::Paragraph);
    }

    let empty = parse_syntax("```\n```");
    let NodeKind::FencedCode { content_range, .. } = &empty.block(0).unwrap().kind else {
        panic!("empty matching fence must produce a code block");
    };
    assert_eq!(content_range.from, content_range.to);

    let unicode = "前😀\n``` ts\n代码🙂\n```\n后";
    let unicode_tree = parse_syntax(unicode);
    let NodeKind::FencedCode { content_range, .. } = &unicode_tree.block(1).unwrap().kind else {
        panic!("expected unicode fenced code");
    };
    assert_eq!(
        TextBuffer::from_source(unicode)
            .slice(*content_range)
            .unwrap(),
        "代码🙂"
    );
}

#[test]
fn malformed_or_unmatched_fences_do_not_hide_other_blocks() {
    for invalid in [
        "```ts",
        "```begin",
        "```end",
        "```\tts",
        "```` ts",
        "``` ts extra",
        "``` end extra",
        "```rust end",
    ] {
        let source = format!("{invalid}\n# heading\n- item\n| H |\n| --- |\n| value |");
        let syntax = parse_syntax(&source);
        assert_eq!(
            syntax.block(0).unwrap().kind,
            NodeKind::Paragraph,
            "{invalid}"
        );
        assert_eq!(
            syntax.block(1).unwrap().kind,
            NodeKind::Heading { level: 1 },
            "{invalid}"
        );
        assert!(
            matches!(syntax.block(2).unwrap().kind, NodeKind::ListItem { .. }),
            "{invalid}"
        );
        assert!(
            matches!(syntax.block(3).unwrap().kind, NodeKind::Table { .. }),
            "{invalid}"
        );
    }
    for source in [
        "``` ts\n# heading\n- item\n``` end",
        "``` rust begin\n# heading\n- item\n```",
    ] {
        let syntax = parse_syntax(source);
        assert_eq!(
            syntax.block(0).unwrap().kind,
            NodeKind::Paragraph,
            "{source:?}"
        );
        assert_eq!(
            syntax.block(1).unwrap().kind,
            NodeKind::Heading { level: 1 }
        );
        assert!(matches!(
            syntax.block(2).unwrap().kind,
            NodeKind::ListItem { .. }
        ));
    }
}

#[test]
fn labelled_end_is_never_a_code_opener_by_itself() {
    let source = "``` rust end\n# heading\n```\ncode\n```";
    let syntax = parse_syntax(source);
    assert_eq!(syntax.block(0).unwrap().kind, NodeKind::Paragraph);
    assert_eq!(
        syntax.block(1).unwrap().kind,
        NodeKind::Heading { level: 1 }
    );
    assert!(matches!(
        syntax.block(2).unwrap().kind,
        NodeKind::FencedCode { .. }
    ));
}

#[test]
fn completed_fences_take_priority_and_do_not_absorb_adjacent_blocks() {
    let source = "```\n# code heading\n- code item\n$$\nx\n$$\n```\n``` end\n# real heading\n| H |\n| --- |\n| value |";
    let syntax = parse_syntax(source);
    assert!(matches!(
        syntax.block(0).unwrap().kind,
        NodeKind::FencedCode { .. }
    ));
    assert_eq!(syntax.block(1).unwrap().kind, NodeKind::Paragraph);
    assert_eq!(
        syntax.block(2).unwrap().kind,
        NodeKind::Heading { level: 1 }
    );
    assert!(matches!(
        syntax.block(3).unwrap().kind,
        NodeKind::Table { .. }
    ));
}

#[test]
fn many_unclosed_code_openers_are_independent_paragraphs() {
    let source = (0..10_000)
        .map(|index| format!("``` lang{index} begin"))
        .collect::<Vec<_>>()
        .join("\n");
    let syntax = parse_syntax(&source);
    assert_eq!(syntax.block_count(), 10_000);
    assert!(
        (0..syntax.block_count())
            .all(|index| syntax.block(index).unwrap().kind == NodeKind::Paragraph)
    );
}

#[test]
fn both_block_math_forms_require_exclusive_marker_lines() {
    let source = "$$\nx + 1\n$$\n\\[\ny + 1\n\\]";
    let syntax = parse_syntax(source);
    assert_eq!(syntax.block_count(), 2);
    assert!(matches!(
        syntax.block(0).unwrap().kind,
        NodeKind::MathBlock {
            delimiter: MathDelimiter::Dollar,
            closed: true,
            ..
        }
    ));
    assert!(matches!(
        syntax.block(1).unwrap().kind,
        NodeKind::MathBlock {
            delimiter: MathDelimiter::Bracket,
            closed: true,
            ..
        }
    ));

    let invalid = parse_syntax("$$ x\n\\[ y");
    assert_eq!(invalid.block_count(), 2);
    assert!(matches!(
        invalid.block(0).unwrap().kind,
        NodeKind::Paragraph
    ));
}

#[test]
fn unclosed_block_math_remains_source_and_does_not_own_the_tail() {
    let source = "\\[\nx + y\nnot a closer";
    let syntax = parse_syntax(source);
    assert_eq!(syntax.block_count(), 3);
    assert!(
        (0..syntax.block_count())
            .all(|index| syntax.block(index).unwrap().kind == NodeKind::Paragraph)
    );

    // Removing the original opener leaves its former symmetric closer behind.
    // Without another `$$` it must not be reinterpreted as an unbounded block.
    let removed_opener = parse_syntax("before\nx\n$$\nafter\nmore");
    assert_eq!(removed_opener.block_count(), 5);
    assert!(
        (0..removed_opener.block_count())
            .all(|index| removed_opener.block(index).unwrap().kind == NodeKind::Paragraph)
    );
}

#[test]
fn many_unclosed_math_openers_are_independent_paragraphs() {
    let source = std::iter::repeat_n("\\[", 10_000)
        .collect::<Vec<_>>()
        .join("\n");
    let syntax = parse_syntax(&source);
    assert_eq!(syntax.block_count(), 10_000);
    assert!(
        (0..syntax.block_count())
            .all(|index| syntax.block(index).unwrap().kind == NodeKind::Paragraph)
    );
}

#[test]
fn inline_math_trims_inner_spacing_and_never_crosses_a_line() {
    let source = "a   $ x + 1 $b \\( y \\)";
    let syntax = parse_syntax(source);
    let paragraph = syntax.block(0).unwrap();
    let math: Vec<_> = paragraph
        .children
        .iter()
        .filter_map(|id| {
            let child = syntax.node(*id).unwrap();
            matches!(child.kind, NodeKind::InlineMath { .. }).then_some(child)
        })
        .collect();
    assert_eq!(math.len(), 2);
    let NodeKind::InlineMath { content_range, .. } = &math[0].kind else {
        unreachable!()
    };
    assert_eq!(
        &source[content_range.from as usize..content_range.to as usize],
        "x + 1"
    );

    let split = parse_syntax("before $x\nafter$ text");
    assert_eq!(split.block_count(), 2);
    assert!(
        split
            .root()
            .children
            .iter()
            .flat_map(|id| split.node(*id).unwrap().children.iter())
            .all(|id| !matches!(split.node(*id).unwrap().kind, NodeKind::InlineMath { .. }))
    );
}

#[test]
fn inline_math_content_range_is_utf16_based() {
    let syntax = parse_syntax("😀 $ 公式 $");
    let paragraph = syntax.block(0).unwrap();
    let math = paragraph
        .children
        .iter()
        .map(|id| syntax.node(*id).unwrap())
        .find(|node| matches!(node.kind, NodeKind::InlineMath { .. }))
        .unwrap();
    let NodeKind::InlineMath { content_range, .. } = math.kind else {
        unreachable!()
    };
    assert_eq!(content_range, TextRange::new(5, 7));
}

#[test]
fn inline_code_link_and_image_are_protected_structures() {
    let syntax = parse_syntax("`*$x$*` [**label**](https://example.com \"t\") ![alt](img.png)");
    let paragraph = syntax.block(0).unwrap();
    assert!(
        paragraph
            .children
            .iter()
            .any(|id| matches!(syntax.node(*id).unwrap().kind, NodeKind::InlineCode { .. }))
    );
    let link = paragraph
        .children
        .iter()
        .map(|id| syntax.node(*id).unwrap())
        .find(|node| matches!(node.kind, NodeKind::Link { .. }))
        .unwrap();
    assert_eq!(node(&syntax, link, 0).kind, NodeKind::Strong);
    let image = paragraph
        .children
        .iter()
        .map(|id| syntax.node(*id).unwrap())
        .find(|node| matches!(node.kind, NodeKind::Image { .. }))
        .unwrap();
    let NodeKind::Image { alt, .. } = &image.kind else {
        unreachable!()
    };
    assert_eq!(alt, "alt");
}

#[test]
fn table_needs_pipes_on_every_consumed_row() {
    let syntax = parse_syntax("name | value\n:--- | ---:\n**a** | 1\nmissing pipe\nb | 2");
    assert_eq!(syntax.block_count(), 3);
    let table = syntax.block(0).unwrap();
    assert_eq!(
        table.kind,
        NodeKind::Table {
            alignments: vec![TableAlignment::Left, TableAlignment::Right]
        }
    );
    assert_eq!(table.children.len(), 2);
    let header = node(&syntax, table, 0);
    assert_eq!(header.kind, NodeKind::TableRow { header: true });
    let data = node(&syntax, table, 1);
    assert_eq!(node(&syntax, data, 0).children.len(), 1);
    assert_eq!(
        node(&syntax, node(&syntax, data, 0), 0).kind,
        NodeKind::Strong
    );
    assert_eq!(syntax.block(1).unwrap().kind, NodeKind::Paragraph);
    assert_eq!(syntax.block(2).unwrap().kind, NodeKind::Paragraph);
}

#[test]
fn block_quote_recursively_parses_each_physical_line() {
    let syntax = parse_syntax("> # heading\n> ordinary\n> - item");
    let quote = syntax.block(0).unwrap();
    assert_eq!(quote.kind, NodeKind::BlockQuote);
    assert_eq!(node(&syntax, quote, 0).kind, NodeKind::Heading { level: 1 });
    assert_eq!(node(&syntax, quote, 1).kind, NodeKind::Paragraph);
    assert!(matches!(
        node(&syntax, quote, 2).kind,
        NodeKind::ListItem {
            indent_columns: 0,
            ..
        }
    ));
}

#[test]
fn new_container_edits_match_a_full_reparse() {
    let original = "``` rust begin\n$x$\n``` end\na | b\n--- | ---\n1 | 2";
    let from = original.find("``` end").unwrap() as u32 + 7;
    let inserted = " trailing";
    let mut changed = original.to_owned();
    changed.insert_str(from as usize, inserted);
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let before = TextBuffer::from_source(original);
    let previous = parse(&before, &profile).unwrap();
    let changed_text = TextBuffer::from_source(&changed);
    let incremental = reparse_change(
        &previous,
        &before,
        &changed_text,
        ChangedTextRange {
            before: TextRange::new(from, from),
            after: TextRange::new(from, from + inserted.len() as u32),
        },
        "",
        inserted,
        &profile,
    )
    .unwrap();
    let full = parse(&changed_text, &profile).unwrap();
    assert_same_syntax(&incremental.snapshot, &full);
}

#[test]
fn tilde_fences_and_compact_bracket_math_keep_precise_ranges() {
    let source = "~~~~js\n~~~\n```\n~~~~~\n  \\[😀 + α\\]  \n\\(x\\)\n~~still struck~~";
    let syntax = parse_syntax(source);
    let text = TextBuffer::from_source(source);
    assert!(
        matches!(&syntax.block(0).unwrap().kind, NodeKind::FencedCode { language, content_range, .. }
        if language.as_deref() == Some("js") && text.slice(*content_range).unwrap() == "~~~\n```")
    );
    assert!(
        matches!(&syntax.block(1).unwrap().kind, NodeKind::MathBlock { content_range, delimiter: MathDelimiter::Bracket, .. }
        if text.slice(*content_range).unwrap() == "😀 + α")
    );
    assert!(matches!(
        node(&syntax, syntax.block(2).unwrap(), 0).kind,
        NodeKind::InlineMath { .. }
    ));
    assert!(matches!(
        node(&syntax, syntax.block(3).unwrap(), 0).kind,
        NodeKind::Strikethrough
    ));
    for literal in [
        "~~~~\nx\n~~~",
        "~~~js\nx\n```",
        r"before \[x\]",
        r"\[x\] and \[y\]",
        r"\[x\\]",
    ] {
        assert!(
            matches!(
                parse_syntax(literal).block(0).unwrap().kind,
                NodeKind::Paragraph
            ),
            "{literal}"
        );
    }
    let image = parse_syntax(r"![a\|b\]](<C:\\notes\\my (draft)\|copy.png>)");
    assert!(
        matches!(&node(&image, image.block(0).unwrap(), 0).kind, NodeKind::Image { destination, alt, .. }
        if destination == r"C:\notes\my (draft)|copy.png" && alt == "a|b]")
    );
}

#[test]
fn strikethrough_stops_at_code_fences() {
    for marker in ["~~~", "```"] {
        let source = format!("~~before~~\n{marker}\n~~literal~~\n{marker}\n~~after~~");
        let syntax = parse_syntax(&source);
        for index in [0, 2] {
            assert_eq!(
                node(&syntax, syntax.block(index).unwrap(), 0).kind,
                NodeKind::Strikethrough
            );
        }
        let code = syntax.block(1).unwrap();
        assert!(code.children.is_empty());
        assert!(
            matches!(&code.kind, NodeKind::FencedCode { content_range, .. }
            if TextBuffer::from_source(&source).slice(*content_range).unwrap() == "~~literal~~")
        );
    }
}

#[test]
fn editing_tilde_and_bracket_delimiters_agrees_with_full_parse() {
    let profile = CompiledSyntaxProfile::compile(Default::default());
    for (source, at, removed, inserted) in [
        ("~~~~js\nx\n~~~\ny\n~~~~", 0, "~", ""),
        ("~~~js\nx\n~~\nend", 10, "", "~"),
        ("~~~js\nx\n~~~\nend", 10, "~", ""),
        ("~~~\na\nb\n~~~", 6, "b", "~~~"),
        ("\\[x+1\\]", 3, "", "\\]"),
        ("\\[x+1\\]", 5, "", "\\"),
        ("\\[x+1\\]", 2, "", "\n"),
        ("\\[x+1", 5, "", "\\]"),
        ("\\[\\]", 2, "", "α"),
        ("~~~~\na\n~~~\nb\n~~~", 15, "", "~"),
        ("~~~\n\\[\n~~~js\n\\]\nend", 10, "", "\n"),
        ("\\[\n~~~\n\\]x\n~~~", 9, "x", ""),
    ] {
        let after = format!(
            "{}{}{}",
            &source[..at],
            inserted,
            &source[at + removed.len()..]
        );
        assert_eq!(&source[at..at + removed.len()], removed);
        let before = TextBuffer::from_source(source);
        let text = TextBuffer::from_source(&after);
        let range = ChangedTextRange {
            before: TextRange::new(at as u32, (at + removed.len()) as u32),
            after: TextRange::new(
                at as u32,
                at as u32 + inserted.encode_utf16().count() as u32,
            ),
        };
        let incremental = reparse_change(
            &parse_syntax(source),
            &before,
            &text,
            range,
            removed,
            inserted,
            &profile,
        )
        .unwrap();
        let full = parse_syntax(&after);
        assert_eq!(
            incremental.snapshot.block_count(),
            full.block_count(),
            "{source:?} -> {after:?}, reparsed {:?}",
            incremental.reparsed_range
        );
        assert_same_syntax(&incremental.snapshot, &full);
    }
}
