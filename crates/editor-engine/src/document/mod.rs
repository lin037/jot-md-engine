mod syntax_state;

#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

use editor_protocol::{
    AnalysisCancelReason, AnalysisFailure, AnalysisFailureCode, AnalysisId, AnalysisMetrics,
    AnalysisPriority, AnalysisRequest, AnalysisState, AnalysisUpdate, AnalysisWorkBudget,
    BlockMetadata, BlockRangeChange, DiagnosticPatch, DocumentId, DocumentPatch,
    DocumentTransaction, ErrorCode, ProjectionRequest, ProtocolError, RenderPatch, Revision,
    SyntaxPatchSummary, TextRange,
};

pub use syntax_state::SyntaxState;

use crate::{
    position::PositionError,
    projection,
    snapshot::TextSnapshot,
    syntax::{
        self, AnalysisProgress, CompiledSyntaxProfile, ParseError, SyntaxAnalysisSession,
        SyntaxCheckpoint, SyntaxSnapshot, WorkBudget,
    },
    text::TextBuffer,
    transaction::{AnalysisId as QueueAnalysisId, AnalysisQueue},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineError {
    RevisionMismatch {
        expected: Revision,
        actual: Revision,
    },
    RevisionOverflow,
    InvalidRange,
    Position(PositionError),
    EmptyTransaction,
    UnorderedOrOverlappingEdits,
    NonNormalizedInsert,
    InvalidAnalysisHint,
    AnalysisNotFound,
    AnalysisStale,
    DocumentTooLarge,
    Parse(ParseError),
}

impl From<PositionError> for EngineError {
    fn from(value: PositionError) -> Self {
        Self::Position(value)
    }
}

impl From<ParseError> for EngineError {
    fn from(value: ParseError) -> Self {
        Self::Parse(value)
    }
}

impl EngineError {
    pub fn to_protocol_error(&self) -> ProtocolError {
        let (code, message, expected_revision, actual_revision, recoverable) = match self {
            Self::RevisionMismatch { expected, actual } => (
                ErrorCode::RevisionMismatch,
                "the request targets a stale document revision".to_owned(),
                Some(*expected),
                Some(*actual),
                true,
            ),
            Self::RevisionOverflow => (
                ErrorCode::RevisionOverflow,
                "the document revision counter is exhausted".to_owned(),
                None,
                None,
                false,
            ),
            Self::InvalidRange | Self::Position(_) => (
                ErrorCode::InvalidRange,
                "a UTF-16 range is invalid or splits a surrogate pair".to_owned(),
                None,
                None,
                true,
            ),
            Self::EmptyTransaction
            | Self::UnorderedOrOverlappingEdits
            | Self::NonNormalizedInsert => (
                ErrorCode::InvalidTransaction,
                format!("invalid transaction: {self:?}"),
                None,
                None,
                true,
            ),
            Self::InvalidAnalysisHint => (
                ErrorCode::InvalidAnalysisHint,
                "analysis ranges or work budget are invalid".to_owned(),
                None,
                None,
                true,
            ),
            Self::AnalysisNotFound => (
                ErrorCode::AnalysisNotFound,
                "the requested analysis job does not exist".to_owned(),
                None,
                None,
                true,
            ),
            Self::AnalysisStale => (
                ErrorCode::AnalysisStale,
                "the requested analysis job can no longer publish updates".to_owned(),
                None,
                None,
                true,
            ),
            Self::DocumentTooLarge => (
                ErrorCode::ResourceLimit,
                "the document exceeds an engine resource limit".to_owned(),
                None,
                None,
                false,
            ),
            Self::Parse(_) => (
                ErrorCode::Internal,
                format!("engine error: {self:?}"),
                None,
                None,
                false,
            ),
        };
        ProtocolError {
            code,
            message,
            expected_revision,
            actual_revision,
            recoverable,
        }
    }
}

pub struct EditorDocument {
    id: DocumentId,
    revision: Revision,
    text: TextBuffer,
    syntax_state: SyntaxState,
    profile: CompiledSyntaxProfile,
    analysis_generation: u64,
    analysis_queue: AnalysisQueue,
    current_queue_id: Option<QueueAnalysisId>,
}

impl EditorDocument {
    /// 打开并完整解析文档。需要可中断初始解析的宿主必须调用 `open_with_analysis`。
    pub fn open(
        id: DocumentId,
        source: &str,
        profile: editor_protocol::SyntaxProfile,
    ) -> Result<Self, EngineError> {
        let text = TextBuffer::from_source(source);
        let profile = CompiledSyntaxProfile::compile(profile);
        let snapshot = syntax::parse(&text, &profile)?;
        let revision = Revision(0);
        let analysis_generation = 1;
        let analysis_id = Self::format_analysis_id(&id, revision, analysis_generation);
        Ok(Self {
            id,
            revision,
            text,
            syntax_state: SyntaxState::Complete {
                revision,
                analysis_id,
                sequence: 0,
                snapshot,
            },
            profile,
            analysis_generation,
            analysis_queue: AnalysisQueue::new(),
            current_queue_id: None,
        })
    }

    /// 以 revision zero 打开完整源码，但在返回前只把请求的确定性预算用于派生语法。
    pub fn open_with_analysis(
        id: DocumentId,
        source: &str,
        profile: editor_protocol::SyntaxProfile,
        request: &AnalysisRequest,
    ) -> Result<Self, EngineError> {
        let text = TextBuffer::from_source(source);
        Self::validate_analysis_request(&text, request)?;
        let profile = CompiledSyntaxProfile::compile(profile);
        let (session, progress) = Self::prepare_session(&text, &profile, request, None)?;
        let revision = Revision(0);
        let analysis_generation = 1;
        let analysis_id = Self::format_analysis_id(&id, revision, analysis_generation);
        let mut analysis_queue = AnalysisQueue::new();
        let priority_to = Self::remaining_priority_target(request, &progress, text.utf16_len());
        let (syntax_state, current_queue_id) = if progress.complete {
            let snapshot = session
                .completed_snapshot()
                .ok_or(ParseError::InvalidParserState)?;
            (
                SyntaxState::Complete {
                    revision,
                    analysis_id,
                    sequence: 0,
                    snapshot,
                },
                None,
            )
        } else {
            let prefix = session.prefix_snapshot();
            let queue_id =
                analysis_queue.enqueue_latest(analysis_generation, revision, session, priority_to);
            (
                SyntaxState::Partial {
                    revision,
                    analysis_id,
                    sequence: 0,
                    prefix,
                    confirmed_ranges: vec![progress.confirmed_range],
                    dirty_ranges: Self::dirty_suffix(progress.confirmed_range.to, text.utf16_len()),
                },
                Some(queue_id),
            )
        };
        Ok(Self {
            id,
            revision,
            text,
            syntax_state,
            profile,
            analysis_generation,
            analysis_queue,
            current_queue_id,
        })
    }

    pub fn id(&self) -> &DocumentId {
        &self.id
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    pub fn text(&self) -> &TextBuffer {
        &self.text
    }

    pub fn syntax_state(&self) -> &SyntaxState {
        &self.syntax_state
    }

    pub fn analysis_state(&self, revision: Revision) -> Result<AnalysisState, EngineError> {
        self.require_revision(revision)?;
        debug_assert_eq!(self.syntax_state.revision(), self.revision);
        Ok(self.syntax_state.protocol_state(self.text.utf16_len()))
    }

    pub fn schedule_analysis(
        &mut self,
        revision: Revision,
        request: &AnalysisRequest,
    ) -> Result<AnalysisState, EngineError> {
        self.require_revision(revision)?;
        Self::validate_analysis_request(&self.text, request)?;
        match self.syntax_state {
            SyntaxState::Complete { .. } | SyntaxState::Partial { .. } => {
                self.analysis_state(revision)
            }
            SyntaxState::Cancelled { .. } | SyntaxState::Failed { .. } => {
                let checkpoint = self.resumable_checkpoint();
                let (session, progress) =
                    Self::prepare_session(&self.text, &self.profile, request, checkpoint)?;
                self.analysis_generation = self.next_analysis_generation()?;
                let priority_to =
                    Self::remaining_priority_target(request, &progress, self.text.utf16_len());
                self.install_session(revision, session, progress, priority_to);
                self.analysis_state(revision)
            }
        }
    }

    pub fn process_analysis_queue(
        &mut self,
        revision: Revision,
        analysis_id: &AnalysisId,
        budget: AnalysisWorkBudget,
    ) -> Result<(AnalysisState, Option<AnalysisUpdate>), EngineError> {
        self.require_analysis(revision, analysis_id)?;
        Self::validate_work_budget(budget)?;
        let Some(expected_queue_id) = self.current_queue_id else {
            return Ok((self.analysis_state(revision)?, None));
        };
        if !matches!(self.syntax_state, SyntaxState::Partial { .. }) {
            return Err(EngineError::AnalysisStale);
        }

        let old_projection_blocks = self.projected_block_count();
        let old_sequence = self.syntax_state.sequence();
        #[cfg(not(target_arch = "wasm32"))]
        let started = Instant::now();
        let SyntaxState::Partial { prefix, .. } = &mut self.syntax_state else {
            return Err(EngineError::AnalysisStale);
        };
        let event = self.analysis_queue.poll_into(
            self.analysis_generation,
            self.revision,
            Self::work_budget(budget),
            prefix,
        );
        #[cfg(not(target_arch = "wasm32"))]
        let elapsed_micros = u32::try_from(started.elapsed().as_micros()).unwrap_or(u32::MAX);
        // `std::time::Instant` is unavailable on wasm32-unknown-unknown.
        // 端到端 Worker/UI 延迟由 TypeScript 宿主测量；引擎内部的可选 metric 必须
        // 保持确定性，不能让后台 analysis pump panic。
        #[cfg(target_arch = "wasm32")]
        let elapsed_micros = 0;
        let sequence = old_sequence
            .checked_add(1)
            .ok_or(EngineError::AnalysisStale)?;

        match event {
            Ok(Some((queue_id, target_revision, progress)))
                if queue_id == expected_queue_id
                    && target_revision == self.revision
                    && !progress.complete =>
            {
                let confirmed_ranges = vec![progress.confirmed_range];
                let dirty_ranges =
                    Self::dirty_suffix(progress.confirmed_range.to, self.text.utf16_len());
                if let SyntaxState::Partial {
                    sequence: current_sequence,
                    confirmed_ranges: current_confirmed,
                    dirty_ranges: current_dirty,
                    ..
                } = &mut self.syntax_state
                {
                    *current_sequence = sequence;
                    *current_confirmed = confirmed_ranges.clone();
                    *current_dirty = dirty_ranges.clone();
                }
                let update = AnalysisUpdate {
                    analysis_id: analysis_id.clone(),
                    target_revision: self.revision,
                    sequence,
                    confirmed_ranges,
                    dirty_ranges,
                    syntax: None,
                    diagnostics: DiagnosticPatch::default(),
                    metrics: Self::metrics(progress, elapsed_micros, true),
                };
                Ok((self.analysis_state(revision)?, Some(update)))
            }
            Ok(Some((queue_id, target_revision, progress)))
                if queue_id == expected_queue_id
                    && target_revision == self.revision
                    && progress.complete =>
            {
                let SyntaxState::Partial { prefix, .. } = &self.syntax_state else {
                    return Err(EngineError::AnalysisStale);
                };
                // One final owned snapshot, instead of one whole-prefix copy per tick.
                let snapshot = prefix.clone();
                let syntax =
                    Self::analysis_syntax_summary(&snapshot, progress, old_projection_blocks);
                self.current_queue_id = None;
                self.syntax_state = SyntaxState::Complete {
                    revision: self.revision,
                    analysis_id: analysis_id.clone(),
                    sequence,
                    snapshot,
                };
                let update = AnalysisUpdate {
                    analysis_id: analysis_id.clone(),
                    target_revision: self.revision,
                    sequence,
                    confirmed_ranges: vec![TextRange::new(0, self.text.utf16_len())],
                    dirty_ranges: Vec::new(),
                    syntax: Some(syntax),
                    diagnostics: DiagnosticPatch::default(),
                    metrics: Self::metrics(progress, elapsed_micros, false),
                };
                Ok((self.analysis_state(revision)?, Some(update)))
            }
            Ok(Some(_)) | Ok(None) => Err(EngineError::AnalysisStale),
            Err(error) => {
                let old_prefix = match &self.syntax_state {
                    SyntaxState::Partial { prefix, .. } => Some(prefix.clone()),
                    _ => None,
                };
                let old_dirty = match &self.syntax_state {
                    SyntaxState::Partial { dirty_ranges, .. } => dirty_ranges.clone(),
                    _ => Vec::new(),
                };
                self.analysis_queue.clear();
                self.current_queue_id = None;
                let failure = AnalysisFailure {
                    code: AnalysisFailureCode::ParseFailed,
                    message: format!("analysis failed: {error:?}"),
                    recoverable: true,
                };
                self.syntax_state = SyntaxState::Failed {
                    revision: self.revision,
                    analysis_id: analysis_id.clone(),
                    sequence,
                    prefix: old_prefix,
                    dirty_ranges: old_dirty,
                    failure,
                };
                Ok((self.analysis_state(revision)?, None))
            }
        }
    }

    pub fn reprioritize_analysis(
        &mut self,
        revision: Revision,
        analysis_id: &AnalysisId,
        priority: &AnalysisPriority,
    ) -> Result<AnalysisState, EngineError> {
        self.require_analysis(revision, analysis_id)?;
        Self::validate_analysis_priority(&self.text, priority)?;
        if !matches!(self.syntax_state, SyntaxState::Partial { .. }) {
            return self.analysis_state(revision);
        }
        let Some(queue_id) = self.current_queue_id else {
            return Err(EngineError::AnalysisStale);
        };
        let target =
            Self::priority_target(priority, self.text.utf16_len()).unwrap_or(self.text.utf16_len());
        if !self.analysis_queue.reprioritize(queue_id, target) {
            return Err(EngineError::AnalysisStale);
        }
        self.analysis_state(revision)
    }

    pub fn cancel_analysis(
        &mut self,
        revision: Revision,
        analysis_id: &AnalysisId,
        reason: AnalysisCancelReason,
    ) -> Result<AnalysisState, EngineError> {
        self.require_analysis(revision, analysis_id)?;
        let SyntaxState::Partial {
            prefix,
            dirty_ranges,
            ..
        } = &self.syntax_state
        else {
            return self.analysis_state(revision);
        };
        let prefix = prefix.clone();
        let dirty_ranges = dirty_ranges.clone();
        let sequence = self
            .syntax_state
            .sequence()
            .checked_add(1)
            .ok_or(EngineError::AnalysisStale)?;
        if let Some(queue_id) = self.current_queue_id.take() {
            self.analysis_queue.cancel(queue_id);
        }
        self.syntax_state = SyntaxState::Cancelled {
            revision: self.revision,
            analysis_id: analysis_id.clone(),
            sequence,
            prefix: Some(prefix),
            dirty_ranges,
            reason,
        };
        self.analysis_state(revision)
    }

    /// 只提交基于当前修订的编辑。文本、修订和语法状态一起更新。
    /// 传入分析预算时，可以先确认文本，再由后台队列补齐语法树。
    pub fn apply_transaction(
        &mut self,
        transaction: &DocumentTransaction,
    ) -> Result<DocumentPatch, EngineError> {
        if transaction.base_revision != self.revision {
            return Err(EngineError::RevisionMismatch {
                expected: self.revision,
                actual: transaction.base_revision,
            });
        }
        let next_revision = self
            .revision
            .checked_next()
            .ok_or(EngineError::RevisionOverflow)?;
        let (removed_text, inserted_text) = if let [edit] = transaction.edits.as_slice() {
            (self.text.slice(edit.range)?, edit.insert.as_str())
        } else {
            (String::new(), "\n")
        };
        let mut next_text = self.text.clone();
        let change = next_text.apply(transaction)?;
        let old_projection_blocks = self.projected_block_count();

        if let Some(request) = &transaction.analysis {
            Self::validate_analysis_request(&next_text, request)?;
        }
        // 先验证新修订的解析代次，再改写原树。同步解析和按预算提交共用这一步。
        let next_analysis_generation = self.next_analysis_generation()?;
        if transaction.edits.len() == 1 {
            let in_place = match self.syntax_state.complete_snapshot_mut() {
                Some(previous) => {
                    let local = syntax::try_reparse_inline_in_place(
                        previous,
                        &self.text,
                        &next_text,
                        change.range,
                        &removed_text,
                        inserted_text,
                        &self.profile,
                    )?;
                    match local {
                        Some(result) => Some(result),
                        None => syntax::try_reparse_table_row_window_in_place(
                            previous,
                            &self.text,
                            &next_text,
                            change.range,
                            &self.profile,
                        )?,
                    }
                }
                None => None,
            };
            if let Some(incremental) = in_place {
                let snapshot = self
                    .syntax_state
                    .complete_snapshot()
                    .ok_or(ParseError::InvalidParserState)?;
                let syntax = Self::in_place_incremental_syntax_summary(snapshot, &incremental);
                let base_revision = self.revision;
                self.text = next_text;
                self.revision = next_revision;
                self.analysis_generation = next_analysis_generation;
                self.install_complete_in_place(next_revision);
                return Ok(DocumentPatch {
                    transaction_id: transaction.id.clone(),
                    base_revision,
                    revision: next_revision,
                    changed_text_range: change.range,
                    syntax: Some(syntax),
                    diagnostics: DiagnosticPatch::default(),
                });
            }
        }
        if let Some(request) = &transaction.analysis {
            if transaction.edits.len() == 1
                && let Some(previous) = self.syntax_state.complete_snapshot()
                && let Some(incremental) = syntax::try_reparse_fast(
                    previous,
                    &self.text,
                    &next_text,
                    change.range,
                    &removed_text,
                    inserted_text,
                    &self.profile,
                )?
            {
                let syntax = Self::incremental_syntax_summary(&incremental);
                let base_revision = self.revision;
                self.text = next_text;
                self.revision = next_revision;
                self.analysis_generation = next_analysis_generation;
                self.install_complete(next_revision, incremental.snapshot);
                return Ok(DocumentPatch {
                    transaction_id: transaction.id.clone(),
                    base_revision,
                    revision: next_revision,
                    changed_text_range: change.range,
                    syntax: Some(syntax),
                    diagnostics: DiagnosticPatch::default(),
                });
            }
            let fenced_opener = syntax::block::fenced_opener_for_closer_in_range(
                &next_text,
                change.range.after,
                &self.profile,
            )?;
            let math_opener =
                syntax::block::math_opener_for_closer_in_range(&next_text, change.range.after)?;
            let checkpoint = self.checkpoint_for_change(
                change.range,
                fenced_opener.into_iter().chain(math_opener).min(),
            );
            let prepared = Self::prepare_session(&next_text, &self.profile, request, checkpoint);
            let base_revision = self.revision;
            self.text = next_text;
            self.revision = next_revision;
            self.analysis_generation = next_analysis_generation;
            let mut completed_progress = None;
            match prepared {
                Ok((session, progress)) => {
                    completed_progress = progress.complete.then_some(progress);
                    let priority_to =
                        Self::remaining_priority_target(request, &progress, self.text.utf16_len());
                    self.install_session(next_revision, session, progress, priority_to);
                }
                Err(error) => {
                    self.analysis_queue.clear();
                    self.current_queue_id = None;
                    self.syntax_state = SyntaxState::Failed {
                        revision: next_revision,
                        analysis_id: Self::format_analysis_id(
                            &self.id,
                            next_revision,
                            self.analysis_generation,
                        ),
                        sequence: 0,
                        prefix: None,
                        dirty_ranges: Self::dirty_suffix(0, self.text.utf16_len()),
                        failure: AnalysisFailure {
                            code: AnalysisFailureCode::ParseFailed,
                            message: format!("initial analysis failed: {error:?}"),
                            recoverable: true,
                        },
                    };
                }
            }
            let syntax = self.syntax_state.complete_snapshot().map(|snapshot| {
                completed_progress.map_or_else(
                    || {
                        Self::full_syntax_summary(
                            snapshot,
                            TextRange::new(0, self.text.utf16_len()),
                            old_projection_blocks,
                        )
                    },
                    |progress| {
                        Self::analysis_syntax_summary(snapshot, progress, old_projection_blocks)
                    },
                )
            });
            return Ok(DocumentPatch {
                transaction_id: transaction.id.clone(),
                base_revision,
                revision: next_revision,
                changed_text_range: change.range,
                syntax,
                diagnostics: DiagnosticPatch::default(),
            });
        }

        let (snapshot, syntax_summary) =
            if let Some(previous) = self.syntax_state.complete_snapshot() {
                let incremental = syntax::reparse_change(
                    previous,
                    &self.text,
                    &next_text,
                    change.range,
                    &removed_text,
                    inserted_text,
                    &self.profile,
                )?;
                let summary = Self::incremental_syntax_summary(&incremental);
                (incremental.snapshot, summary)
            } else {
                let snapshot = syntax::parse(&next_text, &self.profile)?;
                let summary = Self::full_syntax_summary(
                    &snapshot,
                    TextRange::new(0, next_text.utf16_len()),
                    old_projection_blocks,
                );
                (snapshot, summary)
            };

        let base_revision = self.revision;
        self.text = next_text;
        self.revision = next_revision;
        self.analysis_generation = next_analysis_generation;
        self.install_complete(next_revision, snapshot);
        Ok(DocumentPatch {
            transaction_id: transaction.id.clone(),
            base_revision,
            revision: next_revision,
            changed_text_range: change.range,
            syntax: Some(syntax_summary),
            diagnostics: DiagnosticPatch::default(),
        })
    }

    pub fn project(&self, request: &ProjectionRequest) -> Result<RenderPatch, EngineError> {
        self.require_revision(request.revision)?;
        Ok(match &self.syntax_state {
            SyntaxState::Complete { snapshot, .. } => projection::project(
                self.id.clone(),
                self.revision,
                &self.text,
                snapshot,
                request,
            ),
            SyntaxState::Partial {
                prefix,
                dirty_ranges,
                ..
            }
            | SyntaxState::Cancelled {
                prefix: Some(prefix),
                dirty_ranges,
                ..
            }
            | SyntaxState::Failed {
                prefix: Some(prefix),
                dirty_ranges,
                ..
            } => projection::project_partial(
                self.id.clone(),
                self.revision,
                &self.text,
                prefix,
                dirty_ranges,
                request,
            ),
            SyntaxState::Cancelled { .. } | SyntaxState::Failed { .. } => {
                projection::project_source_fallback(
                    self.id.clone(),
                    self.revision,
                    &self.text,
                    request,
                )
            }
        })
    }

    pub fn snapshot(&self, revision: Revision) -> Result<TextSnapshot, EngineError> {
        self.require_revision(revision)?;
        Ok(TextSnapshot {
            document_id: self.id.clone(),
            revision: self.revision,
            text: self.text.snapshot(),
            line_endings: self
                .text
                .line_endings()
                .iter()
                .copied()
                .map(Into::into)
                .collect(),
        })
    }

    fn install_session(
        &mut self,
        revision: Revision,
        session: SyntaxAnalysisSession,
        progress: AnalysisProgress,
        priority_to: Option<u32>,
    ) {
        let analysis_id = Self::format_analysis_id(&self.id, revision, self.analysis_generation);
        if progress.complete {
            let snapshot = session
                .completed_snapshot()
                .expect("a complete analysis session must contain a snapshot");
            self.analysis_queue.clear();
            self.current_queue_id = None;
            self.syntax_state = SyntaxState::Complete {
                revision,
                analysis_id,
                sequence: 0,
                snapshot,
            };
        } else {
            let prefix = session.prefix_snapshot();
            let queue_id = self.analysis_queue.enqueue_latest(
                self.analysis_generation,
                revision,
                session,
                priority_to,
            );
            self.current_queue_id = Some(queue_id);
            self.syntax_state = SyntaxState::Partial {
                revision,
                analysis_id,
                sequence: 0,
                prefix,
                confirmed_ranges: vec![progress.confirmed_range],
                dirty_ranges: Self::dirty_suffix(
                    progress.confirmed_range.to,
                    self.text.utf16_len(),
                ),
            };
        }
    }

    fn install_complete(&mut self, revision: Revision, snapshot: SyntaxSnapshot) {
        self.analysis_queue.clear();
        self.current_queue_id = None;
        self.syntax_state = SyntaxState::Complete {
            revision,
            analysis_id: Self::format_analysis_id(&self.id, revision, self.analysis_generation),
            sequence: 0,
            snapshot,
        };
    }

    fn install_complete_in_place(&mut self, revision: Revision) {
        self.analysis_queue.clear();
        self.current_queue_id = None;
        let analysis_id = Self::format_analysis_id(&self.id, revision, self.analysis_generation);
        let SyntaxState::Complete {
            revision: state_revision,
            analysis_id: state_analysis_id,
            sequence,
            ..
        } = &mut self.syntax_state
        else {
            unreachable!("in-place table update requires a complete syntax snapshot");
        };
        *state_revision = revision;
        *state_analysis_id = analysis_id;
        *sequence = 0;
    }

    fn prepare_session(
        text: &TextBuffer,
        profile: &CompiledSyntaxProfile,
        request: &AnalysisRequest,
        checkpoint: Option<SyntaxCheckpoint>,
    ) -> Result<(SyntaxAnalysisSession, AnalysisProgress), EngineError> {
        let mut session = match checkpoint {
            Some(checkpoint) => {
                SyntaxAnalysisSession::from_checkpoint(text, profile.clone(), checkpoint)?
            }
            None => SyntaxAnalysisSession::from_text(text, profile.clone())?,
        };
        let budget = Self::work_budget(request.initial_budget);
        let target = Self::priority_target(&request.priority, text.utf16_len());
        let progress = match target {
            Some(to) if to > 0 => session.poll_priority(TextRange::new(0, to), budget)?,
            _ => session.poll(budget)?,
        };
        Ok((session, progress))
    }

    fn resumable_checkpoint(&self) -> Option<SyntaxCheckpoint> {
        match &self.syntax_state {
            SyntaxState::Cancelled {
                prefix: Some(prefix),
                ..
            }
            | SyntaxState::Failed {
                prefix: Some(prefix),
                ..
            } => Some(SyntaxCheckpoint::after_prefix(prefix)),
            _ => None,
        }
    }

    fn checkpoint_for_change(
        &self,
        change: editor_protocol::ChangedTextRange,
        forced_from: Option<u32>,
    ) -> Option<SyntaxCheckpoint> {
        let delta = i64::from(change.after.to - change.after.from)
            - i64::from(change.before.to - change.before.from);
        // An opener may extend the dirty range backwards, never move its start
        // forwards past text changed by the same replacement transaction.
        let forced_from = forced_from.map(|from| from.min(change.before.from));
        match &self.syntax_state {
            SyntaxState::Complete { snapshot, .. } => Some(
                (match forced_from {
                    Some(from) => SyntaxCheckpoint::for_change(
                        snapshot,
                        TextRange::new(from, change.before.to.max(from)),
                        delta,
                    ),
                    None => SyntaxCheckpoint::for_structural_change(snapshot, change.before, delta),
                })
                .with_stable_identities(snapshot, &self.text, change),
            ),
            SyntaxState::Partial { prefix, .. }
            | SyntaxState::Cancelled {
                prefix: Some(prefix),
                ..
            }
            | SyntaxState::Failed {
                prefix: Some(prefix),
                ..
            } if forced_from.unwrap_or(change.before.from) >= prefix.root().source_range.to => {
                // The first unconfirmed line can become a continuation of
                // the last confirmed item after an indentation edit. Revisit
                // that root rather than freezing its previous ownership.
                let last = prefix
                    .root()
                    .children
                    .last()
                    .and_then(|id| prefix.node(*id));
                let revisit = last.filter(|last| {
                    syntax::block::list_continuation_sensitive(&self.text, change.before)
                        || (matches!(last.kind, syntax::NodeKind::Table { .. })
                            && last.source_range.to.checked_add(1)
                                == Some(prefix.root().source_range.to)
                            && forced_from.is_none())
                });
                if let Some(last) = revisit {
                    Some(
                        SyntaxCheckpoint::before(prefix, last.source_range.from)
                            .with_stable_identities(prefix, &self.text, change),
                    )
                } else {
                    Some(SyntaxCheckpoint::after_prefix(prefix))
                }
            }
            SyntaxState::Partial { prefix, .. }
            | SyntaxState::Cancelled {
                prefix: Some(prefix),
                ..
            }
            | SyntaxState::Failed {
                prefix: Some(prefix),
                ..
            } => Some(
                SyntaxCheckpoint::before(prefix, forced_from.unwrap_or(change.before.from))
                    .with_stable_identities(prefix, &self.text, change),
            ),
            SyntaxState::Cancelled { prefix: None, .. }
            | SyntaxState::Failed { prefix: None, .. } => None,
        }
    }

    fn priority_target(priority: &AnalysisPriority, document_len: u32) -> Option<u32> {
        priority
            .priority_ranges
            .iter()
            .chain(&priority.visible_ranges)
            .chain(priority.active_range.iter())
            .map(|range| range.to)
            .max()
            .map(|to| to.min(document_len))
    }

    fn remaining_priority_target(
        request: &AnalysisRequest,
        progress: &AnalysisProgress,
        document_len: u32,
    ) -> Option<u32> {
        Self::priority_target(&request.priority, document_len)
            .filter(|to| progress.confirmed_range.to < *to)
    }

    fn work_budget(budget: AnalysisWorkBudget) -> WorkBudget {
        WorkBudget::bounded(
            budget.max_source_lines as usize,
            budget.max_blocks as usize,
            budget.max_utf16_units as usize,
        )
    }

    fn metrics(progress: AnalysisProgress, elapsed_micros: u32, yielded: bool) -> AnalysisMetrics {
        AnalysisMetrics {
            processed_source_lines: progress.consumed_source_lines,
            processed_blocks: progress.consumed_blocks,
            processed_utf16_units: progress.consumed_utf16_units,
            elapsed_micros,
            yielded,
        }
    }

    fn projected_block_count(&self) -> u32 {
        match &self.syntax_state {
            SyntaxState::Complete { snapshot, .. } => {
                u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX)
            }
            SyntaxState::Partial {
                prefix,
                dirty_ranges,
                ..
            }
            | SyntaxState::Cancelled {
                prefix: Some(prefix),
                dirty_ranges,
                ..
            }
            | SyntaxState::Failed {
                prefix: Some(prefix),
                dirty_ranges,
                ..
            } => u32::try_from(prefix.block_count())
                .unwrap_or(u32::MAX)
                .saturating_add(u32::from(!dirty_ranges.is_empty())),
            SyntaxState::Cancelled { .. } | SyntaxState::Failed { .. } => {
                u32::from(self.text.utf16_len() > 0)
            }
        }
    }

    fn full_syntax_summary(
        snapshot: &SyntaxSnapshot,
        reparsed_range: TextRange,
        remove_count: u32,
    ) -> SyntaxPatchSummary {
        let total_blocks = u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX);
        SyntaxPatchSummary {
            reparsed_range,
            total_blocks,
            changed_blocks: total_blocks,
            block_changes: vec![BlockRangeChange {
                from_block: 0,
                remove_count,
                inserted: Self::block_metadata_range(snapshot, 0, total_blocks),
            }],
            projection_changes: Vec::new(),
        }
    }

    fn incremental_syntax_summary(incremental: &syntax::IncrementalResult) -> SyntaxPatchSummary {
        SyntaxPatchSummary {
            reparsed_range: incremental.reparsed_range,
            total_blocks: u32::try_from(incremental.snapshot.block_count()).unwrap_or(u32::MAX),
            changed_blocks: incremental.changed_blocks,
            block_changes: vec![BlockRangeChange {
                from_block: incremental.replaced_from,
                remove_count: incremental.removed_blocks,
                inserted: Self::block_metadata_range(
                    &incremental.snapshot,
                    incremental.replaced_from,
                    incremental.changed_blocks,
                ),
            }],
            projection_changes: incremental.projection_changes.clone(),
        }
    }

    fn in_place_incremental_syntax_summary(
        snapshot: &SyntaxSnapshot,
        incremental: &syntax::InPlaceIncrementalResult,
    ) -> SyntaxPatchSummary {
        SyntaxPatchSummary {
            reparsed_range: incremental.reparsed_range,
            total_blocks: u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX),
            changed_blocks: incremental.changed_blocks,
            block_changes: vec![BlockRangeChange {
                from_block: incremental.replaced_from,
                remove_count: incremental.removed_blocks,
                inserted: Self::block_metadata_range(
                    snapshot,
                    incremental.replaced_from,
                    incremental.changed_blocks,
                ),
            }],
            projection_changes: incremental.projection_changes.clone(),
        }
    }

    fn analysis_syntax_summary(
        snapshot: &SyntaxSnapshot,
        progress: AnalysisProgress,
        old_projection_blocks: u32,
    ) -> SyntaxPatchSummary {
        if progress.reused_prefix_blocks == 0 && progress.reused_suffix_blocks == 0 {
            return Self::full_syntax_summary(
                snapshot,
                progress.reparsed_range,
                old_projection_blocks,
            );
        }
        let remove_count = old_projection_blocks
            .saturating_sub(progress.reused_prefix_blocks)
            .saturating_sub(progress.reused_suffix_blocks);
        SyntaxPatchSummary {
            reparsed_range: progress.reparsed_range,
            total_blocks: u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX),
            changed_blocks: progress.parsed_new_blocks,
            block_changes: vec![BlockRangeChange {
                from_block: progress.reused_prefix_blocks,
                remove_count,
                inserted: Self::block_metadata_range(
                    snapshot,
                    progress.reused_prefix_blocks,
                    progress.parsed_new_blocks,
                ),
            }],
            projection_changes: Vec::new(),
        }
    }

    fn block_metadata_range(
        snapshot: &SyntaxSnapshot,
        from: u32,
        count: u32,
    ) -> Vec<BlockMetadata> {
        (from as usize..from.saturating_add(count) as usize)
            .filter_map(|index| snapshot.block(index))
            .map(|node| BlockMetadata {
                id: node.id.0.to_string(),
                kind: node.kind.wire_name(),
                source_range: node.source_range,
                content_version: node.content_version,
            })
            .collect()
    }

    fn dirty_suffix(from: u32, document_len: u32) -> Vec<TextRange> {
        (from < document_len)
            .then(|| TextRange::new(from, document_len))
            .into_iter()
            .collect()
    }

    fn format_analysis_id(
        document_id: &DocumentId,
        revision: Revision,
        generation: u64,
    ) -> AnalysisId {
        AnalysisId(format!("{}:r{}:a{}", document_id.0, revision.0, generation))
    }

    fn next_analysis_generation(&self) -> Result<u64, EngineError> {
        self.analysis_generation
            .checked_add(1)
            .ok_or(EngineError::AnalysisStale)
    }

    fn require_revision(&self, requested: Revision) -> Result<(), EngineError> {
        if requested == self.revision {
            Ok(())
        } else {
            Err(EngineError::RevisionMismatch {
                expected: self.revision,
                actual: requested,
            })
        }
    }

    fn require_analysis(
        &self,
        revision: Revision,
        analysis_id: &AnalysisId,
    ) -> Result<(), EngineError> {
        self.require_revision(revision)?;
        if analysis_id == self.syntax_state.analysis_id() {
            Ok(())
        } else {
            Err(EngineError::AnalysisNotFound)
        }
    }

    fn validate_analysis_request(
        text: &TextBuffer,
        request: &AnalysisRequest,
    ) -> Result<(), EngineError> {
        Self::validate_work_budget(request.initial_budget)?;
        Self::validate_analysis_priority(text, &request.priority)
    }

    fn validate_work_budget(budget: AnalysisWorkBudget) -> Result<(), EngineError> {
        if budget.max_source_lines == 0 || budget.max_blocks == 0 || budget.max_utf16_units == 0 {
            Err(EngineError::InvalidAnalysisHint)
        } else {
            Ok(())
        }
    }

    fn validate_analysis_priority(
        text: &TextBuffer,
        priority: &AnalysisPriority,
    ) -> Result<(), EngineError> {
        let document_len = text.utf16_len();
        let valid = priority
            .priority_ranges
            .iter()
            .chain(&priority.visible_ranges)
            .chain(priority.active_range.iter())
            .all(|range| {
                range.is_ordered() && range.to <= document_len && text.slice(*range).is_ok()
            });
        if valid {
            Ok(())
        } else {
            Err(EngineError::InvalidAnalysisHint)
        }
    }
}

