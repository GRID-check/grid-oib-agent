# The Langfuse contract

**Langfuse is Piloti's observability platform** ([ADR-0089](../adr/0089-langfuse-is-the-observability-platform-and-everything-is-observable.md)).
Everything the product does with a model, every agent step and every quality
check lands there, and we improve the product from what it shows. This page is
the contract: what every trace carries, which scores exist, what Langfuse
itself is configured with, and what a change must do to keep all of it true.

We are actively working on this. If you find something the product does that
Langfuse does not show, it is a bug. Fix it or file it, and add it to the open
list in [`langfuse-audit-2026-10.md`](langfuse-audit-2026-10.md).

For the people reading the data rather than producing it (business analysts,
the Fachbereich): [`analyst-guide.md`](analyst-guide.md).

## What every trace carries

| Field in Langfuse | Where it comes from | Values |
|---|---|---|
| Trace name | `trace_context.trace_name_for_root` (NAT runs), `observed_generation` (auxiliary calls) | `chat-turn`, `research-job`, `conversation-title`, `project-summary`, `consistency-check`, `skill-review`, `lesson-distill`, `feedback-digest`, `cleanup-proposal`, `change-summary`, `revision-visual-compare` (two page images in one vision call, input shown without the pixels; metadata `page`, `prompt_version` and `purpose`, `person` from the compare view or `notice` when Piloti compared a new Fassung on its own, ADR-0130), `look-reading` (the second reader of `look` with a `question`: the office's ingest vision model on the same crop, input shown without the pixels, metadata `prompt_version` and `region`; an ERROR generation when the model could not be reached, and the tool still answers), `filing-fit` (where an upload batch belongs, or a root sort's chunk with `purpose: sort`; metadata `batch_id`, `project_id`, `shelf`, `basis`, and the counts; a decision on the proposal it made is a `piloti-decision` score on its trace, through `proposed_changes.origin_trace_id`), `folder-proposals.map` and `folder-proposals.reduce` (a root sort's new folders: the groups of one chunk, then the merge across them), `folder-card` (one folder's written card in the ingest worker, ADR-0127: the summary model, metadata `collection`, `depth`, `prompt_version`, `documents`, `subfolders`, `mode` (`incremental`: the old card and the diff alone; `full`: the whole folder) and the diff sizes `diff_added`, `diff_removed`, `diff_changed`; a card that only lost documents is pruned without a call and has no generation), `similar-passages` (a retriever, not a generation: `observed_retrieval`), `agent-tool-call` (one MCP tool call on the agent door, or one A2A method, `lib/langfuse/tool-call-trace.ts`: one `TOOL` observation `mcp.<operation>` or `a2a.<operation>`; metadata and tags below) |
| Environment | `APP_ENV`, coerced to Langfuse's alphabet | `production`, … |
| Release | `GRID_GIT_SHA`, the image's commit | the commit hash |
| Session | the conversation id (NAT sets `session.id`) | one session per chat |
| User | the verified WorkOS subject, only with `GRID_TRACE_IDENTITY_ATTRIBUTES=true` | WorkOS user id |
| Observation type | `nat.span.kind` mapped by `trace_context.observation_type` | `agent` (the turn), `generation` (a model call), `tool`, `retriever` (`retrieve.*`), `chain`, `embedding`, `guardrail`, `evaluator` |
| Prompt | `PromptLinkProcessor`, generations only | `piloti-system-static` and its version |
| Usage and cost | `UsageAttributeProcessor` (NAT), `observed_generation` (auxiliary) | input, output, cached and reasoning tokens; the provider's cost when it reports one |

**A trace never holds image bytes.** A page crop reaches the chat model as a `data:image/...;base64,...`
block, and from there it is copied into the tool span's `output.value` and the next generation's
`input.value`. `InlineImageRedactionProcessor` (installed first, always, whatever the redaction policy) rewrites
every such URL in every string attribute of every span to `[image, N chars, sha256:<8>]`; auxiliary calls
go through the same helper, `common/image_redaction.redact_inline_images`. A trace says that an image was
sent, how large and which one, never the customer's drawing.

### A chat turn's root observation

The root (`chat-turn`, type `agent`) is the turn as the reader got it: the
question as input, **the answer text as output**, and the outcome
(`observability/turn_outcome.py`). A failed turn's root is level `ERROR` with
the wire's error code; a turn the asker stopped is `WARNING`.

Trace metadata on the root:

