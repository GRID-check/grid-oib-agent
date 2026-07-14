# Feedback Triage Backlog — colleague feedback, verified against code 2026-07-14

> Working file for the feedback-triage loop. Every colleague feedback item was
> verified against the current codebase (branch `claude/feedback-triage-backlog-ko6517`,
> base `develop` @ `f941822`) by parallel code-research agents before being accepted
> here — the feedback predates a very active week (deep-research hardening PR #56,
> UX system audit rounds 1–8, chat-spinner/reconnect fixes), so several reported
> problems no longer exist. Stale items are recorded in "Already addressed" below
> so nobody re-litigates them.
>
> Ranking criterion: user trust for the three beta promises (safe Baurecht research,
> project research, office-wide detail search) first, then effort-to-value.
> IDs are stable (`FB-n`). Re-triaged every cycle; cycle log at the bottom.

## Verdict summary (feedback → code reality)

| Feedback item | Verdict | Backlog |
|---|---|---|
| Chat image upload broken | Never implemented — chat attach = RAG doc pipeline, `.pdf/.docx/.txt/.md` only; no vision-in-chat path | FB-15 |
| Chat very slow / no answer at all | "No answer" **fixed** Jul 10–13 (terminal error frames, 180s watchdog, reconnect-churn fix). "Slow" structurally plausible (shallow tier runs `reasoning_effort: high`, 65k max_tokens, ≤10 LLM turns) | FB-17 |
| Deep Research doesn't work | **Likely fixed** — 5-commit hardening pass merged 2026-07-14 (PR #56): job lifecycle, SSE resume, retry/citation/language, streaming/replay. Needs one human smoke test | — (smoke test) |
| OIB vector DB not active, "only Web Search" | **Backend fine, UI hides it.** KB is queried on every chat turn (`shallow_researcher/register.py:70-75`, config `knowledge_search`), but `ChatThinking.tsx:66-69` filters `knowledge_layer` out of the displayed sources | FB-1 |
| Source labeling DB vs web | Backend has `source_type` (`citation_verification.py:58-66`); frontend `CitationSource` type and cards never carry/render it; KB citations (no URL) can drop out of source lists entirely | FB-2 |
| Precise citations (trace original text) | Partial — KB tool returns file+page+excerpt (`knowledge_layer/src/register.py:343-385`); no click-through from a chat citation to the original passage | FB-4 |
| Restrict web to "better" sources | Not implemented — Tavily config has no domain allowlist; the domain catalog is topic routing, not site quality, and unused in the active config | FB-5 |
| Status display while AI works | **Done** — `ChatThinking.tsx` shows live working state, per-step tool activity, waiting/interrupted/done states | — |
| "AI can make mistakes" notice | Exists only on `/legal/[slug]` (AI-Act Art. 50 text); nothing near the chat input | FB-3 |
| Design calmer/reduced like prototype (incl. Files) | Largely addressed after feedback date: `docs/design/grid-design-language.md` (2026-07-05) + UX audit rounds 1–8 polished all surfaces incl. Files. Prototype is external → final call needs a human visual diff | — (human check) |
| Sidebar: slim down; Overview → Settings; Members → Settings | Still valid — no project Settings page exists at all; Overview & Members are top-level nav items | FB-9 |
| Research not a tab, but part of chat history ("Deep Research" label) | Still valid — separate `/research` tab + `ResearchRunsList` persists; `SessionsPanel` already shows per-session research status icons (half the work exists) | FB-10 |
| Workflows page | Doesn't exist, no spec | FB-11 (needs product) |
| Archive page ("good knowledge" from past projects) | Doesn't exist; org-scoped Project Memory is an adjacent substrate but panel-only, per-project | FB-12 (needs product) |
| Wizard: plan upload (FWP/BBP) + content verification | Still valid — wizard is pure Q&A, no file input; zoning/deviation fields are self-reported | FB-14 |
| Wizard: revise questions | Ongoing — `intake-definition.ts` is versioned (v2) and actively iterated; need the *specific* question changes from the feedback author | — (needs specifics) |
| Wizard: two-stage final check (AI conflict check + human review) | Still valid — `generate_summary.py` only writes one prose sentence; no conflict validation, no review gate | FB-13 |
| Files: show/edit document labels | Still valid — richer ingestion metadata exists but the BFF strips it ("Internal metadata never leaves the BFF", `documents/service.ts:156-170`); UI shows only status/type/size | FB-8 |
| Files: larger preview | Still valid — Files preview is a fixed 384px pane; the big `PdfViewerDialog` (85vh/95vw) already exists but isn't wired into Files | FB-7 |
| Where is the overview of all Output Cards? | Still valid — cards render only inline in chat/reports; only aggregate is a dev-only fixture page | FB-16 |
| Where is the metadata of uploaded plan documents? | Same gap as FB-8 | FB-8 |
| Confidence score / AI names uncertainty | Backend already computes `confidence: low/medium/high` per shallow answer (`chat_researcher/models/result.py:35`) — used internally for escalation, never shown to the user | FB-6 |
| AI asks follow-up questions when info missing | **Done** — clarifier agent is a live multi-turn dialog, recently fixed (`07251d0`) with frontend keyboard support | — |

