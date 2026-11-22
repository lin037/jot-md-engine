use editor_protocol::{
    AnalysisCancelReason, AnalysisId, AnalysisPriority, AnalysisRequest, AnalysisState,
    AnalysisUrgency, AnalysisWorkBudget, DocumentId, DocumentTransaction, ErrorCode, HistoryIntent,
    NewlinePolicy, PROTOCOL_VERSION, ProjectionAxis, ProjectionMode, ProjectionRequest,
    ProjectionSlice, ProjectionWindow, ProtocolError, RenderOperation, RequestBody,
    RequestEnvelope, ResponseBody, Revision, SyntaxProfile, TextEdit, TextRange, TransactionId,
    TransactionOrigin,
};
use editor_wasm::EditorHost;

#[test]
fn host_routes_a_public_protocol_request() {
    let mut host = EditorHost::new();
    let response = host.handle(RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 1,
        generation: 1,
        document_id: Some(DocumentId("doc".to_owned())),
        body: RequestBody::OpenDocument {
            source: "hello".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        },
    });

    assert!(matches!(response.body, ResponseBody::DocumentOpened { .. }));
}

#[test]
fn host_routes_generic_projection_slices() {
    let mut host = EditorHost::new();
    host.handle(request(
        1,
        RequestBody::OpenDocument {
            source: "# heading\nparagraph".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        },
    ));
    let projected = host.handle(request(
        2,
        RequestBody::Project {
            projection: ProjectionRequest {
                revision: Revision(0),
                view_revision: 4,
                slices: vec![ProjectionSlice {
                    parent_id: "0".to_owned(),
                    axis: ProjectionAxis::SyntaxChildren,
                    window: ProjectionWindow::Index {
                        from: 0,
                        to_exclusive: 1,
                    },
                    max_depth: 0,
                    collapsed_headings: Vec::new(),
                }],
                mode: ProjectionMode::Preview,
                active_range: None,
            },
        },
    ));
    let ResponseBody::ProjectionReady { patch } = projected.body else {
        panic!("expected projection response")
    };
    let RenderOperation::ReplaceChildren {
        parent_id,
        total_children,
        inserted,
        ..
    } = &patch.operations[0];
    assert_eq!(parent_id, "0");
    assert_eq!(*total_children, 2);
    assert_eq!(inserted[0].kind, "heading");
}

#[test]
fn transaction_can_return_the_changed_projection_in_one_round_trip() {
    let mut host = EditorHost::new();
    host.handle(request(
        1,
        RequestBody::OpenDocument {
            source: "alpha\nbeta".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        },
    ));
    let committed = host.handle(request(
        2,
        RequestBody::ApplyTransaction {
            transaction: DocumentTransaction {
                id: TransactionId("tx-projected".to_owned()),
                base_revision: Revision(0),
                origin: TransactionOrigin::Keyboard,
                edits: vec![TextEdit {
                    range: TextRange::new(0, 5),
                    insert: "ALPHA".to_owned(),
                }],
                newline_policy: NewlinePolicy::default(),
                selection_before: None,
                selection_after: None,
                history: HistoryIntent::default(),
                metadata: None,
                analysis: None,
            },
            projection: Some(ProjectionRequest {
                revision: Revision(1),
                view_revision: 3,
                slices: vec![ProjectionSlice {
                    parent_id: "0".to_owned(),
                    axis: ProjectionAxis::SyntaxChildren,
                    window: ProjectionWindow::Index {
                        from: 0,
                        to_exclusive: 1,
                    },
                    max_depth: 0,
                    collapsed_headings: Vec::new(),
                }],
                mode: ProjectionMode::Preview,
                active_range: None,
            }),
        },
    ));
    let ResponseBody::TransactionCommitted {
        patch,
        render_patch: Some(render_patch),
        ..
    } = committed.body
    else {
        panic!("expected transaction and projection in one response")
    };
    assert_eq!(patch.revision, Revision(1));
    assert_eq!(render_patch.document_revision, Revision(1));
    assert_eq!(render_patch.view_revision, 3);
    let RenderOperation::ReplaceChildren { inserted, .. } = &render_patch.operations[0];
    assert_eq!(
        inserted[0].id,
        patch.syntax.unwrap().block_changes[0].inserted[0].id
    );
}

