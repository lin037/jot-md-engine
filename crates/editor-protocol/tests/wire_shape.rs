use editor_protocol::{
    AnalysisCancelReason, AnalysisConsistency, AnalysisId, AnalysisPriority, AnalysisPurpose,
    AnalysisRequest, AnalysisState, AnalysisUrgency, AnalysisWorkBudget, DocumentId,
    DocumentTransaction, HistoryIntent, NewlinePolicy, PROTOCOL_VERSION, ProjectionAxis,
    ProjectionMode, ProjectionRequest, ProjectionSlice, ProjectionWindow, RenderContent,
    RenderMode, RenderNode, RenderOperation, RenderPatch, RequestBody, RequestEnvelope,
    ResponseBody, ResponseEnvelope, Revision, SourceLineEnding, SyntaxProfile, TextEdit, TextRange,
    TransactionId, TransactionMetadata, TransactionOrigin,
};

#[test]
fn request_uses_the_typescript_camel_case_wire_shape() {
    let request = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 9,
        generation: 2,
        document_id: Some(DocumentId("doc-1".to_owned())),
        body: RequestBody::OpenDocument {
            source: "hello".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        },
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["requestId"], 9);
    assert_eq!(value["documentId"], "doc-1");
    assert_eq!(value["body"]["type"], "open-document");
    assert_eq!(value["body"]["syntaxProfile"]["id"], "safe-markdown");
    assert!(value["body"].get("syntax_profile").is_none());
}

#[test]
fn analysis_commands_have_stable_tags_and_utf16_priority_ranges() {
    let priority = AnalysisPriority {
        priority_ranges: vec![TextRange::new(10, 20)],
        visible_ranges: vec![TextRange::new(0, 40)],
        active_range: Some(TextRange::new(12, 12)),
        urgency: AnalysisUrgency::Interactive,
    };
    let open = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 10,
        generation: 3,
        document_id: Some(DocumentId("doc-analysis".to_owned())),
        body: RequestBody::OpenDocument {
            source: "hello".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: Some(AnalysisRequest {
                priority: priority.clone(),
                consistency: AnalysisConsistency::AllowPartial,
                purpose: AnalysisPurpose::Interactive,
                initial_budget: AnalysisWorkBudget::default(),
            }),
        },
    };
    let value = serde_json::to_value(open).unwrap();
    assert_eq!(
        value["body"]["analysis"]["priority"]["priorityRanges"][0]["from"],
        10
    );
    assert_eq!(value["body"]["analysis"]["initialBudget"]["maxBlocks"], 128);

    let cancel = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 11,
        generation: 3,
        document_id: Some(DocumentId("doc-analysis".to_owned())),
        body: RequestBody::CancelAnalysis {
            revision: Revision(4),
            analysis_id: AnalysisId("analysis-1".to_owned()),
            reason: AnalysisCancelReason::Superseded,
        },
    };
    let value = serde_json::to_value(cancel).unwrap();
    assert_eq!(value["body"]["type"], "cancel-analysis");
    assert_eq!(value["body"]["analysisId"], "analysis-1");
    assert_eq!(value["body"]["reason"], "superseded");

    let schedule = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 12,
        generation: 3,
        document_id: Some(DocumentId("doc-analysis".to_owned())),
        body: RequestBody::ScheduleAnalysis {
            revision: Revision(4),
            request: AnalysisRequest::default(),
        },
    };
    let value = serde_json::to_value(schedule).unwrap();
    assert_eq!(value["body"]["type"], "schedule-analysis");
    assert_eq!(value["body"]["request"]["purpose"], "interactive");
    assert_eq!(
        value["body"]["request"]["initialBudget"]["maxUtf16Units"],
        65_536
    );

    let process = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 13,
        generation: 3,
        document_id: Some(DocumentId("doc-analysis".to_owned())),
        body: RequestBody::ProcessAnalysisQueue {
            revision: Revision(4),
            analysis_id: AnalysisId("analysis-4".to_owned()),
            budget: AnalysisWorkBudget::default(),
        },
    };
    let value = serde_json::to_value(process).unwrap();
    assert_eq!(value["body"]["type"], "process-analysis-queue");
    assert_eq!(value["body"]["analysisId"], "analysis-4");
}