## Ranked backlog

### P1 — Chat trust chain (core of beta promise "safe Baurecht research")

- **FB-1 — Make the OIB knowledge base visible as a chat source.** `ChatThinking.tsx:66-69` filters `knowledge_layer` out of the "Selected Data Sources" display, so KB-answered queries look like the KB doesn't exist — the single cheapest fix for the most damaging perception problem in the feedback. Show it, labeled clearly (e.g. "OIB Knowledge Base" / "OIB-Wissensdatenbank"). Effort: S.
- **FB-2 — Label sources: trusted database vs web.** Propagate `source_type` (`knowledge_layer` vs web/generic) from `citation_verification.py` through the WS payload into `CitationSource` (`chat/types.ts:268-275`) and render a badge in `CitationCard`/`SourceCard`; fix `ReportTab.tsx:124-127` so URL-less KB citations still appear in source lists. Effort: M.
- **FB-3 — "AI can make mistakes" notice at the chat input.** Reuse the existing AI-Act Art. 50 wording (short form) from `lib/legal/content/*` under/near `InputArea`, DE+EN, linking to `/legal`. Effort: XS.
- **FB-4 — Citation click-through to the original passage.** KB citations carry file+page; `PdfViewerDialog` already opens corpus PDFs. Wire chat/report KB citations to open the viewer at the cited page. Effort: M.
- **FB-5 — Web source allowlist.** Add `include_domains` (Tavily natively supports it) to `TavilyWebSearchToolConfig` + config plumbing, seeded with a curated AT/Baurecht-quality domain list; keeps the agent off low-quality sites. Effort: S–M.
- **FB-6 — Surface the confidence score.** The shallow agent already sets `low/medium/high` per answer; expose it on the response payload and render a subtle indicator with a "why" tooltip. Effort: M (protocol plumbing).

### P2 — Files quick wins

- **FB-7 — Larger document preview.** Add an expand affordance in `file-preview-pane.tsx` opening the existing `PdfViewerDialog` (85vh/95vw). Effort: S.
- **FB-8 — Show (then edit) document contents/labels.** Stop stripping user-relevant ingestion metadata in `documents/service.ts`; show extracted summary/type/chunk info in the preview pane; second step: editable labels (needs a small API + column). Effort: M (show) + M (edit).

### P3 — Navigation restructure (directionally clear, confirm IA with team)