#[test]
fn transaction_projection_handles_multibyte_line_endings() {
    let source = "前\n😀后\n尾";
    let mut host = EditorHost::new();
    host.handle(request(
        1,
        RequestBody::OpenDocument {
            source: source.to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        },
    ));

    let end = source.encode_utf16().count() as u32;
    let committed = host.handle(request(
        2,
        RequestBody::ApplyTransaction {
            transaction: DocumentTransaction {
                id: TransactionId("tx-utf8-line-end".to_owned()),
                base_revision: Revision(0),
                origin: TransactionOrigin::Keyboard,
                edits: vec![TextEdit {
                    range: TextRange::new(end, end),
                    insert: "!".to_owned(),
                }],
                newline_policy: NewlinePolicy::default(),
                selection_before: None,
                selection_after: None,
                history: HistoryIntent::default(),
                metadata: None,
                analysis: None,
            },
            projection: Some(ProjectionRequest {
                revision: Revision(1),
                view_revision: 0,
                slices: vec![ProjectionSlice {
                    parent_id: "0".to_owned(),
                    axis: ProjectionAxis::SourceLines,
                    window: ProjectionWindow::Index {
                        from: 0,
                        to_exclusive: 10,
                    },
                    max_depth: 0,
                    collapsed_headings: Vec::new(),
                }],
                mode: ProjectionMode::Preview,
                active_range: None,
            }),
        },
    ));

    let ResponseBody::TransactionCommitted {
        patch,
        render_patch: Some(render_patch),
        ..
    } = committed.body
    else {
        panic!("expected a committed edit and source-line projection");
    };
    assert_eq!(patch.revision, Revision(1));
    assert_eq!(patch.changed_text_range.after, TextRange::new(7, 8));
    assert_eq!(render_patch.document_revision, patch.revision);
    let [RenderOperation::ReplaceChildren { axis, inserted, .. }] =
        render_patch.operations.as_slice()
    else {
        panic!("expected one source-line window");
    };
    assert_eq!(*axis, ProjectionAxis::SourceLines);
    let ranges: Vec<_> = inserted.iter().map(|line| line.source_range).collect();
    assert_eq!(
        ranges,
        [
            TextRange::new(0, 2),
            TextRange::new(2, 6),
            TextRange::new(6, 8)
        ]
    );
    let snapshot = host.handle(request(
        3,
        RequestBody::GetSnapshot {
            revision: patch.revision,
        },
    ));
    let ResponseBody::SnapshotReady { text, .. } = snapshot.body else {
        panic!("expected the committed text");
    };
    assert_eq!(text, "前\n😀后\n尾!");
}

#[test]
fn code_content_transaction_updates_root_and_source_line_projection_together() {
    let source = "``` rust begin\ncode stays\n``` end";
    let mut host = EditorHost::new();
    host.handle(request(
        1,
        RequestBody::OpenDocument {
            source: source.to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        },
    ));
    let projected = host.handle(request(
        2,
        RequestBody::Project {
            projection: ProjectionRequest {
                revision: Revision(0),
                view_revision: 0,
                slices: vec![ProjectionSlice {
                    parent_id: "0".to_owned(),
                    axis: ProjectionAxis::SyntaxChildren,
                    window: ProjectionWindow::Index {
                        from: 0,
                        to_exclusive: 1,
                    },
                    max_depth: 0,
                    collapsed_headings: Vec::new(),
                }],
                mode: ProjectionMode::Preview,
                active_range: None,
            },
        },
    ));
    let ResponseBody::ProjectionReady { patch } = projected.body else {
        panic!("expected initial projection")
    };
    let RenderOperation::ReplaceChildren { inserted, .. } = &patch.operations[0];
    let code_id = inserted[0].id.clone();
    let code_version = inserted[0].content_version;
    let from = u32::try_from(source.find("stays").unwrap()).unwrap();
    let updated = source.replace("stays", "works");

    let committed = host.handle(request(
        3,
        RequestBody::ApplyTransaction {
            transaction: DocumentTransaction {
                id: TransactionId("tx-code-content".to_owned()),
                base_revision: Revision(0),
                origin: TransactionOrigin::Keyboard,
                edits: vec![TextEdit {
                    range: TextRange::new(from, from + 5),
                    insert: "works".to_owned(),
                }],
                newline_policy: NewlinePolicy::default(),
                selection_before: None,
                selection_after: None,
                history: HistoryIntent::default(),
                metadata: None,
                analysis: None,
            },
            projection: Some(ProjectionRequest {
                revision: Revision(1),
                view_revision: 0,
                slices: vec![
                    ProjectionSlice {
                        parent_id: "0".to_owned(),
                        axis: ProjectionAxis::SyntaxChildren,
                        window: ProjectionWindow::Index {
                            from: 0,
                            to_exclusive: 1,
                        },
                        max_depth: 0,
                        collapsed_headings: Vec::new(),
                    },
                    ProjectionSlice {
                        parent_id: code_id.clone(),
                        axis: ProjectionAxis::SourceLines,
                        window: ProjectionWindow::Index {
                            from: 0,
                            to_exclusive: 1,
                        },
                        max_depth: 0,
                        collapsed_headings: Vec::new(),
                    },
                ],
                mode: ProjectionMode::Preview,
                active_range: None,
            }),
        },
    ));
    let ResponseBody::TransactionCommitted {
        patch,
        render_patch: Some(render_patch),
        ..
    } = committed.body
    else {
        panic!("expected projected code transaction")
    };
    let syntax = patch
        .syntax
        .expect("code body edit must publish syntax impact");
    assert_eq!(syntax.projection_changes.len(), 1);
    assert_eq!(
        syntax.projection_changes[0].axis,
        ProjectionAxis::SourceLines
    );
    let RenderOperation::ReplaceChildren { inserted: root, .. } = &render_patch.operations[0];
    assert_eq!(root[0].id, code_id);
    assert_eq!(root[0].content_version, code_version + 1);
    let RenderOperation::ReplaceChildren {
        inserted: lines, ..
    } = &render_patch.operations[1];
    let line = lines.first().expect("changed source line");
    let line_source = &updated[line.source_range.from as usize..line.source_range.to as usize];
    assert!(line_source.contains("code works"));
}

