use editor_engine::EditorDocument;
use editor_protocol::{
    DocumentId, ProjectionAxis, ProjectionMode, ProjectionRequest, ProjectionSlice,
    ProjectionWindow, RenderContent, RenderOperation, RenderValue, Revision, TextRange,
};

fn slice(
    parent_id: impl Into<String>,
    axis: ProjectionAxis,
    from: u32,
    to_exclusive: u32,
    max_depth: u8,
) -> ProjectionSlice {
    ProjectionSlice {
        parent_id: parent_id.into(),
        axis,
        window: ProjectionWindow::Index { from, to_exclusive },
        max_depth,
        collapsed_headings: Vec::new(),
    }
}

#[test]
fn one_generic_protocol_virtualizes_root_nested_and_opaque_content() {
    let mut source = "# title **strong** *emphasis*\n\n- parent\n  1. child\n".to_owned();
    source.push_str("\n| key | value |\n| --- | --- |\n");
    source.push_str(
        &(0..400)
            .map(|row| format!("| r{row} | value{row} |"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    source.push_str("\n\n``` rust begin\n");
    source.push_str(
        &(0..300)
            .map(|line| format!("let value_{line} = {line};"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    source.push_str("\n``` end\n\n$$\n");
    source.push_str(
        &(0..200)
            .map(|line| format!("x_{{{line}}} + y_{{{line}}}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    source.push_str("\n$$");

    let document = EditorDocument::open(
        DocumentId("projection".to_owned()),
        &source,
        Default::default(),
    )
    .unwrap();
    let root = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 1,
            slices: vec![slice("0", ProjectionAxis::SyntaxChildren, 0, 20, 0)],
            mode: ProjectionMode::Hybrid,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren {
        parent_id,
        axis,
        total_children,
        inserted,
        ..
    } = &root.operations[0];
    assert_eq!(parent_id, "0");
    assert_eq!(*axis, ProjectionAxis::SyntaxChildren);
    assert_eq!(*total_children, 10);

    let heading = inserted.iter().find(|node| node.kind == "heading").unwrap();
    assert_eq!(attribute(heading, "level"), Some(&RenderValue::Number(1)));
    let heading_id = heading.id.clone();
    let list = inserted
        .iter()
        .find(|node| node.kind == "list-item")
        .unwrap();
    assert_eq!(
        attribute(list, "marker"),
        Some(&RenderValue::String("-".to_owned()))
    );
    let list_id = list.id.clone();
    let table = inserted.iter().find(|node| node.kind == "table").unwrap();
    assert_eq!(table.child_count, 401);
    let table_id = table.id.clone();
    let code = inserted
        .iter()
        .find(|node| node.kind == "fenced-code")
        .unwrap();
    assert_eq!(
        attribute(code, "language"),
        Some(&RenderValue::String("rust".to_owned()))
    );
    assert_eq!(attribute(code, "closed"), Some(&RenderValue::Boolean(true)));
    let code_id = code.id.clone();
    let math = inserted
        .iter()
        .find(|node| node.kind == "math-block")
        .unwrap();
    assert_eq!(
        attribute(math, "delimiter"),
        Some(&RenderValue::String("dollar".to_owned()))
    );
    let math_id = math.id.clone();
    assert!(
        inserted
            .iter()
            .filter(|node| matches!(
                node.kind.as_str(),
                "heading" | "list-item" | "table" | "fenced-code" | "math-block"
            ))
            .all(|node| matches!(node.content, RenderContent::Deferred))
    );

    let nested = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 1,
            slices: vec![
                slice(heading_id, ProjectionAxis::SyntaxChildren, 0, 20, 1),
                slice(list_id, ProjectionAxis::SyntaxChildren, 0, 1, 2),
                slice(
                    table_id.clone(),
                    ProjectionAxis::SyntaxChildren,
                    150,
                    160,
                    1,
                ),
                slice(code_id, ProjectionAxis::SourceLines, 120, 130, 0),
                slice(math_id, ProjectionAxis::SourceLines, 80, 85, 0),
            ],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    assert_eq!(nested.operations.len(), 5);

    let RenderOperation::ReplaceChildren { inserted, .. } = &nested.operations[0];
    assert!(inserted.iter().any(|node| node.kind == "strong"));
    assert!(inserted.iter().any(|node| node.kind == "emphasis"));

    let RenderOperation::ReplaceChildren { inserted, .. } = &nested.operations[1];
    assert_eq!(inserted.len(), 1);
    assert!(matches!(
        inserted[0].content,
        RenderContent::Structured { .. }
    ));

    let RenderOperation::ReplaceChildren {
        total_children,
        inserted,
        ..
    } = &nested.operations[2];
    assert_eq!(*total_children, 401);
    assert_eq!(inserted.len(), 10);
    assert!(inserted.iter().all(|row| row.child_count == 2));
    let RenderContent::Structured { children: cells } = &inserted[0].content else {
        panic!("expected projected table cells")
    };
    assert_eq!(
        attribute(&cells[0], "displayColumns"),
        Some(&RenderValue::Number(4))
    );
    assert_eq!(
        attribute(&cells[0], "maxUnbreakableColumns"),
        Some(&RenderValue::Number(4))
    );
    assert_eq!(
        attribute(table, "layoutRowCount"),
        Some(&RenderValue::Number(401))
    );
    match attribute(table, "layoutMaxDisplayColumns") {
        Some(RenderValue::Numbers(values)) => assert_eq!(values, &vec![4, 8]),
        other => panic!("expected table column display summary, got {other:?}"),
    }
    match attribute(table, "layoutNonEmptyCells") {
        Some(RenderValue::Numbers(values)) => assert_eq!(values, &vec![401, 401]),
        other => panic!("expected table non-empty summary, got {other:?}"),
    }
    match attribute(table, "layoutDemandWeights") {
        Some(RenderValue::Numbers(values)) => {
            assert_eq!(values.len(), 2);
            assert!(
                values[1] > values[0],
                "longer value column should carry more demand"
            );
        }
        other => panic!("expected table demand weights, got {other:?}"),
    }

    let RenderOperation::ReplaceChildren {
        axis,
        total_children,
        inserted,
        ..
    } = &nested.operations[3];
    assert_eq!(*axis, ProjectionAxis::SourceLines);
    assert_eq!(*total_children, 300);
    assert_eq!(inserted.len(), 10);
    assert!(inserted.iter().all(|line| line.kind == "source-line"));

    let RenderOperation::ReplaceChildren {
        total_children,
        inserted,
        ..
    } = &nested.operations[4];
    assert_eq!(*total_children, 200);
    assert_eq!(inserted.len(), 5);

    let target = source.find("| r275 |").unwrap() as u32;
    let anchored = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 2,
            slices: vec![ProjectionSlice {
                parent_id: table_id,
                axis: ProjectionAxis::SyntaxChildren,
                window: ProjectionWindow::AroundRange {
                    range: TextRange::new(target, target),
                    before: 2,
                    after: 3,
                },
                max_depth: 0,
                collapsed_headings: Vec::new(),
            }],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren { from, inserted, .. } = &anchored.operations[0];
    assert_eq!(*from, 274);
    assert_eq!(inserted.len(), 6);
    assert!(
        inserted
            .iter()
            .any(|row| row.source_range.from <= target && target <= row.source_range.to)
    );
}

#[test]
fn ordered_list_projection_preserves_item_numbers_and_excludes_markers_from_text() {
    let document = EditorDocument::open(
        DocumentId("ordered-list-projection".to_owned()),
        "3. alpha\n7. beta\n12. gamma",
        Default::default(),
    )
    .unwrap();
    let patch = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            slices: vec![slice("0", ProjectionAxis::SyntaxChildren, 0, 3, 4)],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren { inserted, .. } = &patch.operations[0];
    let numbers = inserted
        .iter()
        .map(|item| attribute(item, "number"))
        .collect::<Vec<_>>();
    assert_eq!(
        numbers,
        vec![
            Some(&RenderValue::Number(3)),
            Some(&RenderValue::Number(7)),
            Some(&RenderValue::Number(12)),
        ]
    );
    let text_starts = inserted
        .iter()
        .map(|item| {
            let RenderContent::Structured {
                children: paragraphs,
            } = &item.content
            else {
                panic!("expected item paragraph")
            };
            let RenderContent::Structured { children: text } = &paragraphs[0].content else {
                panic!("expected paragraph text")
            };
            text[0].source_range.from
        })
        .collect::<Vec<_>>();
    assert_eq!(text_starts, vec![3, 12, 21]);
}

#[test]
fn image_projection_keeps_alt_destination_and_title_separate() {
    let source = "![diagram alt](image.png \"caption\")";
    let document = EditorDocument::open(
        DocumentId("image-attributes".to_owned()),
        source,
        Default::default(),
    )
    .unwrap();
    let patch = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            slices: vec![slice("0", ProjectionAxis::SyntaxChildren, 0, 1, 3)],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren { inserted, .. } = &patch.operations[0];
    let RenderContent::Structured { children: inline } = &inserted[0].content else {
        panic!("expected paragraph children");
    };
    let image = &inline[0];
    assert_eq!(image.kind, "image");
    assert_eq!(
        attribute(image, "alt"),
        Some(&RenderValue::String("diagram alt".to_owned()))
    );
    assert_eq!(
        attribute(image, "destination"),
        Some(&RenderValue::String("image.png".to_owned()))
    );
    assert_eq!(
        attribute(image, "title"),
        Some(&RenderValue::String("caption".to_owned()))
    );
}

#[test]
fn empty_list_items_are_structured_and_code_blank_lines_are_projectable() {
    let source = "3. \n7. value\n\n``` rust begin\nline\n\n``` end";
    let document = EditorDocument::open(
        DocumentId("empty-containers".to_owned()),
        source,
        Default::default(),
    )
    .unwrap();
    let root = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            slices: vec![slice("0", ProjectionAxis::SyntaxChildren, 0, 5, 3)],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren { inserted, .. } = &root.operations[0];
    assert_eq!(
        attribute(&inserted[0], "number"),
        Some(&RenderValue::Number(3))
    );
    assert!(matches!(
        inserted[0].content,
        RenderContent::Structured { ref children } if children.is_empty()
    ));

    assert_eq!(inserted[2].kind, "blank-line");
    let code = inserted
        .iter()
        .find(|node| node.kind == "fenced-code")
        .unwrap();
    let lines = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            slices: vec![slice(
                code.id.clone(),
                ProjectionAxis::SourceLines,
                0,
                10,
                0,
            )],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren {
        total_children,
        inserted: source_lines,
        ..
    } = &lines.operations[0];
    assert_eq!(*total_children, 2);
    assert_eq!(source_lines.len(), 2);
    assert_eq!(
        &source
            [source_lines[0].source_range.from as usize..source_lines[0].source_range.to as usize],
        "line\n"
    );
    assert_eq!(
        &source
            [source_lines[1].source_range.from as usize..source_lines[1].source_range.to as usize],
        "\n"
    );
}

#[test]
fn adjacent_fences_project_one_empty_code_line() {
    for marker in ["~~~", "```"] {
        let source = format!("{marker}\n{marker}");
        let document = EditorDocument::open(
            DocumentId("empty-fence".into()),
            &source,
            Default::default(),
        )
        .unwrap();
        let mut request = ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            slices: vec![slice("0", ProjectionAxis::SyntaxChildren, 0, 1, 0)],
            mode: ProjectionMode::Preview,
            active_range: None,
        };
        let root = document.project(&request).unwrap();
        let RenderOperation::ReplaceChildren { inserted, .. } = &root.operations[0];
        assert_eq!(inserted[0].kind, "fenced-code");
        request.slices = vec![slice(
            &inserted[0].id,
            ProjectionAxis::SourceLines,
            0,
            10,
            0,
        )];
        let lines = document.project(&request).unwrap();
        let RenderOperation::ReplaceChildren {
            total_children,
            inserted,
            ..
        } = &lines.operations[0];
        assert_eq!((*total_children, inserted.len()), (1, 1));
        assert_eq!(inserted[0].source_range, TextRange::new(4, 4));
    }
}

#[test]
fn around_range_keeps_a_zero_width_blank_line_at_the_anchor() {
    let source = "first\n\nsecond";
    let document = EditorDocument::open(
        DocumentId("around-blank-line".to_owned()),
        source,
        Default::default(),
    )
    .unwrap();
    let blank = source.find("\n\n").unwrap() as u32 + 1;
    let patch = document
        .project(&ProjectionRequest {
            revision: Revision(0),
            view_revision: 0,
            slices: vec![ProjectionSlice {
                parent_id: "0".to_owned(),
                axis: ProjectionAxis::SyntaxChildren,
                window: ProjectionWindow::AroundRange {
                    range: TextRange::new(blank, blank),
                    before: 0,
                    after: 0,
                },
                max_depth: 0,
                collapsed_headings: Vec::new(),
            }],
            mode: ProjectionMode::Preview,
            active_range: None,
        })
        .unwrap();
    let RenderOperation::ReplaceChildren { inserted, .. } = &patch.operations[0];
    assert_eq!(inserted.len(), 1);
    assert_eq!(inserted[0].kind, "blank-line");
    assert_eq!(inserted[0].source_range, TextRange::new(blank, blank));
}

fn attribute<'a>(node: &'a editor_protocol::RenderNode, name: &str) -> Option<&'a RenderValue> {
    node.attributes
        .iter()
        .find(|attribute| attribute.name == name)
        .map(|attribute| &attribute.value)
}