#[cfg(test)]
mod tests {
    use editor_protocol::{
        ConcreteEolKind, NewlinePolicy, ProjectionAxis, ProjectionMode, ProjectionRequest,
        ProjectionSlice, ProjectionWindow, RenderContent, RenderMode, RenderOperation, TextEdit,
        TransactionId, TransactionOrigin,
    };

    use super::*;

    fn transaction(analysis: Option<AnalysisRequest>) -> DocumentTransaction {
        DocumentTransaction {
            id: TransactionId("tx-1".to_owned()),
            base_revision: Revision(0),
            origin: TransactionOrigin::Keyboard,
            edits: vec![TextEdit {
                range: TextRange::new(5, 5),
                insert: "!".to_owned(),
            }],
            newline_policy: NewlinePolicy::Configured {
                eol: ConcreteEolKind::Lf,
            },
            selection_before: None,
            selection_after: None,
            history: Default::default(),
            metadata: None,
            analysis,
        }
    }

    #[test]
    fn commits_a_transaction_against_exactly_one_revision() {
        let mut document =
            EditorDocument::open(DocumentId("doc-1".to_owned()), "hello", Default::default())
                .unwrap();
        let transaction = transaction(None);
        let patch = document.apply_transaction(&transaction).unwrap();
        assert_eq!(patch.base_revision, Revision(0));
        assert_eq!(patch.revision, Revision(1));
        let syntax = patch.syntax.expect("synchronous parse returns syntax");
        assert_eq!(syntax.reparsed_range, TextRange::new(0, 6));
        assert_eq!(document.text().snapshot(), "hello!");
        assert!(matches!(
            document.apply_transaction(&transaction),
            Err(EngineError::RevisionMismatch { .. })
        ));
    }