fn request(id: u32, body: RequestBody) -> RequestEnvelope {
    RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: id,
        generation: 1,
        document_id: Some(DocumentId("analysis-doc".to_owned())),
        body,
    }
}

fn assert_error(response: ResponseBody, code: ErrorCode) {
    assert!(matches!(
        response,
        ResponseBody::Failure {
            error: ProtocolError { code: actual, .. }
        } if actual == code
    ));
}

#[test]
fn analysis_commands_are_revision_and_job_scoped() {
    let mut host = EditorHost::new();
    let opened = host.handle(request(
        1,
        RequestBody::OpenDocument {
            source: "a😀b".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: Some(AnalysisRequest::default()),
        },
    ));
    let analysis_id = match opened.body {
        ResponseBody::DocumentOpened {
            analysis: editor_protocol::AnalysisState::Complete { analysis_id, .. },
            ..
        } => analysis_id,
        body => panic!("unexpected open response: {body:?}"),
    };

    let status = host.handle(request(
        2,
        RequestBody::GetAnalysisStatus {
            revision: Revision(0),
        },
    ));
    assert!(matches!(
        status.body,
        ResponseBody::AnalysisStateChanged {
            analysis: editor_protocol::AnalysisState::Complete { .. },
            update: None,
        }
    ));

    let invalid_priority = AnalysisPriority {
        priority_ranges: vec![TextRange::new(2, 2)],
        visible_ranges: Vec::new(),
        active_range: None,
        urgency: AnalysisUrgency::Interactive,
    };
    let reprioritized = host.handle(request(
        3,
        RequestBody::ReprioritizeAnalysis {
            revision: Revision(0),
            analysis_id: analysis_id.clone(),
            priority: invalid_priority,
        },
    ));
    assert_error(reprioritized.body, ErrorCode::InvalidAnalysisHint);

    let zero_budget = host.handle(request(
        4,
        RequestBody::ProcessAnalysisQueue {
            revision: Revision(0),
            analysis_id: analysis_id.clone(),
            budget: AnalysisWorkBudget {
                max_source_lines: 0,
                ..AnalysisWorkBudget::default()
            },
        },
    ));
    assert_error(zero_budget.body, ErrorCode::InvalidAnalysisHint);

    let unknown_job = host.handle(request(
        5,
        RequestBody::CancelAnalysis {
            revision: Revision(0),
            analysis_id: AnalysisId("unknown".to_owned()),
            reason: AnalysisCancelReason::Requested,
        },
    ));
    assert_error(unknown_job.body, ErrorCode::AnalysisNotFound);

    let completed_cancel = host.handle(request(
        6,
        RequestBody::CancelAnalysis {
            revision: Revision(0),
            analysis_id,
            reason: AnalysisCancelReason::Requested,
        },
    ));
    assert!(matches!(
        completed_cancel.body,
        ResponseBody::AnalysisStateChanged {
            analysis: editor_protocol::AnalysisState::Complete { .. },
            ..
        }
    ));

    let stale_status = host.handle(request(
        7,
        RequestBody::GetAnalysisStatus {
            revision: Revision(1),
        },
    ));
    assert_error(stale_status.body, ErrorCode::RevisionMismatch);
}

#[test]
fn partial_analysis_publishes_one_update_per_pump_and_can_cancel() {
    let mut host = EditorHost::new();
    let opened = host.handle(request(
        20,
        RequestBody::OpenDocument {
            source: "one\ntwo\nthree\nfour".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: Some(AnalysisRequest {
                initial_budget: AnalysisWorkBudget {
                    max_source_lines: 1,
                    max_blocks: 1,
                    max_utf16_units: 16,
                },
                ..AnalysisRequest::default()
            }),
        },
    ));
    let analysis_id = match opened.body {
        ResponseBody::DocumentOpened {
            analysis:
                AnalysisState::Pending {
                    analysis_id,
                    sequence: 0,
                    ..
                },
            ..
        } => analysis_id,
        body => panic!("expected partial open, got {body:?}"),
    };

    let progress = host.handle(request(
        21,
        RequestBody::ProcessAnalysisQueue {
            revision: Revision(0),
            analysis_id: analysis_id.clone(),
            budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 16,
            },
        },
    ));
    assert!(matches!(
        progress.body,
        ResponseBody::AnalysisStateChanged {
            analysis: AnalysisState::Pending { sequence: 1, .. },
            update: Some(editor_protocol::AnalysisUpdate { sequence: 1, .. }),
        }
    ));

    let cancelled = host.handle(request(
        22,
        RequestBody::CancelAnalysis {
            revision: Revision(0),
            analysis_id,
            reason: AnalysisCancelReason::Requested,
        },
    ));
    assert!(matches!(
        cancelled.body,
        ResponseBody::AnalysisStateChanged {
            analysis: AnalysisState::Cancelled { sequence: 2, .. },
            update: None,
        }
    ));
}