#[test]
fn required_analysis_fields_are_not_silently_defaulted_on_the_wire() {
    let incomplete = serde_json::json!({
        "priority": {
            "priorityRanges": [],
            "visibleRanges": [],
            "urgency": "interactive"
        },
        "consistency": "allow-partial",
        "purpose": "interactive"
    });

    assert!(serde_json::from_value::<AnalysisRequest>(incomplete).is_err());
}

#[test]
fn complete_analysis_state_is_tagged_and_revision_bound() {
    let response = ResponseEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 12,
        generation: 3,
        document_id: Some(DocumentId("doc-analysis".to_owned())),
        body: ResponseBody::AnalysisStateChanged {
            analysis: AnalysisState::complete(
                AnalysisId("analysis-4".to_owned()),
                Revision(4),
                TextRange::new(0, 100),
                9,
            ),
            update: None,
        },
    };
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["body"]["type"], "analysis-state-changed");
    assert_eq!(value["body"]["analysis"]["state"], "complete");
    assert_eq!(value["body"]["analysis"]["targetRevision"], 4);
    assert!(value["body"].get("update").is_none());
}

#[test]
fn transaction_carries_explicit_history_metadata_and_analysis_policy() {
    let request = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 13,
        generation: 3,
        document_id: Some(DocumentId("doc-analysis".to_owned())),
        body: RequestBody::ApplyTransaction {
            transaction: DocumentTransaction {
                id: TransactionId("tx-ime-1".to_owned()),
                base_revision: Revision(4),
                origin: TransactionOrigin::Ime,
                edits: vec![TextEdit {
                    range: TextRange::new(2, 2),
                    insert: "文".to_owned(),
                }],
                newline_policy: NewlinePolicy::default(),
                selection_before: None,
                selection_after: None,
                history: HistoryIntent::Record {
                    group: Some("composition-7".to_owned()),
                },
                metadata: Some(TransactionMetadata {
                    user_event: Some("input.type.compose".to_owned()),
                    composition_id: Some("composition-7".to_owned()),
                    correlation_id: Some("trace-9".to_owned()),
                    actor_id: None,
                }),
                analysis: Some(AnalysisRequest::default()),
            },
            projection: None,
        },
    };

    let value = serde_json::to_value(request).unwrap();
    let transaction = &value["body"]["transaction"];
    assert_eq!(transaction["history"]["type"], "record");
    assert_eq!(transaction["history"]["group"], "composition-7");
    assert_eq!(transaction["metadata"]["compositionId"], "composition-7");
    assert_eq!(transaction["analysis"]["consistency"], "allow-partial");
}

#[test]
fn absent_optional_fields_are_omitted_instead_of_null() {
    let request = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 1,
        generation: 0,
        document_id: None,
        body: RequestBody::Handshake {
            client_name: "test".to_owned(),
            client_version: "0.1".to_owned(),
        },
    };

    let value = serde_json::to_value(request).unwrap();
    assert!(value.get("documentId").is_none());
    assert_eq!(value["body"]["clientName"], "test");
    assert_eq!(value["body"]["clientVersion"], "0.1");
}

