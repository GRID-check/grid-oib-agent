# Piloti Feedback Backlog — 2026-07-21 (source: `260721_Feedback_Piloti.md`)

> Fresh triage of colleague ("Piloti") feedback. **Captain/architect model:** the
> orchestrator plans + reviews; exploration (Sonnet/Haiku) and implementation
> (Opus) run in delegated subagents; web research is mandatory for anything not
> current in pretraining (NAT/AIQ, LangGraph, LLM anti-hallucination patterns).
>
> **Triage doctrine (question the feedback):**
> - `SERVER` — attributable to the undersized server; user says a bigger server
>   is coming. **Do not chase.** (e.g. "loses connection to server".)
> - `MODEL` — DeepSeek being a weak LLM (hallucinations). Not "fix the LLM", but
>   *logic* levers exist (stricter grounding, better model routing, verification).
> - `UI` — user will do UI themselves; touch only gradually / when logic is dry.
> - `LOGIC` — real code bug or bad design. **Primary focus.**
> - `PRODUCT` — needs product/spec decision; flag, don't build blind.
>
> Verdicts are re-verified against **current** code (app advances fast) before any
> build. `VERIFY` = a subagent is checking whether the claim still holds.

## Ranked backlog (logic-first)

### P0 — Trust chain / core "it works" bugs (verify, then fix)

- **PB-1 — Deep research aborts ("DeepResearch bricht ab").**  Class: LOGIC.
  Baseline pytest shows **2 hard failures**: `AgentEventCallback._emit_artifact()
  got multiple values for argument 'content'` at
  `frontends/aiq_api/src/aiq_api/jobs/callbacks.py:723`. `source_entry_to_wire`
  always returns a `content` key (`citation_verification.py:994`) and the call
  site passes `content` positionally **and** `**wire` → guaranteed `TypeError`
  on every real citation source. CONFIRMED code bug. Impact: citation-source
  emission crashes in deep research → sources vanish and/or job errors.
  Status: **CONFIRMED, ready to fix.**

- **PB-2 — Sources missing in the output card ("Teilweise fehlen Quellen").**
  Class: LOGIC. Likely same root cause as PB-1 (citation artifacts crash before
  emit) plus KB/RIS sources not entering the SSE citation pipeline. Status:
  VERIFY (agents: trust-chain, deep-research).

- **PB-3 — "Ask Your Data" (Büroarchiv + Projektunterlagen durchsuchen) doesn't
  work.**  Class: LOGIC/VERIFY. Core beta promise. Check the RAG retrieval path
  end-to-end for project + Archiv collections; question whether it's a real bug,
  a scope/permission gap, or config. Status: VERIFY (agent: rag-lifecycle).

- **PB-4 — Indexing/Tagging of uploaded documents doesn't work.**  Class:
  LOGIC/VERIFY. Recent SeaweedFS migration + storageKey rename are prime
  suspects. Check ingest → summary → tags path. Status: VERIFY (agent: rag).

- **PB-5 — Archiv upload not possible ("Hochladen … noch nicht möglich").**
  Class: LOGIC/VERIFY. Recent `fix(archiv): reference renamed storageKey`
  suggests churn here. Verify the Archiv ingest dispatch end-to-end. Status:
  VERIFY (agent: rag).

- **PB-6 — Uploaded files can't be deleted ("lassen sich … nicht mehr
  löschen").**  Class: LOGIC/VERIFY. Check the document-delete BFF route +
  service + storage delete. Status: VERIFY (agent: rag).

### P1 — Output quality logic (not "fix DeepSeek", but real levers)

- **PB-7 — Hallucinated citations in Baurecht answers.**  Class: MODEL+LOGIC.
  User: fabricated quotes on real sections; Opus is correct on the same
  question. Logic levers: stricter citation-faithfulness verification (verify
  the *quoted text* actually exists in the cited passage, not just that the
  section exists), grounding guard, model routing. Needs WEB RESEARCH on 2026
  citation-faithfulness patterns for weak models. Status: VERIFY + RESEARCH.

- **PB-8 — Result card too long / repeats project parameters / says
  "Empfehlung".**  Class: LOGIC (prompt + post-processing). Baurecht "Empfehlung"
  wording is a liability concern. Verbosity + param-repetition is a prompt/render
  concern. Status: VERIFY (agent: researcher-pipeline / prompts).

- **PB-9 — Confidence score is hard to understand; needs a reason.**  Class:
  LOGIC (+small UI). Surface a short justification for the confidence level.
  The chip exists (FB-6 history); extend the signal to carry a reason. Status:
  VERIFY.

- **PB-10 — Clarifying questions ("Rückfragen") not asked before answering.**
  Class: LOGIC/VERIFY. Feedback says Piloti doesn't ask for missing parameters
  first; prior backlog claims the clarifier is "done". Question it — is it wired
  but not triggering? Status: VERIFY.

### P2 — Data / adapters

- **PB-11 — RIS API adapter connection often lost.**  Class: SERVER? / LOGIC?
  Could be network (server) or missing retry/resilience/caching in the RIS
  adapter. Verify adapter resilience (timeouts, retries, cache fail-open).
  Status: VERIFY.

- **PB-12 — WBTV Wien not retrievable (RIS holds annex texts as titles only, not
  full text).**  Class: DATA/PRODUCT. The full annex text must be deposited in
  the norm registry / base corpus. Flag: needs the source documents. Status:
  PRODUCT (data acquisition), but check the norm-registry mechanism.

- **PB-13 — Finer data-source selection (only OIB / only a specific
  Landesbauordnung).**  Class: LOGIC/FEATURE, "keine Prio". Relates to source
  scoping + FB-5 web allowlist. Status: BACKLOG (low prio).

### P3 — Identity / localization

- **PB-14 — System-prompt identity too narrow ("OIB Research Agent").**  Class:
  LOGIC/CONTENT. Broaden to: AI assistant for internal office knowledge, Baurecht,
  and technical guidelines. Small, high-visibility. Status: VERIFY (find prompt).

- **PB-15 — Project Briefing stays English even after switching to German.**
  Class: LOGIC (i18n). The AI-generated briefing/summary likely ignores the UI
  locale. Find the generation path; pass language. Status: VERIFY.

### P4 — Vision / plan understanding (mostly MODEL + heavy)

- **PB-16 — Plan/Vision understanding is rudimentary; corrupt text output; reads
  legend not the graphic.**  Class: MODEL + LOGIC. Partly VLM quality (server/
  model), partly logic (watermark/garbage text leaking into summaries — there is
  an `AIQ_RENDER_VISUAL_PAGES` path). Check the corrupt-text leak specifically;
  the rest is model/product. Status: VERIFY (corrupt-text leak only) + PRODUCT.

### Deferred — UI (user owns) / PRODUCT / SERVER
- UI: header/typo unification, chat centering, top buttons, border removal, logo,
  color-coding off-topic vs Baurecht, decision-chain animation, larger preview,
  Archiv nav "back to project", role explainer text. → **user owns UI**; revisit
  gradually only if logic backlog empties.
- Citation/quote **click-through preview** (open source, show cited table/section):
  structured locators exist (FB-4 history) — verify end-to-end; the *viewer* is
  UI. Logic part (locators on the wire) may need a fix → folded into PB-2.
- SERVER: connection loss, 60–180s latency (partly config → PB-17 if a logic
  lever appears).
- PRODUCT: Wizard entry questions redesign, Bebauungsplan vision extraction,
  decision-path cards, upload cost/limits, Workflows.

## Sprint log
See `feedback_piloti_log.md`.
