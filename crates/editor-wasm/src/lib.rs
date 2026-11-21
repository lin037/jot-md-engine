//! Wasm 传输适配层。
//!
//! `EditorHost::handle` 有意保持为普通 Rust 方法，使整个请求/响应协议可以在
//! native 环境测试。`wasm32` 包装层只负责在 `JsValue` 与 serde DTO 之间转换。

use std::collections::HashMap;

use editor_engine::EditorDocument;
use editor_protocol::{
    DocumentId, ErrorCode, PROTOCOL_VERSION, ProtocolError, RequestBody, RequestEnvelope,
    ResponseBody, ResponseEnvelope,
};

/// 管理打开的文档，并将协议请求路由到编辑器引擎。
#[derive(Default)]
pub struct EditorHost {
    documents: HashMap<DocumentId, OpenDocument>,
}

impl EditorHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一个完整请求，并始终返回带有相同请求标识的响应。
    pub fn handle(&mut self, request: RequestEnvelope) -> ResponseEnvelope {
        let request_id = request.request_id;
        let generation = request.generation;
        let document_id = request.document_id.clone();

        // 版本检查必须早于业务分发，避免不同协议版本解释同一字段时产生误操作。
        if request.protocol_version != PROTOCOL_VERSION {
            return response(
                request_id,
                generation,
                document_id,
                failure(
                    ErrorCode::ProtocolMismatch,
                    format!(
                        "protocol {} is unsupported; expected {}",
                        request.protocol_version, PROTOCOL_VERSION
                    ),
                    false,
                ),
            );
        }

        // 握手不依赖具体文档；其余分支会在下面统一检查文档是否存在。
        let body = match request.body {
            RequestBody::Handshake { .. } => ResponseBody::HandshakeAck {
                engine_version: env!("CARGO_PKG_VERSION").to_owned(),
                capabilities: vec![
                    format!("protocol-v{PROTOCOL_VERSION}"),
                    "utf16-offsets".to_owned(),
                    "mixed-eol".to_owned(),
                    "request-response".to_owned(),
                    "projection-patch".to_owned(),
                    "projection-slices".to_owned(),
                    "projection-range-anchor".to_owned(),
                    "post-transaction-projection".to_owned(),
                    "nested-projection-splice".to_owned(),
                    "source-range-reference".to_owned(),
                    "source-line-projection".to_owned(),
                    "quote-line-projection".to_owned(),
                    "heading-section-projection".to_owned(),
                    "heading-outline-projection".to_owned(),
                    "analysis-commands".to_owned(),
                    "analysis-priority-ranges".to_owned(),
                    "analysis-work-budget".to_owned(),
                    "analysis-sequence".to_owned(),
                    "partial-syntax-state".to_owned(),
                    "dirty-source-fallback".to_owned(),
                ],
            },
            RequestBody::OpenDocument {
                source,
                syntax_profile,
                analysis,
            } => {
                let Some(id) = document_id.clone() else {
                    return response(
                        request_id,
                        generation,
                        None,
                        failure(
                            ErrorCode::MissingDocumentId,
                            "open-document requires documentId".to_owned(),
                            true,
                        ),
                    );
                };
                // generation 表示文档实例代次，不同于文档内部的 revision。
                // 旧实例的请求不能覆盖当前已经打开的新实例。
                if let Some(current) = self.documents.get(&id)
                    && current.generation >= generation
                {
                    return response(
                        request_id,
                        generation,
                        Some(id),
                        failure(
                            ErrorCode::GenerationMismatch,
                            "the same or a newer document generation is already open".to_owned(),
                            true,
                        ),
                    );
                }
                let opened = match analysis.as_ref() {
                    Some(request) => EditorDocument::open_with_analysis(
                        id.clone(),
                        &source,
                        syntax_profile,
                        request,
                    ),
                    None => EditorDocument::open(id.clone(), &source, syntax_profile),
                };
                match opened {
                    Ok(document) => {
                        let revision = document.revision();
                        let source_utf16_len = document.text().utf16_len();
                        let source_line_count = document.text().line_count();
                        let analysis_state = document
                            .analysis_state(revision)
                            .expect("new document revision must match");
                        self.documents.insert(
                            id,
                            OpenDocument {
                                generation,
                                document,
                            },
                        );
                        ResponseBody::DocumentOpened {
                            revision,
                            source_utf16_len,
                            source_line_count,
                            analysis: analysis_state,
                        }
                    }
                    Err(error) => ResponseBody::Failure {
                        error: error.to_protocol_error(),
                    },
                }
            }
            body => {
                let Some(id) = document_id.clone() else {
                    return response(
                        request_id,
                        generation,
                        None,
                        failure(
                            ErrorCode::MissingDocumentId,
                            "the request requires documentId".to_owned(),
                            true,
                        ),
                    );
                };
                let Some(open) = self.documents.get_mut(&id) else {
                    return response(
                        request_id,
                        generation,
                        Some(id),
                        failure(
                            ErrorCode::DocumentNotOpen,
                            "the document is not open".to_owned(),
                            true,
                        ),
                    );
                };
                if open.generation != generation {
                    return response(
                        request_id,
                        generation,
                        Some(id),
                        failure(
                            ErrorCode::GenerationMismatch,
                            format!(
                                "generation {} does not match open generation {}",
                                generation, open.generation
                            ),
                            true,
                        ),
                    );
                }

                match body {
                    RequestBody::ApplyTransaction {
                        transaction,
                        projection,
                    } => {
                        if projection.as_ref().is_some_and(|projection| {
                            transaction.base_revision.checked_next() != Some(projection.revision)
                        }) {
                            return response(
                                request_id,
                                generation,
                                Some(id),
                                failure(
                                    ErrorCode::RevisionMismatch,
                                    "post-transaction projection must target the next revision"
                                        .to_owned(),
                                    true,
                                ),
                            );
                        }
                        match open.document.apply_transaction(&transaction) {
                            Ok(patch) => {
                                let analysis = open
                                    .document
                                    .analysis_state(patch.revision)
                                    .expect("committed revision must match");
                                let render_patch = projection
                                    .as_ref()
                                    .and_then(|projection| open.document.project(projection).ok());
                                ResponseBody::TransactionCommitted {
                                    patch,
                                    analysis,
                                    render_patch,
                                }
                            }
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::Project { projection } => {
                        match open.document.project(&projection) {
                            Ok(patch) => ResponseBody::ProjectionReady { patch },
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::GetSnapshot { revision } => {
                        match open.document.snapshot(revision) {
                            Ok(snapshot) => ResponseBody::SnapshotReady {
                                revision: snapshot.revision,
                                text: snapshot.text,
                                line_endings: snapshot.line_endings,
                            },
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::ScheduleAnalysis { revision, request } => {
                        match open.document.schedule_analysis(revision, &request) {
                            Ok(analysis) => ResponseBody::AnalysisStateChanged {
                                analysis,
                                update: None,
                            },
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::ReprioritizeAnalysis {
                        revision,
                        analysis_id,
                        priority,
                    } => {
                        match open
                            .document
                            .reprioritize_analysis(revision, &analysis_id, &priority)
                        {
                            Ok(analysis) => ResponseBody::AnalysisStateChanged {
                                analysis,
                                update: None,
                            },
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::ProcessAnalysisQueue {
                        revision,
                        analysis_id,
                        budget,
                    } => {
                        match open
                            .document
                            .process_analysis_queue(revision, &analysis_id, budget)
                        {
                            Ok((analysis, update)) => {
                                ResponseBody::AnalysisStateChanged { analysis, update }
                            }
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::CancelAnalysis {
                        revision,
                        analysis_id,
                        reason,
                    } => match open
                        .document
                        .cancel_analysis(revision, &analysis_id, reason)
                    {
                        Ok(analysis) => ResponseBody::AnalysisStateChanged {
                            analysis,
                            update: None,
                        },
                        Err(error) => ResponseBody::Failure {
                            error: error.to_protocol_error(),
                        },
                    },
                    RequestBody::GetAnalysisStatus { revision } => {
                        match open.document.analysis_state(revision) {
                            Ok(analysis) => ResponseBody::AnalysisStateChanged {
                                analysis,
                                update: None,
                            },
                            Err(error) => ResponseBody::Failure {
                                error: error.to_protocol_error(),
                            },
                        }
                    }
                    RequestBody::CloseDocument => {
                        self.documents.remove(&id);
                        ResponseBody::DocumentClosed
                    }
                    RequestBody::Handshake { .. } | RequestBody::OpenDocument { .. } => {
                        unreachable!("handled before document lookup")
                    }
                }
            }
        };

        response(request_id, generation, document_id, body)
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    use super::*;

    #[wasm_bindgen]
    pub struct WasmEditorHost {
        inner: EditorHost,
    }

    #[wasm_bindgen]
    impl WasmEditorHost {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: EditorHost::new(),
            }
        }

        /// 接收并返回可 structured-clone 的普通 JavaScript 对象。Worker 负责围绕
        /// 这次同步引擎调用安排异步调度。
        pub fn handle(&mut self, value: JsValue) -> Result<JsValue, JsValue> {
            let request: RequestEnvelope = serde_wasm_bindgen::from_value(value)
                .map_err(|error| JsValue::from_str(&format!("invalid request: {error}")))?;
            serde_wasm_bindgen::to_value(&self.inner.handle(request))
                .map_err(|error| JsValue::from_str(&format!("invalid response: {error}")))
        }
    }
}

struct OpenDocument {
    generation: u32,
    document: EditorDocument,
}

fn response(
    request_id: u32,
    generation: u32,
    document_id: Option<DocumentId>,
    body: ResponseBody,
) -> ResponseEnvelope {
    ResponseEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        generation,
        document_id,
        body,
    }
}

fn failure(code: ErrorCode, message: String, recoverable: bool) -> ResponseBody {
    ResponseBody::Failure {
        error: ProtocolError {
            code,
            message,
            expected_revision: None,
            actual_revision: None,
            recoverable,
        },
    }
}

#[cfg(test)]
mod tests {
    use editor_protocol::{RequestBody, SyntaxProfile};

    use super::*;

    fn request(body: RequestBody) -> RequestEnvelope {
        RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: 7,
            generation: 1,
            document_id: Some(DocumentId("doc-1".to_owned())),
            body,
        }
    }

    #[test]
    fn opens_and_closes_a_document_with_the_same_generation() {
        let mut host = EditorHost::new();
        let opened = host.handle(request(RequestBody::OpenDocument {
            source: "a\r\nb".to_owned(),
            syntax_profile: SyntaxProfile::default(),
            analysis: None,
        }));
        assert!(matches!(opened.body, ResponseBody::DocumentOpened { .. }));

        let closed = host.handle(request(RequestBody::CloseDocument));
        assert_eq!(closed.body, ResponseBody::DocumentClosed);
    }

    #[test]
    fn handshake_advertises_the_wire_version() {
        let response = EditorHost::new().handle(request(RequestBody::Handshake {
            client_name: "test".to_owned(),
            client_version: "1".to_owned(),
        }));
        let ResponseBody::HandshakeAck { capabilities, .. } = response.body else {
            panic!("expected handshake acknowledgement");
        };
        assert_eq!(response.protocol_version, 1);
        assert!(capabilities.iter().any(|name| name == "protocol-v1"));
    }

    #[test]
    fn rejects_an_unknown_protocol_version() {
        let mut host = EditorHost::new();
        let mut bad = request(RequestBody::Handshake {
            client_name: "test".to_owned(),
            client_version: "0".to_owned(),
        });
        bad.protocol_version = PROTOCOL_VERSION + 1;
        let response = host.handle(bad);
        assert!(matches!(
            response.body,
            ResponseBody::Failure {
                error: ProtocolError {
                    code: ErrorCode::ProtocolMismatch,
                    ..
                }
            }
        ));
    }
}