#[test]
fn projection_and_snapshot_fields_match_the_typescript_shape() {
    assert_eq!(
        serde_json::to_string(&ProjectionAxis::QuoteLines).unwrap(),
        "\"quote-lines\""
    );
    assert_eq!(
        serde_json::from_str::<ProjectionAxis>("\"quote-lines\"").unwrap(),
        ProjectionAxis::QuoteLines
    );
    let request = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 3,
        generation: 1,
        document_id: Some(DocumentId("doc-1".to_owned())),
        body: RequestBody::Project {
            projection: ProjectionRequest {
                revision: Revision(3),
                view_revision: 8,
                slices: vec![ProjectionSlice {
                    parent_id: "table-7".to_owned(),
                    axis: ProjectionAxis::SyntaxChildren,
                    window: ProjectionWindow::Index {
                        from: 5000,
                        to_exclusive: 5100,
                    },
                    max_depth: 1,
                    collapsed_headings: Vec::new(),
                }],
                mode: ProjectionMode::Preview,
                active_range: None,
            },
        },
    };
    let request_value = serde_json::to_value(request).unwrap();
    assert_eq!(
        request_value["body"]["projection"]["slices"][0]["parentId"],
        "table-7"
    );
    assert_eq!(
        request_value["body"]["projection"]["slices"][0]["axis"],
        "syntax-children"
    );
    assert_eq!(
        request_value["body"]["projection"]["slices"][0]["window"]["toExclusive"],
        5100
    );
    assert_eq!(
        request_value["body"]["projection"]["slices"][0]["maxDepth"],
        1
    );

    let render_patch = RenderPatch {
        document_id: DocumentId("doc-1".to_owned()),
        document_revision: Revision(3),
        view_revision: 8,
        operations: vec![RenderOperation::ReplaceChildren {
            parent_id: "0".to_owned(),
            axis: ProjectionAxis::SyntaxChildren,
            from: 0,
            remove_count: 0,
            total_children: 2,
            inserted: vec![
                RenderNode {
                    id: "node-1".to_owned(),
                    kind: "paragraph".to_owned(),
                    source_range: TextRange::new(0, 2),
                    content_version: 1,
                    mode: RenderMode::Preview,
                    child_count: 1,
                    attributes: Vec::new(),
                    content: RenderContent::Deferred,
                },
                RenderNode {
                    id: "node-2".to_owned(),
                    kind: "text".to_owned(),
                    source_range: TextRange::new(2, 20_000),
                    content_version: 0,
                    mode: RenderMode::Preview,
                    child_count: 0,
                    attributes: Vec::new(),
                    content: RenderContent::Source,
                },
            ],
        }],
    };
    let projection_value = serde_json::to_value(render_patch).unwrap();
    assert_eq!(projection_value["viewRevision"], 8);
    assert_eq!(
        projection_value["operations"][0]["type"],
        "replace-children"
    );
    assert_eq!(projection_value["operations"][0]["parentId"], "0");
    assert_eq!(projection_value["operations"][0]["axis"], "syntax-children");
    assert_eq!(projection_value["operations"][0]["from"], 0);
    assert_eq!(
        projection_value["operations"][0]["inserted"][0]["content"]["type"],
        "deferred"
    );
    assert_eq!(
        projection_value["operations"][0]["inserted"][1]["content"]["type"],
        "source"
    );
    assert!(
        projection_value["operations"][0]["inserted"][1]["content"]
            .get("text")
            .is_none(),
        "source text must be resolved from the frontend text buffer"
    );

    let snapshot = ResponseEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 4,
        generation: 1,
        document_id: Some(DocumentId("doc-1".to_owned())),
        body: ResponseBody::SnapshotReady {
            revision: Revision(3),
            text: "a\nb".to_owned(),
            line_endings: vec![SourceLineEnding::Crlf, SourceLineEnding::None],
        },
    };
    let snapshot_value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(snapshot_value["body"]["lineEndings"][0], "crlf");
    assert_eq!(snapshot_value["body"]["lineEndings"][1], "none");
}

#[test]
fn range_anchored_projection_window_has_a_stable_wire_shape() {
    let window = ProjectionWindow::AroundRange {
        range: TextRange::new(1_024, 1_024),
        before: 12,
        after: 40,
    };
    let value = serde_json::to_value(window).unwrap();
    assert_eq!(value["type"], "around-range");
    assert_eq!(value["range"]["from"], 1_024);
    assert_eq!(value["range"]["to"], 1_024);
    assert_eq!(value["before"], 12);
    assert_eq!(value["after"], 40);
    assert!(value.get("toExclusive").is_none());
}