    #[test]
    fn invalid_post_transaction_analysis_hint_does_not_commit_text() {
        let mut document =
            EditorDocument::open(DocumentId("doc-2".to_owned()), "hello", Default::default())
                .unwrap();
        let invalid = AnalysisRequest {
            priority: AnalysisPriority {
                priority_ranges: vec![TextRange::new(0, 7)],
                ..AnalysisPriority::default()
            },
            ..AnalysisRequest::default()
        };
        assert_eq!(
            document.apply_transaction(&transaction(Some(invalid))),
            Err(EngineError::InvalidAnalysisHint)
        );
        assert_eq!(document.revision(), Revision(0));
        assert_eq!(document.text().snapshot(), "hello");
    }

    #[test]
    fn bounded_open_is_partial_then_polls_to_complete_without_new_revision() {
        let source = (0..40)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 32,
            },
            ..AnalysisRequest::default()
        };
        let mut document = EditorDocument::open_with_analysis(
            DocumentId("partial".to_owned()),
            &source,
            Default::default(),
            &request,
        )
        .unwrap();
        let analysis_id = match document.analysis_state(Revision(0)).unwrap() {
            AnalysisState::Pending { analysis_id, .. } => analysis_id,
            state => panic!("expected pending, got {state:?}"),
        };
        let mut sequences = Vec::new();
        loop {
            let (state, update) = document
                .process_analysis_queue(
                    Revision(0),
                    &analysis_id,
                    AnalysisWorkBudget {
                        max_source_lines: 3,
                        max_blocks: 2,
                        max_utf16_units: 64,
                    },
                )
                .unwrap();
            if let Some(update) = update {
                sequences.push(update.sequence);
            }
            if matches!(state, AnalysisState::Complete { .. }) {
                break;
            }
        }
        assert_eq!(document.revision(), Revision(0));
        assert!(sequences.windows(2).all(|pair| pair[1] == pair[0] + 1));
        assert_eq!(
            document.syntax_state().complete_snapshot(),
            Some(&syntax::parse(document.text(), &document.profile).unwrap())
        );
    }

    #[test]
    fn deferred_transaction_commits_text_before_analysis_completes() {
        let mut document = EditorDocument::open(
            DocumentId("tx-partial".to_owned()),
            "hello",
            Default::default(),
        )
        .unwrap();
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 1,
            },
            ..AnalysisRequest::default()
        };
        let mut transaction = transaction(Some(request));
        transaction.edits[0].insert = "!\none\ntwo\nthree".to_owned();
        let patch = document.apply_transaction(&transaction).unwrap();
        assert_eq!(patch.revision, Revision(1));
        assert!(patch.syntax.is_none());
        assert_eq!(document.text().snapshot(), "hello!\none\ntwo\nthree");
        assert!(matches!(
            document.analysis_state(Revision(1)).unwrap(),
            AnalysisState::Pending { .. }
        ));
    }

    #[test]
    fn deferred_edit_reuses_blocks_before_the_containing_block() {
        let source = (0..80)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut document = EditorDocument::open(
            DocumentId("checkpoint-edit".to_owned()),
            &source,
            Default::default(),
        )
        .unwrap();
        let edit_offset = u32::try_from(source.find("line 60").unwrap() + 5).unwrap();
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 32,
            },
            ..AnalysisRequest::default()
        };
        let mut transaction = transaction(Some(request));
        transaction.edits[0].range = TextRange::new(edit_offset, edit_offset);
        transaction.edits[0].insert = "!".to_owned();
        let old_suffix_id = document
            .syntax_state()
            .complete_snapshot()
            .unwrap()
            .block(61)
            .unwrap()
            .id;
        let patch = document.apply_transaction(&transaction).unwrap();
        let syntax = patch
            .syntax
            .expect("one changed block should converge synchronously");
        assert_eq!(syntax.block_changes[0].from_block, 60);
        assert_eq!(syntax.changed_blocks, 1);
        let SyntaxState::Complete { snapshot, .. } = document.syntax_state() else {
            panic!("the unchanged suffix should be attached immediately")
        };
        assert_eq!(snapshot.block(61).unwrap().id, old_suffix_id);
    }

    #[test]
    fn partial_projection_exposes_confirmed_blocks_and_source_only_dirty_tail() {
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 64,
            },
            ..AnalysisRequest::default()
        };
        let document = EditorDocument::open_with_analysis(
            DocumentId("projection-partial".to_owned()),
            "# heading\nsecond\nthird",
            Default::default(),
            &request,
        )
        .unwrap();
        let patch = document
            .project(&ProjectionRequest {
                revision: Revision(0),
                view_revision: 1,
                slices: vec![ProjectionSlice {
                    parent_id: "0".to_owned(),
                    axis: ProjectionAxis::SyntaxChildren,
                    window: ProjectionWindow::Index {
                        from: 0,
                        to_exclusive: 10,
                    },
                    max_depth: 0,
                    collapsed_headings: Vec::new(),
                }],
                mode: ProjectionMode::Preview,
                active_range: None,
            })
            .unwrap();
        let RenderOperation::ReplaceChildren {
            inserted,
            total_children,
            ..
        } = &patch.operations[0];
        assert_eq!(*total_children, 2);
        assert_eq!(inserted[0].kind, "heading");
        assert_eq!(inserted[0].mode, RenderMode::Preview);
        assert_eq!(inserted[1].kind, "dirty-source");
        assert_eq!(inserted[1].mode, RenderMode::Source);
        assert!(matches!(inserted[1].content, RenderContent::Source));
    }

    #[test]
    fn partial_projection_keeps_a_confirmed_zero_width_blank_line() {
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 2,
                max_blocks: 2,
                max_utf16_units: 64,
            },
            ..AnalysisRequest::default()
        };
        let source = "first\n\nsecond";
        let document = EditorDocument::open_with_analysis(
            DocumentId("projection-partial-blank".to_owned()),
            source,
            Default::default(),
            &request,
        )
        .unwrap();
        let patch = document
            .project(&ProjectionRequest {
                revision: Revision(0),
                view_revision: 1,
                slices: vec![ProjectionSlice {
                    parent_id: "0".to_owned(),
                    axis: ProjectionAxis::SyntaxChildren,
                    window: ProjectionWindow::AroundRange {
                        range: TextRange::new(6, 6),
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
        assert_eq!(inserted[0].source_range, TextRange::new(6, 6));
    }

    #[test]
    fn cancelled_analysis_can_be_rescheduled_with_a_new_id() {
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 16,
            },
            ..AnalysisRequest::default()
        };
        let mut document = EditorDocument::open_with_analysis(
            DocumentId("cancel".to_owned()),
            "one\ntwo\nthree",
            Default::default(),
            &request,
        )
        .unwrap();
        let first_id = document.syntax_state().analysis_id().clone();
        let cancelled = document
            .cancel_analysis(Revision(0), &first_id, AnalysisCancelReason::Requested)
            .unwrap();
        assert!(matches!(
            cancelled,
            AnalysisState::Cancelled { sequence: 1, .. }
        ));
        let restarted = document.schedule_analysis(Revision(0), &request).unwrap();
        assert!(matches!(
            restarted,
            AnalysisState::Pending { ref analysis_id, .. } if analysis_id != &first_id
        ));
    }

    #[test]
    fn reprioritize_command_limits_the_next_large_queue_slice() {
        let source = (0..30)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let request = AnalysisRequest {
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 16,
            },
            ..AnalysisRequest::default()
        };
        let mut document = EditorDocument::open_with_analysis(
            DocumentId("reprioritize".to_owned()),
            &source,
            Default::default(),
            &request,
        )
        .unwrap();
        let analysis_id = document.syntax_state().analysis_id().clone();
        let target = u32::try_from(source.find("line 4").unwrap()).unwrap();
        document
            .reprioritize_analysis(
                Revision(0),
                &analysis_id,
                &AnalysisPriority {
                    priority_ranges: vec![TextRange::new(target, target + 1)],
                    ..AnalysisPriority::default()
                },
            )
            .unwrap();
        let (state, _) = document
            .process_analysis_queue(
                Revision(0),
                &analysis_id,
                AnalysisWorkBudget {
                    max_source_lines: 100,
                    max_blocks: 100,
                    max_utf16_units: 10_000,
                },
            )
            .unwrap();
        let AnalysisState::Pending {
            confirmed_ranges, ..
        } = state
        else {
            panic!("reprioritization should yield near its target")
        };
        assert!(confirmed_ranges[0].to > target);
        assert!(confirmed_ranges[0].to < document.text().utf16_len());
    }

    #[test]
    fn unfinished_initial_priority_is_carried_into_the_background_queue() {
        let source = (0..30)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let target = u32::try_from(source.find("line 5").unwrap()).unwrap();
        let request = AnalysisRequest {
            priority: AnalysisPriority {
                priority_ranges: vec![TextRange::new(target, target + 1)],
                ..AnalysisPriority::default()
            },
            initial_budget: AnalysisWorkBudget {
                max_source_lines: 1,
                max_blocks: 1,
                max_utf16_units: 16,
            },
            ..AnalysisRequest::default()
        };
        let mut document = EditorDocument::open_with_analysis(
            DocumentId("carried-priority".to_owned()),
            &source,
            Default::default(),
            &request,
        )
        .unwrap();
        let analysis_id = document.syntax_state().analysis_id().clone();
        let (state, _) = document
            .process_analysis_queue(
                Revision(0),
                &analysis_id,
                AnalysisWorkBudget {
                    max_source_lines: 100,
                    max_blocks: 100,
                    max_utf16_units: 10_000,
                },
            )
            .unwrap();
        let AnalysisState::Pending {
            confirmed_ranges, ..
        } = state
        else {
            panic!("the first background slice should yield at the priority target")
        };
        assert!(confirmed_ranges[0].to > target);
        assert!(confirmed_ranges[0].to < document.text().utf16_len());
    }
}