- **FB-9 — Project Settings page; fold Overview specs & Members into it; slim sidebar.** No Settings page exists today. Create one, move project-spec content (Overview) and Members there, reduce the rail. Note: `app-sidebar.tsx:144-146` documents a deliberate "Members never dead-ends" choice — revisit consciously. Effort: M–L. *Confirm target IA with the team before building.*
- **FB-10 — Merge Research into chat history as "Deep Research".** Remove the separate `/research` tab; `SessionsPanel` already shows per-session research status icons — extend it with a "Deep Research" label/filter and port anything `ResearchRunsList` shows that sessions don't (job status, expiry). Effort: M.

### P4 — Wizard

- **FB-13 — End-of-wizard AI conflict check.** Add a pre-save validation step: LLM checks the intake profile for internal contradictions (e.g. Gebäudeklasse vs floor counts, use vs safety category) and shows findings for the user to confirm/fix — the "human review" half of the feedback is then the user consciously approving. Follows the `generate_summary.py` pattern but blocking-with-override instead of fire-and-forget. Effort: M.
- **FB-14 — Plan upload (Flächenwidmungs-/Bebauungsplan) with extraction + verification.** New extraction pipeline (upload → parse → prefill `widmung` etc. → user confirms each extracted value). Large; scope with the team first (formats? Wien-specific plan layouts?). Effort: L. *Needs product scoping.*

### P5 — Larger features / needs measurement

- **FB-15 — Images in chat (vision).** Whole new path: accept JPG/PNG in chat, forward to a VLM-capable model turn. Today images are rejected client-side and no chat-time vision consumer exists. Effort: L. *Needs product decision on scope (chat-time vision vs. image ingestion into KB).*
- **FB-16 — Output-cards overview page.** Aggregate all cards of a project outside chat context (candidate synergy with FB-12 Archive). Effort: M. *Where should it live? Clarify with team.*
- **FB-17 — Chat latency tuning.** "Hang forever" is fixed; raw speed isn't: shallow tier runs `reasoning_effort: high`, `max_tokens: 65536`, ≤10 LLM turns (`config_oib_openrouter.yml:62-71,270-271`). Candidate: lighter/faster settings for the shallow tier. *Blocked on runtime measurement — config tuning without live latency data is guesswork.*

### Needs product / human decision (not build-ready)

- **FB-11 — Workflows page.** No spec exists; define what a "workflow" is for users first.
- **FB-12 — Archive page** ("good knowledge" from past projects). Org-scoped Project Memory is a substrate, but the product shape (what gets archived, by whom, browse UX) is undefined.
- **Human smoke test:** deep research end-to-end (post-PR #56) and the fixed chat-spinner paths — all verified statically only.
- **Design-vs-prototype visual diff:** prototype is external to the repo; needs eyes.
- **Wizard question specifics:** ask the feedback author *which* questions to change (revision machinery exists).
- **Open questions from the feedback that are org/ops, not code:** upload speed at scale, where pilot-office data lives, policy for "user uses Piloti as a general LLM".

## Already addressed (do not re-litigate; evidence retained)

- **Deep research broken** → 5-commit hardening pass merged 2026-07-14 (`751476d`, `a4e36f6`, `dc756e6`, `0f032a9`, `973a0cb`); runtime smoke test pending.
- **Chat gives no answer** → fixed Jul 10–13: `ee284c2` (terminal `workflow_error` frame + 180s inactivity watchdog), `61a4858` (WS reconnect churn), `f732054`.
- **Status display while AI works** → `ChatThinking.tsx` (live steps, waiting/interrupted/done).
- **AI asks follow-up questions** → clarifier agent, live and recently fixed (`07251d0`).
- **Design calmer/reduced** → design-language spec + UX audit rounds 1–8 (see `ux_audit_log.md`); pending only external-prototype comparison.
- **Wizard questions revised** → `intake-definition.ts` v2, actively iterated (`b97924a`, `4d76307`).

## Cycle log

- **Cycle 0 (2026-07-14):** 7 parallel verification agents ran; this file created. Next: Cycle 1 = FB-1 + FB-3 (chat trust quick wins) and FB-7 (files preview), delegated as parallel implementation tasks on disjoint files.
