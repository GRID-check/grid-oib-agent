// AUTO-GENERATED from shared/wire/v2.schema.json — do not edit; run `npm run generate:wire`

import { z } from 'zod'

export const emptyValueSchema = z.object({}).strict()

export const answerRetractedSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("answer_retracted").default("answer_retracted"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": emptyValueSchema }).strict()

export const wireSourceSchema = z.object({ "content": z.string(), "file_name": z.union([z.string(), z.null()]).default(null), "number": z.union([z.number().int().gte(1), z.null()]).default(null), "page": z.union([z.number().int(), z.null()]).default(null) }).catchall(z.unknown()).describe("A cited source (``source_entry_to_wire``). ``number`` is its ``[N]`` in the prose.")

export const answerSnapshotSchema = z.object({ "answer_meta": z.union([z.record(z.string(), z.unknown()), z.null()]).describe("Absent: the re-gate dropped the masthead.").default(null), "sources": z.array(wireSourceSchema).optional(), "text": z.string() }).strict().describe("The streamed prose settled (ADR-0066): it REPLACES text, citations and masthead; cards are untouched.")

export const attachSchema = z.object({ "after_seq": z.number().int().gte(0), "conversation_id": z.string().min(1), "turn_id": z.string().min(1), "type": z.literal("attach").default("attach"), "v": z.literal(2).default(2) }).strict().describe("After a reconnect or a reload: replay this turn from ``after_seq`` + 1, then continue live.")

export const cancelTurnSchema = z.object({ "conversation_id": z.string().min(1), "turn_id": z.string().min(1), "type": z.literal("cancel_turn").default("cancel_turn"), "v": z.literal(2).default(2) }).strict().describe("Stop. Authorised: only the asker (or an internal caller) may cancel a turn.")

export const cardValueSchema = z.object({ "card": z.record(z.string(), z.unknown()), "index": z.number().int().gte(0).describe("Position in the terminal's order: `[[card:N]]` is index N-1."), "key": z.string().min(1) }).strict()

export const cardSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("card").default("card"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": cardValueSchema }).strict()

export const cardRefusedValueSchema = z.object({ "index": z.number().int().gte(0) }).strict()

export const cardRefusedSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("card_refused").default("card_refused"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": cardRefusedValueSchema }).strict()

export const citationsRemovedSchema = z.object({ "count": z.number().int().gte(1), "reasons": z.array(z.string()) }).strict()

export const clarificationStepSchema = z.object({ "id": z.string().min(1).max(200), "kind": z.literal("clarification").default("clarification"), "max_turns": z.number().int().gte(1), "scope": z.enum(["chat","deep"]).default("chat") }).strict().describe("The clarify step started: the one row it contributes before its first question.")

export const userMessageSchema = z.object({ "author_name": z.union([z.string(), z.null()]).default(null), "context_only": z.union([z.literal(true), z.null()]).default(null), "conversation_id": z.string().min(1), "data_sources": z.array(z.string()).optional(), "focus_document_id": z.union([z.string(), z.null()]).default(null), "focus_file_name": z.union([z.string(), z.null()]).default(null), "focus_shelf": z.union([z.enum(["session","project","archiv"]), z.null()]).default(null), "focus_version_id": z.union([z.string(), z.null()]).default(null), "focus_version_state": z.union([z.enum(["draft","in_review","changes_requested"]), z.null()]).default(null), "message_id": z.string().min(1).max(128).describe("Becomes the turn_id."), "source_preset": z.union([z.enum(["law","project","office"]), z.null()]).default(null), "text": z.string().min(1), "type": z.literal("user_message").default("user_message"), "v": z.literal(2).default(2) }).strict().describe("A question (or, with ``context_only``, a colleague's line the agent must see but not answer).\n\n``type`` stays ``user_message``: the gateway's per-socket turn limiter\n(``frontends/ui/src/lib/limits/ws-frames.js``) counts turns by it.")

export const textAnswerSchema = z.object({ "text": z.string().min(1) }).strict().describe("A typed answer. \"skip\" is only ever typed.")

export const optionAnswerSchema = z.object({ "option_id": z.string().min(1) }).strict().describe("A chosen option, by the id the ``interaction_request`` gave it.")

export const interactionResponseSchema = z.object({ "answer": z.union([textAnswerSchema, optionAnswerSchema]), "conversation_id": z.string().min(1), "interaction_id": z.string().min(1), "turn_id": z.string().min(1), "type": z.literal("interaction_response").default("interaction_response"), "v": z.literal(2).default(2) }).strict().describe("The asker's answer to an ``interaction_request``: typed text or a chosen option, never both.")

export const clientMessageSchema = z.discriminatedUnion("type", [userMessageSchema, interactionResponseSchema, cancelTurnSchema, attachSchema])

export const heartbeatValueSchema = z.object({ "every_ms": z.number().int().gt(0) }).strict()

export const heartbeatSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("heartbeat").default("heartbeat"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": heartbeatValueSchema }).strict()

export const interactionOptionSchema = z.object({ "id": z.string().min(1), "label": z.string().min(1) }).strict()

export const interactionRequestValueSchema = z.object({ "expires_at": z.number().int().gte(0).describe("Epoch ms; after it the turn ends with RUN_ERROR interaction_expired."), "input": z.enum(["text","choice"]), "interaction_id": z.string().min(1), "options": z.array(interactionOptionSchema).optional(), "placeholder": z.union([z.string(), z.null()]).default(null), "text": z.string() }).strict().describe("The turn is waiting for its asker (``prompt_user_input``): a question, maybe with choices.")

export const interactionRequestSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("interaction_request").default("interaction_request"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": interactionRequestValueSchema }).strict()

export const interactionResolvedValueSchema = z.object({ "interaction_id": z.string().min(1), "outcome": z.enum(["answered","expired","cancelled"]) }).strict()

export const interactionResolvedSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("interaction_resolved").default("interaction_resolved"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": interactionResolvedValueSchema }).strict()

export const keyedCardSchema = z.object({ "card": z.record(z.string(), z.unknown()), "key": z.string().min(1).describe("card_key(card): stable across the live event and the terminal.") }).strict().describe("A card and its identity key, so a card equal to one already drawn keeps its node.")

export const mastheadValueSchema = z.object({ "answer_meta": z.record(z.string(), z.unknown()) }).strict()

export const mastheadSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("masthead").default("masthead"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": mastheadValueSchema }).strict()

export const quoteStampSchema = z.object({ "file_name": z.union([z.string(), z.null()]).default(null), "number": z.union([z.number().int().gte(1), z.null()]).default(null), "page": z.union([z.number().int(), z.null()]).default(null), "punkt": z.union([z.string(), z.null()]).default(null), "status": z.enum(["verbatim","not_found","unchecked"]), "text": z.string().describe("The wording between the quote marks, as the final text writes it."), "title": z.union([z.string(), z.null()]).default(null), "url": z.union([z.string(), z.null()]).default(null) }).strict().describe("The server's check of one quote line ``> „…“ [N]`` (``common/quote_stamps.py``), in document order.\n\n``verbatim`` names the passage that holds the wording and the ``[N]`` it\ncarries (absent for a passage read but not cited); ``not_found`` means no\nretrieved passage holds it; ``unchecked`` means there was nothing to check\nagainst, or the span is too short to mean anything.")

export const rejectedValueSchema = z.object({ "code": z.enum(["auth_expired","conversation_mismatch","duplicate_turn","not_asker","no_pending_interaction","turn_not_found","invalid_message"]), "message": z.union([z.string(), z.null()]).default(null), "of": z.enum(["user_message","interaction_response","cancel_turn","attach"]) }).strict().describe("A client message was refused. Out of band: ``seq == 0``, never replayed, never ends a turn.")

export const rejectedSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("rejected").default("rejected"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": rejectedValueSchema }).strict()

export const retrievalStepSchema = z.object({ "id": z.string().min(1).max(200), "key": z.string(), "kind": z.literal("retrieval").default("retrieval"), "reason": z.union([z.string().max(160), z.null()]).describe("The model's conclusion, verbatim.").default(null), "round": z.number().int().gte(0), "scope": z.enum(["chat","deep"]).default("chat"), "tools": z.array(z.string()).describe("Tool basenames this round called.").optional(), "values": z.record(z.string(), z.string()).optional() }).strict().describe("One announced retrieval round: where it looks, for what, and the model's own conclusion.")

export const runErrorSchema = z.object({ "code": z.enum(["workflow_error","auth_error","interaction_expired"]), "conversation_id": z.string().min(1), "details": z.union([z.string(), z.null()]).default(null), "message": z.string(), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("RUN_ERROR").default("RUN_ERROR"), "v": z.literal(2).default(2) }).strict()

export const runHandoffSchema = z.object({ "run_id": z.string().min(1), "run_message_id": z.string().min(1) }).strict().describe("The run a turn commissioned (ADR-0062) and the message it narrates itself in: both or neither.")

export const turnResultSchema = z.object({ "answer_confidence": z.union([z.enum(["low","medium","high"]), z.null()]).default(null), "answer_confidence_capped_reason": z.union([z.enum(["ungrounded","quote_unverified","normative_claim_uncited","measurement_only","citation_fallback"]), z.null()]).default(null), "answer_confidence_reason": z.union([z.string().max(300), z.null()]).default(null), "answer_meta": z.union([z.record(z.string(), z.unknown()), z.null()]).default(null), "cards": z.array(keyedCardSchema).optional(), "citations_removed": z.union([citationsRemovedSchema, z.null()]).default(null), "escalation_reason": z.union([z.string(), z.null()]).default(null), "job_admission_rejected": z.boolean().default(false), "message_id": z.string().min(1).describe("turn.response.answer_message_id(conversation, turn)."), "quote_stamps": z.array(quoteStampSchema).optional(), "read_sources": z.array(z.record(z.string(), z.unknown())).optional(), "research_truncated": z.boolean().default(false), "retrieval_ledger": z.array(z.record(z.string(), z.unknown())).optional(), "retry_after_seconds": z.union([z.number().int().gte(0), z.null()]).default(null), "routing_decision": z.union([z.enum(["meta","shallow","deep","error"]), z.null()]).default(null), "run": z.union([runHandoffSchema, z.null()]).default(null), "skills_activated": z.array(z.string()).optional(), "skills_hidden": z.array(z.string()).optional(), "sources": z.array(wireSourceSchema).optional(), "text": z.string() }).strict().describe("Everything the finished turn delivers; authoritative, and what the server persists.\n\nIt replaces the text once more and takes back what it omits (a card\nsuppressed, a masthead gated out). The persisted row is built from this\nmodel and nothing else (``aiq_api`` ``persist_turn_result``).")

export const runFinishedSchema = z.object({ "conversation_id": z.string().min(1), "outcome": z.enum(["answered","refused","handed_off","cancelled"]), "result": turnResultSchema, "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("RUN_FINISHED").default("RUN_FINISHED"), "v": z.literal(2).default(2) }).strict()

export const runStartedSchema = z.object({ "conversation_id": z.string().min(1), "message_id": z.string().min(1).describe("The answer's id; the bubble is keyed by it from now on."), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("RUN_STARTED").default("RUN_STARTED"), "v": z.literal(2).default(2) }).strict()

export const skillStepSchema = z.object({ "channel": z.enum(["live","technical"]).default("live"), "count": z.union([z.number().int().gte(0), z.null()]).describe("`offered`: how many skills the catalog held.").default(null), "hidden": z.boolean().default(false), "id": z.string().min(1).max(200), "kind": z.literal("skill").default("skill"), "phase": z.enum(["offered","activated","loaded"]), "scope": z.enum(["chat","deep"]).default("chat"), "skill": z.union([z.string(), z.null()]).describe("Absent on the per-turn `offered` record.").default(null), "title": z.union([z.string(), z.null()]).default(null) }).strict().describe("A skill was offered (count only), activated or loaded (``skills/events.py``).")

export const traceLaneSourceSchema = z.object({ "detail": z.union([z.string(), z.null()]).describe("Locus, e.g. 'Pkt. 3.5.2 p.12'.").default(null), "name": z.string().min(1).describe("Raw file name: the document identity."), "provenance": z.union([z.record(z.string(), z.string()), z.null()]).describe("Agent authorship keys (ADR-0061).").default(null), "round": z.union([z.number().int().gte(0), z.null()]).describe("The retrieval round that fetched it.").default(null), "shelf": z.union([z.string(), z.null()]).default(null), "title": z.union([z.string(), z.null()]).describe("Display title, omitted when it would repeat `name`.").default(null) }).strict().describe("One document in a lane: identity, the locus that round reached, its shelf.")

export const traceLaneSchema = z.object({ "hit_count": z.number().int().gte(0), "key": z.string().min(1), "kind": z.enum(["baurecht","buero","projekt","web"]), "label": z.string(), "sources": z.array(traceLaneSourceSchema) }).strict().describe("One lane of a search's fan-out: the fine lane and the coarse kind it renders as.")

export const sourcesStepSchema = z.object({ "id": z.string().min(1).max(200), "kind": z.literal("sources").default("sources"), "lanes": z.array(traceLaneSchema), "round": z.union([z.number().int().gte(0), z.null()]).default(null), "scope": z.enum(["chat","deep"]).default("chat"), "tool": z.string().min(1) }).strict().describe("What one evidence tool returned, as lanes. Built from the grounding records, never from text.")

export const stageValueSchema = z.object({ "payload": z.union([z.record(z.string(), z.unknown()), z.null()]).describe("Only on `ready`.").default(null), "stage": z.enum(["follow_ups","memory_reflection"]), "status": z.enum(["ready","empty","failed"]) }).strict().describe("A post-answer stage's outcome (``docs/architecture/post-answer-stages.md`` §4).")

export const stageSchema = z.object({ "conversation_id": z.string().min(1), "name": z.literal("stage").default("stage"), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("CUSTOM").default("CUSTOM"), "v": z.literal(2).default(2), "value": stageValueSchema }).strict()

export const stateSnapshotSchema = z.object({ "conversation_id": z.string().min(1), "seq": z.number().int().gte(0), "snapshot": answerSnapshotSchema, "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("STATE_SNAPSHOT").default("STATE_SNAPSHOT"), "v": z.literal(2).default(2) }).strict()

export const statusStepSchema = z.object({ "channel": z.enum(["live","technical"]).default("live"), "detail": z.record(z.string(), z.union([z.string(), z.number().int(), z.number(), z.boolean(), z.array(z.string())])).describe("Structured detail that is not part of the sentence (counts, reasons).").optional(), "id": z.string().min(1).max(200), "key": z.union([z.string(), z.null()]).describe("i18n id (ALL_STATUS_KEYS); absent on technical records.").default(null), "kind": z.literal("status").default("status"), "scope": z.enum(["chat","deep"]).default("chat"), "slot": z.string().min(1).describe("e.g. 'synthesis', 'budget', 'decision:rerank'."), "values": z.record(z.string(), z.string()).describe("Interpolation values ONLY.").optional() }).strict().describe("A status line or a technical record (``turn_status.emit_status`` and its siblings).")

export const toolStepSchema = z.object({ "id": z.string().min(1).max(200), "kind": z.literal("tool").default("tool"), "scope": z.enum(["chat","deep"]).default("chat"), "status": z.enum(["running","ok","error"]).default("running"), "tool": z.string().min(1) }).strict().describe("A tool call ran: its basename and outcome. Never its arguments or its result.")

export const stepFinishedSchema = z.object({ "conversation_id": z.string().min(1), "seq": z.number().int().gte(0), "step": z.discriminatedUnion("kind", [statusStepSchema, retrievalStepSchema, sourcesStepSchema, toolStepSchema, skillStepSchema, clarificationStepSchema]), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("STEP_FINISHED").default("STEP_FINISHED"), "v": z.literal(2).default(2) }).strict()

export const stepStartedSchema = z.object({ "conversation_id": z.string().min(1), "seq": z.number().int().gte(0), "step": z.discriminatedUnion("kind", [statusStepSchema, retrievalStepSchema, sourcesStepSchema, toolStepSchema, skillStepSchema, clarificationStepSchema]), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("STEP_STARTED").default("STEP_STARTED"), "v": z.literal(2).default(2) }).strict()

export const textMessageContentSchema = z.object({ "conversation_id": z.string().min(1), "delta": z.string().min(1), "message_id": z.string().min(1), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("TEXT_MESSAGE_CONTENT").default("TEXT_MESSAGE_CONTENT"), "v": z.literal(2).default(2) }).strict()

export const textMessageEndSchema = z.object({ "conversation_id": z.string().min(1), "message_id": z.string().min(1), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("TEXT_MESSAGE_END").default("TEXT_MESSAGE_END"), "v": z.literal(2).default(2) }).strict()

export const textMessageStartSchema = z.object({ "conversation_id": z.string().min(1), "message_id": z.string().min(1), "seq": z.number().int().gte(0), "ts": z.number().int().gte(0), "turn_id": z.string().min(1), "type": z.literal("TEXT_MESSAGE_START").default("TEXT_MESSAGE_START"), "v": z.literal(2).default(2) }).strict()

export const wireEventSchema = z.union([z.discriminatedUnion("type", [runStartedSchema, textMessageStartSchema, textMessageContentSchema, textMessageEndSchema, stateSnapshotSchema, stepStartedSchema, stepFinishedSchema, runFinishedSchema, runErrorSchema]), z.discriminatedUnion("name", [mastheadSchema, cardSchema, cardRefusedSchema, answerRetractedSchema, heartbeatSchema, stageSchema, interactionRequestSchema, interactionResolvedSchema, rejectedSchema])])