| Key | Meaning |
|---|---|
| `turn_outcome` | `answered`, `refused`, `handed_off`, `cancelled`, `error` |
| `answer_route` | `meta`, `shallow`, `deep`, `error` |
| `answer_confidence`, `answer_confidence_capped` | what the reader saw, and which guard lowered it |
| `answer_sources`, `answer_cards`, `answer_card_types`, `answer_chars` | what the answer contained |
| `citations_removed`, `quotes_verbatim`, `quotes_not_found` | verification outcome, as counts |
| `research_truncated`, `handed_off_to_run`, `skills_activated`, `reasoning_effort` | how the turn ran |
| `error_code` | on a failed turn |
| `usage_llm_calls`, `usage_prompt_tokens`, `usage_completion_tokens`, `usage_total_tokens`, `usage_cost_usd`, `usage_cost_source`, `usage_error` | the turn's whole spend (`usage_rollup`) |
| `answer_dialect` | block census and repairs by kind |
| `answer_kind`, `work_done`, `work_proposed`, `work_blocked`, `work_next` | the answer's `kind` (`work` is an operations turn, ADR-0123), and on a work turn how many lines each section of its report holds |
| `lessons_arm`, `lesson_ids` | the platform-lessons experiment (`turn/context.py`): `treated`, `holdout` or `off`, and the comma-joined ids of the lessons in the digest the turn carried (none on a holdout turn). The holdout is a breakdown on these, not a join to the vote table. Always recorded: neither names a person |
| `ifc_op`, `ifc_outcome`, `ifc_model`, … | what a building-model tool did (`tools/bim/trace.py`) |
| `answer_precedent_sources`, `answer_precedent_projects` | cited sources from another project (ADR-0094), and from how many projects: the office's experience reaching the answer |
| `reference_projects_offered`, `precedent_p`, `reference_prefetch` | the turn's start: how many reference projects the catalog listed, the decision's p(precedent), and whether round 0 searched them on its own (`agents/piloti/register.py`) |
| `reference_fit_scored`, `reference_fit_top`, `reference_fit_fitting` | the reference fit (ADR-0064 use 10): how many catalog lines it scored, the best p(fits), how many moved ahead |
| `organization_id`, `project_id` | the tenant, only with identity attributes on |
| `$posthog_session_id` | the asker's PostHog browser session, only with identity attributes on and a UUIDv7 ([PostHog export](#posthog-export)) |
| `turn_surface` | where the question was asked: `chat`, `review_canvas` (a box drawn on a document, `user_message.focus_region`) or `annotation_thread` (asked in an Anmerkung's thread, `reply_in_thread` with the mark's id). Recorded by the socket for every turn (`record_turn_surface`); both canvas values also carry the tag `surface:review-canvas` |
| `turn_trigger`, `trigger_event_id` | on a turn an event woke, not typed (`user_message.trigger`, the BFF's wake job; ADR-0106): the kind (`thread_mention`, `thread_reply`, `assigned`) and the id of the reply or assignment that woke it. Recorded by the socket (`record_turn_trigger`) with the tag `trigger:<kind>`; absent on a typed turn The trace id's turn is `wakeTurnId(<event id>)`, the same id as the `piloti_wakes` row and the job. A wake that started no turn (a cap, the switch, rights lost, a spent budget) has no model call and so no trace: it is on its `piloti_wakes` row and in the WorkOS audit trail, as `piloti.wake.suppressed` when it was held (`lib/annotations/wake.ts`), as `piloti.wake.ended` when the job was refused or gave up (`lib/annotations/wake-audit.ts`) |
| `steer_count` | on a turn the asker steered: how many of their notes (`steer`, typed while the turn ran) it has read so far, recorded by the agent node each time it reads one (`agent._announce_steer`). With the tag `steered` |
| `thread_reply` | on a turn asked to answer in an Anmerkung's thread (`reply_in_thread`): `replied` (the model called `canvas__reply` on that mark), `skipped` (it did not, so the socket posts the answer in the thread after the turn, `aiq_agent.turn.annotation_reply`), or `skipped_withheld` (it did not, and the conversation drew on a restricted folder, so nothing is posted). Recorded when the turn leaves the canvas (`settle_thread_reply`). The fallback's own post runs after the trace closes and is not an observation; this value is what keeps a model that stops replying in threads visible |
| `focus_region_viewed` | on a turn with a box only: whether a region view (`look` with `region`) ran, read off the turn's image budget (`conversation_register._finished`). `false` is a turn that answered about a drawing it never looked at |

Tags, the trace list's fast filter: `outcome:<…>`, `route:<…>`,
`confidence:<…>`, `capped:<…>`, `citations-removed`, `quote-not-found`,
`research-truncated`, `handed-off`, `error:<code>`, `feature:ifc`,
`feature:cross-project` (a `project_lookup` ran), `feature:canvas` (a canvas
tool ran), `surface:review-canvas` (the question was asked from a document's
review canvas or one of its threads), `steered` (the asker typed a note the
turn read mid-run), `trigger:<kind>` (an event woke the turn),
`reference-prefetch`, `kind:work` (an operations turn's work report),
`cited-precedent`,
`feature:<auxiliary feature>`, `surface:auxiliary`, and `org:<id>` with
identity attributes on. Tags are labels, never ids or text, with the one
exception of the tenant tag.

Each `project_lookup` call (ADR-0094) is also a `retrieve.project_lookup`
retriever observation, as `knowledge_search` is: its input the action and the
body sent (`scope`, `query`, `offset`, `openFoldersOnly`), its output what came
back as data, never passage text: `projects_in_scope`, `projects_searched`,
`next_offset`, the counts of passages, decisions and permit records, each
project named by id and status, and the picked passages by project, file, page
and score, with each pick's `solved` and the pool's `solved_any` and
`injection_flagged` when the hit judge ran (ADR-0064 use 11; `judged: false`
when it did not). A refusal is `{"refused": <code>}`: `no_envelope`, `not_found`,
`audience_changed`, `invalid`, `unreachable` or `invalid_arguments`.

Each „Im Büro behandelt“ search (`POST /v1/collections/similar`) is a root
trace `similar-passages` holding one `retrieve.similar_passages` retriever
observation (`direct_trace.observed_retrieval`, since the route runs outside
NAT): its input the source's collection, file, page and kind, whether it named
a chunk, the length of its text and how many collections were searched; its
output `origin` (`point` or `embedded`), the filter fields (never values) and
the picks by collection, file, chunk, page and score. Metadata: `origin`,
`documents`, `candidates`. No passage text either way.

Each canvas tool (the `canvas` function group, `tools/canvas/`) is a tool
observation of its own (`canvas__room`, `canvas__point`,
`canvas__highlight`, `canvas__marks`, `canvas__mark`, `canvas__update`,
`canvas__delete`, `canvas__reply`), and under it a `canvas.<tool>` step
(`calls.observe`): its input the page, whether a region was asked, how many
marks were sent and whether `open`, which fields an `update` changes; its
output counts and numbers, never the text of a mark, a reply, a note or a
label, nor a person's name: the document id, and `annotations`, `live` and
`by_kind` for `marks`, `proposed` (or `created`) and `pages` for `mark`, the
mark's `number`, the changed `fields`, its `status` and whether the note was
posted (`noted`) for `update`, `number` and `deleted` for `delete`, the mark's
`number` and its `replies` for `reply`, `peers`,
`drafts` and `selected` for `room`, `viewed` for `look`, `ok` for a gesture. A
refusal is `{"refused": <code>}`: `no_envelope`, `unresolved_document`,
`no_document_subject`, `forbidden`, `not_found`, `conflict`, `invalid`,
`assignee_unclear`, `unreachable`, `invalid_arguments`, or `restricted` (a write everyone who opens
the document would see, refused because the conversation drew on a restricted
folder or another project: `tools/canvas/policy.py`). The harness's one call,
taking Piloti's cursor off a document when the turn ends, is a `canvas.leave`
step.

Each steering note the turn reads (`common/steering.py`) is a `turn.steer`
step under the decision that read it: its input the `round` it was read in,
its length in `chars`, how long it `waited_ms` in the inbox and whether it
carried a `region`; its output `applied` and the index `at` it was spliced
into the request. Never the note's words: those are in the generation's input,
masked like the question. A write the model chose before the note arrived and
the turn held back is the technical step `status:steered:<round>` beside
`repeat`, `refused` and `width`.

### A tool call on the agent door

Each MCP tool call at `/api/mcp` (ADR-0122), from an external agent or from
Piloti's own `workspace__*` tools, is a root trace `agent-tool-call` holding one
`TOOL` observation named `mcp.<operation>` (`search-operations`, `call-operation`
is recorded under the operation it ran, `unknown` for a name no operation has:
that is the agent's own text). Each A2A method at `/api/a2a` (ADR-0124) is one
too, its observation `a2a.<operation>` (`piloti-ask-create`, `piloti-ask-get`,
`piloti-ask-cancel`); the polls a blocking call or a stream makes while it
waits are not. A tool call on the platform door at `/api/platform/mcp`
(ADR-0126) is the same trace, observation `mcp.<operation>`, door `platform`.
Metadata on all: `operation`, `domain`, `door`
(`mcp`, `piloti`, `a2a` or `platform`), `mode` (`search` or `tools`; null on the A2A door), `decision` (`run`, `propose`,
`refused`, `confirm` when an outside agent's destructive call was put to the person in their own chat, `declined` when they did not
confirm it, `person_required` when it was not run because it needs the person's yes and the client cannot ask for it), `decision_source` (`elicitation`, only on the round that runs a call the person confirmed), `status` (the route's HTTP status), `duration_ms`, `client_id`.
Level `WARNING` for a 4xx, `ERROR` for a 5xx. Tags: `feature:agent-mcp`,
`door:<door>`, `decision:<decision>`, `error:<status>` on a refusal, and
`org:<id>` with identity attributes on. The session is the conversation when
Piloti made the call, so the call sits beside the turn that asked for it; the
user only with `GRID_TRACE_IDENTITY_ATTRIBUTES=true`. Never the input or the
answer. Posted best-effort through the ingestion API, never awaited by the call
(`lib/langfuse/tool-call-trace.ts`, from `lib/agent-api/telemetry.ts`). No score.

### The project intake run

The reading of a new project's documents (ADR-0111) is a `research-job` trace of
agent type `project_intake` (ADR-0108), not a trace of its own name. The run
writes its facts once, when it ends, in `_record_trace`
(`src/aiq_agent/agents/intake/agent.py`):

| Key | Meaning |
|---|---|
| `intake_ended` | how the run ended: `model` (the model called `finish_intake`), `model_without_finish` (it stopped without that, and the run finished in code), `step_limit`, `time_budget`, `llm_budget` (the organization's usage budget is exhausted), `no_model`, `refused`, `error` or `no_job` |
| `intake_mode` | the mode the intake was read in (`active` unless the intake's needs say otherwise) |
| `intake_documents_read` | how many documents the run opened |
| `intake_suggested` | values recorded as suggestions, which a person will check |
| `intake_corroborated` | values the profile already held, where the run added its evidence |
| `intake_contradictions` | values that differ from the one on the profile, kept beside it for a person |
| `intake_withdrawn` | suggestions the run recorded and then took back itself (`withdraw_values`); a refused withdrawal is counted under `intake_refusals` as `withdraw:<reason>` |
| `intake_finish_held` | whether `finish_intake` held the model's first call once, because decisive needs were open and files unread |
| `intake_refusals` | the refusals the run hit, as comma-joined `reason=count` pairs (`local:<code>`, `local:not-stated`, `refused:<reason>`, `withdraw:<reason>`); absent when there were none |
| `intake_decisive_open` | how many decisive needs were still open when the run ended |
| `intake_progress_reports` | how often the run told the BFF which files it had opened so far (`op: progress`, the setup page's live „x von y gelesen"); each report is also a `project_intake.progress` step span. Zero while documents were opened means the page showed no live count |

A suggestion a person accepts or dismisses is scored `piloti-decision` on this
same trace, with `subject` `intake_suggestion` (see [Scores](#scores)).

### The decision model

Every call of the decision model (Jev, ADR-0064) is a generation named
`decide.<slot>`, nested under whatever step is open (`observability/decision_trace.py`):
`turn`, `reference_fit`, `reference_hits`, `passages`, `rerank`, `plan`,
`document_tags`, `doc_class`, `feedback_causes`, `experience_verify`. Its input
is the question names and how many states were asked, never a state (a state
carries the reader's words); its output is the answers as numbers (one summary
per state, at most 24), the served model, the latency and the provider's usage,
which `UsageAttributeProcessor` stamps as the generation's tokens and cost. A
call that did not run is `{"decided": 0, "skipped": <reason>}`. A `decide_many`
batch is one generation, its usage summed.

## Scores

Every score Piloti, a reviewer or a judge writes is declared once in
`aiq_agent.observability.langfuse_scores.SCORE_DEFINITIONS`. A test fails when
a name is written but not declared, or declared but not listed here.

| Score | Type | Written by | Meaning |
|---|---|---|---|
| `user-feedback` | numeric 0–1 | BFF, on a vote | 1 helpful, 0 not. The mean is the helpful rate |
| `user-feedback-reason` | categorical | BFF, on a down-vote | `inaccurate`, `wrong_source`, `too_slow`, `other` |
| `piloti-decision` | categorical | BFF, on a person's decision | `accepted`, `dismissed`, `undone`: what a person did with a proposal, a proposed mark or an applied change Piloti made in this turn, or with a value a reading of the project's documents suggested (ADR-0111). One score per decision, on the trace of the producing turn (for an intake suggestion, the reading's `research-job` trace); metadata `subject` (`proposal`, `annotation`, `change`, `intake_suggestion`) and `subject_id`. The acceptance rate of Piloti's work |
| `revision-notice` | numeric ≥ 0 | BFF, when a notice of a new Fassung ends (ADR-0130) | How many marks Piloti proposed on its own after comparing a new Fassung with the one it replaces; 0 is „compared, nothing visible". On the trace of the first page's `revision-visual-compare` generation (metadata `purpose: notice`), so no score without a traced call; metadata `notice_id`, `pages_compared`, `pages_changed`. Each mark it proposed is recorded against the notice's thread message, so a person's decision on it is a `piloti-decision` on the same trace: the share accepted is the precision of noticing |
| `document-check` | numeric ≥ 0 | BFF, when a check of a new document ends (ADR-0130) | How many marks Piloti proposed on its own after checking a new document against the project's other documents; 0 is „checked, everything agrees“. On the trace of the headless turn that ran the check (`turn_trigger: new_document`, the check's id as `trigger_event_id`), so no score without a trace; metadata `check_id`. Each mark is a `piloti_changes` row on the turn's answer, so a person's decision on it is a `piloti-decision` on the same trace: the share accepted is the precision of the check |
| `citation-health` | boolean | agent | nothing removed, patched or flagged on this turn |
| `answer-grounded` | boolean | agent | false when sources were retrieved but no citation survived |
| `citations-removed` | numeric | agent | citations verification dropped |
| `quotes-unverified` | numeric | agent | quoted spans no passage holds |
| `retrieval-precision` | numeric 0–1 | agent | share of distinct retrieved sources the answer cited |
| `citation-fallback` | boolean | agent | retired with the single-source fallback (ADR-0125); no longer written, kept so older traces chart |
| `sources-empty` | boolean | agent | a lookup ran and found nothing |
| `answer-confidence` | categorical | agent | `low`, `medium`, `high` as shown |
| `confidence-capped` | categorical | agent | which guard lowered it, or `none` |
| `quotes-verbatim-rate` | numeric 0–1 | agent | checked quote lines held verbatim |
| `quotes-patched` | numeric | agent | misremembered quotes the repair corrected (ADR-0067) |
| `dialect-repairs` | numeric | agent | answer-dialect blocks repaired; 0 is a measurement |
| `card-validity` | categorical | agent | per envelope card that missed its schema: `repaired`, `dropped` |
| `claims-by-class` | categorical | agent | one score per provenance class present in the answer (`quoted`, `cited`, `cited_dropped`, `record`, `action`, `measured`, `observed`, `reasoning`, `model_knowledge`; `common/claim_provenance.py`, ADR-0125); the comment and `metadata.count` say how many sentences |
| `claims-normative-uncited` | numeric | agent | sentences about the law with no quoted or cited passage behind them |
| `look-count` | numeric | agent, at the terminal | looks Piloti made in the turn (ADR-0128), whether or not the answer relies on them; written on every answered chat turn, zero included |
| `looked-before-measurement` | boolean | agent, at the terminal | on a turn whose answer states a value read off a drawing (a value sentence that cites a place a look read, or a drawing region, or repeats a reading): true when Piloti made a region look (not only an overview) at that drawing before it answered. No score on a turn that states no such value |
| `citations-dropped-labelled` | numeric | agent | places the answer cited something that did not resolve (no source, or a § / Punkt the cited passage does not hold), labelled in the text instead of removed |
| `file-tools-used` | categorical | agent, at the terminal | on every turn that called a tool (ADR-0127): as the files eval's arms define them: `search` (`knowledge_search` ranked by meaning, the round-0 prefetch included), `navigate` (`list_files`, `read_passage`, and `knowledge_search` with `match="exact"` or `"regex"`, which the literal search records as a technical `literal-search:*` step), `both` or `none`. The comment lists the moves made. "Do turns ever list or read?" is a query on this score; the tool spans carry the mode (`view`, `match`, `pages`) |
| `folder-card-fresh` | numeric 0–1 | agent, the folder card builder | per builder pass that wrote at least one card (ADR-0127): the share of the claimed folders whose written card is fresh afterwards (built, or unchanged because its input hash matched). The comment counts each outcome (`fresh`, `unchanged`, `stale` over the monthly budget, `failed`, `skipped` for a folder too small for a card). Written on the pass's first `folder-card` generation |
| `steer-count` | numeric | agent, at the terminal | on a steered turn only: the notes the asker typed into it; the comment says how many it read (`applied N`). A note left unread became the next question |
| `work-report-matches` | boolean | agent, at the terminal | on a work turn (`kind: work`, ADR-0123) only: true when the report's `proposed` list is as long as the proposal cards the turn showed. The comment says both counts (`reported N, filed M`). Counted after the unfiled lines below are dropped, so false is mostly a turn that filed a proposal it did not report |
| `work-proposals-unfiled` | numeric | agent | on a work turn only: the report's `proposed` lines whose `ref` named no proposal this turn's workspace writes filed, dropped before the person saw them (`answer_envelope.drop_unfiled_proposals`). Above zero is a turn that claimed a proposal it did not make |
| `thread-answered-in-place` | boolean | agent, when the turn leaves the canvas | on a turn asked to answer in an Anmerkung's thread: true when the model replied there itself (`canvas__reply`), false when it did not and the socket posts the answer for it. No score when the turn may not post there (`thread_reply` = `skipped_withheld`). The false rate is how often the prompt is ignored, which the fallback otherwise hides |
| `review-correctness` | categorical | reviewer, in the queue | `correct`, `partly_correct`, `incorrect` |
| `review-sources` | categorical | reviewer, in the queue | `right_sources`, `missing_sources`, `wrong_sources` |
| `judge-answers-question` | numeric 0–1 | LLM judge | how directly the answer addresses the question |
| `judge-uncited-claims` | boolean | LLM judge | a normative requirement stated without `[N]` |
| `judge-clarity` | categorical | LLM judge | `clear`, `partly_clear`, `unclear` |

Agent scores are posted to `POST /api/public/scores` from a small bounded pool
(`langfuse_scores.emit_scores`); they never block or fail a turn, and a
re-post upserts the same id. The citation scores come from the same outcome
the `citation_events` ledger records, so the ledger's dashboard and Langfuse
agree.

## What Langfuse is configured with

Declared in `aiq_agent.observability.langfuse_catalog`, provisioned by:

```bash
task langfuse:provision              # check: prints what is missing or has drifted
task langfuse:provision -- --apply   # create what is missing (ask first on a shared project)
```

* **Score configs** for every score above, so Langfuse validates values and the
  annotation UI offers the categories.
* **Annotation queue `answer-review`.** Every down-voted answer's trace is added
  by the BFF (`frontends/ui/src/lib/langfuse/feedback-score.ts`). Reviewers
  record `review-correctness` and `review-sources`.
* **LLM-as-a-judge evaluators** `judge-answers-question`, `judge-uncited-claims`
  and `judge-clarity`, and the rule `chat-turn-judges` that runs them on one in
  five answered chat turns' root observations. **The rule is created disabled.**
  Enabling it sends answers to the project's evaluation model: check that the
  LLM connection uses a zero-data-retention endpoint (ADR-0074) before you do.
* **Dataset `golden-questions`**: the answer suite's questions
  (`tests/fixtures/derivation/loop_eval_questions.yaml`) with their expected
  family, Punkt and kind, for experiments that compare prompt or model versions.

The script never changes or deletes what exists; a config that differs is
reported as drift for a person to resolve.

## PostHog export

Traces, generations and scores reach PostHog **only** through Langfuse's own
PostHog integration. Grid sends no `$ai_*` event and no LLM trace or score
to PostHog itself; everything else (product analytics, errors, replay, surveys)
goes to PostHog directly, and this export is what joins the two. The upstream
page is [langfuse.com/integrations/analytics/posthog](https://langfuse.com/integrations/analytics/posthog).

### What is exported

Langfuse's worker, on an hourly schedule, batches events to the PostHog host you
give it:

| Event | One per | Properties that matter to us |
|---|---|---|
| `langfuse observation` | observation of any type (`GENERATION`, `SPAN`, `AGENT`, `TOOL`, `RETRIEVER`, `EVENT`, `CHAIN`, `EMBEDDING`, `EVALUATOR`, `GUARDRAIL`) | `langfuse_type`, `langfuse_observation_name`, `langfuse_trace_id`, `langfuse_trace_name`, `langfuse_model`, `langfuse_cost_usd`, `langfuse_input_units` / `_output_units` / `_total_units`, `langfuse_latency`, `langfuse_level`, `langfuse_tags`, `langfuse_environment`, `langfuse_release`, `langfuse_session_id`, `langfuse_user_id` |
| `langfuse score` | score | `langfuse_score_name`, `_value`, `_string_value`, `_data_type`, `_comment`, `_metadata`, `langfuse_trace_id`, `langfuse_user_id` |

A legacy export source sends `langfuse trace` and `langfuse generation` instead
of `langfuse observation`; scores are the same in every source. No prompt or
answer text is in either event. **Score comments and metadata are**: the
`user-feedback` score's comment carries the voter's own words and what they
expected (`feedback-score.ts`), so those words land in PostHog as
`langfuse_score_comment` and `langfuse_score_metadata`. Langfuse's trace
retention and erasure workers (ADR-0044) do not reach PostHog: an erased
person's events there are removed in PostHog (delete the person with their
events).

Facts to plan around: **nothing is backfilled** (the sync is watermark-based,
and starts when the integration is saved); there is **no filter** by observation
type, name or level on the integration (the only lever is the export source);
and PostHog drops events past the free tier's limit without telling Langfuse.
An upstream issue ([langfuse#12786](https://github.com/langfuse/langfuse/issues/12786))
reports the first sync of a project with a long history sending it all in one
unthrottled burst, against the "nothing is backfilled" line, so save the integration
early or on a project with little history, and watch the first run.

### Which export source

Self-hosted Langfuse has an **Export Source** selector in the integration
settings (introduced with the v4 preview):

| Source | Events | Reads | Works while |
|---|---|---|---|
| Enriched observations (recommended) | `langfuse observation` + `langfuse score` | v4's events table | `langfuse.v4WriteMode` is `dual` or `events_only` |
| Traces and observations (legacy) | `langfuse trace` + `langfuse generation` + `langfuse score` | v3's tables | `legacy` or `dual`; not selectable once legacy writes are off |
| Both | all of the above | | `dual`; duplicates by design, for migration only |

Our deployment writes both tables (`langfuseV4WriteMode` defaults to `dual`,
`deploy/pulumi/src/config.ts`), so either source works today. Upstream moves a
self-hosted deployment on to the enriched source automatically once the server
runs in `events_only`; the switch is one-way.

**Volume.** A chat turn is one `AGENT` root plus a span for every retrieval,
decision-model call, tool call and model call under it, so the enriched source
exports many events per turn and the legacy source one trace plus its
generations. All of them are ordinary PostHog events and count against the
free tier's 1M analytics events a month, not against its AI-observability
allowance. Because there is no filter, the choice is the legacy source (fewer
events, deprecated upstream, gone at `events_only`) or the enriched one (every
observation). Count before you commit: enable it on staging for a week and read
the monthly `langfuse observation` count in PostHog, then decide. The export
never reads a trace's body, so this is the whole cost.

### Identity and the replay link

* `user_id` becomes the event's distinct id, so it must be the WorkOS user id
  PostHog identifies the browser with. That is Langfuse's user, which Grid sets
  only with `GRID_TRACE_IDENTITY_ATTRIBUTES=true`; without it every event is
  `langfuse_unknown_user` and joins to no person.
* `trace.metadata.$posthog_session_id` becomes `$session_id`. Each chat turn
  carries the browser's PostHog session id there:
  `getPosthogSessionId()` (`frontends/ui/src/lib/analytics/posthog.ts`) is read
  per question and sent as `user_message.posthog_session_id`; `_drive` in
  `aiq_api/chat_socket.py` records it with `record_posthog_session`
  (`langfuse_trace_attributes.py`). From a trace, open the same `$session_id`
  in PostHog's replay list.
* It is **identity-gated**, on the rule in that module's header ("no span names a
  person" unless the deployment opts in): a session id names no one alone, but on
  a trace holding the turn's question and answer it is a join key to that person's
  recording and profile. It rides the same switch as the user id, and costs nothing
  real: without the user id the events have no person to land on.
* Only a UUIDv7 is kept, as PostHog generates them; anything else is dropped and
  the turn runs. PostHog rotates the id after 30 idle minutes, so it is read per
  turn.
* The page sends the id only to a server whose hello lists
  `user_message.posthog_session_id` in `accepts`, which is withheld while
  `GRID_WIRE_V2_ADDITIVE_FIELDS` is off. It is on by default; set off, the link is gone.

### How to enable

Langfuse configures this integration in the UI and nowhere else. There is no
environment variable and no `LANGFUSE_INIT_*` for it, and the public API
(`/api/public`) has an integrations endpoint for blob storage only, so
`task langfuse:provision` cannot declare it. Do it by hand, once per Langfuse
project:

1. In Langfuse, open the project, then **Settings -> Integrations -> PostHog**.
2. Set **PostHog Hostname** to the ingestion host (`https://eu.i.posthog.com`,
   the same value as `POSTHOG_HOST`) and **PostHog API key** to the project's
   public token (`POSTHOG_PROJECT_TOKEN`, `phc_...`).
3. Choose the **Export Source** (above), switch **Enabled** on, and save.
   Langfuse encrypts the key with `ENCRYPTION_KEY`, which the Langfuse tier
   sets (`deploy/pulumi/src/platform/langfuse.ts`); a save that fails with an
   internal error means that variable is missing.
4. Wait for the next hourly run. In PostHog, `langfuse observation` appears
   under Data management -> Events; the **AI Metrics** dashboard template is a
   starting point.

Network: the worker calls the PostHog host over HTTPS. Egress from the `grid`
namespace is open (`network-policies.ts`, "Egress is left open on purpose"); only
Gotenberg has an egress policy, so no rule is needed. A spec
(`platform/langfuse.spec.ts`) fails if a policy ever selects the worker with
`Egress`.

## When you change the product

| When you | You must |
|---|---|
| Add a model call inside a NAT run | Nothing: the exporter's processors cover it. Check the generation shows usage in Langfuse |
| Add a model call outside one (a route, a script, a worker) | Wrap it in `observed_generation("<feature>", …)` and add the feature to the trace-name table above. `test_model_calls_are_traced.py` covers `aiq_api` routes |
| Add or change a quality check | Emit a score through `langfuse_scores.emit_scores`, declare it in `SCORE_DEFINITIONS`, add its row here, run `task langfuse:provision` |
| Add a dimension an analyst should slice by | Trace metadata through `record_trace_metadata` (tools) or `turn_outcome` (turn results); a tag only if it is a low-cardinality label |
| Change a judge, the queue or the dataset | Edit `langfuse_catalog.py`, then `task langfuse:provision -- --apply` once it is merged |
| Gate something on identity | Only the user and the tenant. Labels, counts and scores are never behind `GRID_TRACE_IDENTITY_ATTRIBUTES` |

## Where the code is

| Concern | Module |
|---|---|
| Environment, release, types, trace names | `src/aiq_agent/observability/trace_context.py` |
| The processors on NAT's exporter | `src/aiq_agent/observability/langfuse_trace_attributes.py`, installed in `otel_header_redaction_exporter.py` |
| A turn's outcome on its root | `src/aiq_agent/observability/turn_outcome.py`, bound in `aiq_api/chat_socket.py` `_drive` |
| Runtime scores | `src/aiq_agent/observability/langfuse_scores.py` |
| Model calls outside NAT | `src/aiq_agent/observability/direct_trace.py` |
| Langfuse configuration as code | `src/aiq_agent/observability/langfuse_catalog.py`, `scripts/langfuse_provision.py` |
| Votes, reasons, review queue | `frontends/ui/src/lib/langfuse/feedback-score.ts` |
| Decisions on Piloti's proposals, marks and changes | `frontends/ui/src/lib/langfuse/decision-score.ts` |
| Tool calls on the agent door (MCP) | `frontends/ui/src/lib/langfuse/tool-call-trace.ts`, called from `lib/agent-api/telemetry.ts` |
| PostHog session link | `record_posthog_session` in `langfuse_trace_attributes.py`, bound in `aiq_api/chat_socket.py` `_drive`; the browser side is `getPosthogSessionId` in `frontends/ui/src/lib/analytics/posthog.ts` |
| Retention and erasure | `frontends/ui/workers/langfuse-traces.js` ([`deletion-pipeline.md`](../architecture/deletion-pipeline.md)) |
| Deployment | `deploy/pulumi/src/platform/langfuse.ts` ([`kubernetes.md`](../deployment/kubernetes.md) § Langfuse) |
