# GRID — Feature & Improvement Opportunities

Scouted across the codebase after the stabilization + premium-redesign work. Prioritized by value × (1/effort), with risk noted. The first item is **shipped on this branch**; the rest are a menu.

Legend — Effort: S (hours) / M (day) / L (multi-day). Risk: how likely it needs runtime iteration.

---

## ✅ 1. Applicable OIB Standards panel — SHIPPED (this branch)

From the project brief (main use, building class, floors, escape level) GRID now derives which OIB-Richtlinien are relevant, with a reason drawn from the project's own facts (e.g. *escape level > 22 m → Hochhaus → OIB 2.3*), a source link, and an "Ask Grid" action that seeds a grounded question. Turns the Overview into a compliance cockpit and makes the domain expertise visible on day one. Pure-function applicability engine with unit tests. **Value: high. Effort: M. Risk: low (additive, tested).**

---

## 2. "Run a compliance check" — one-click deep research over applicable standards
**Value: very high. Effort: M. Risk: medium.**
Natural next step on top of #1. A button on the Applicable Standards panel that launches a deep-research job whose plan is *"check this project against each applicable Richtlinie and report gaps."* The intake already captures `output_format: compliance_checklist | full_report` — wire it. This is the single most differentiating thing GRID could do: it closes the loop intake → applicable standards → grounded multi-Richtlinie analysis → report. Ties directly into the existing deep-research + research-runs machinery.

## 3. Compliance report export (PDF / DOCX)
**Value: very high. Effort: L. Risk: medium.**
Architects must produce submission documentation. `@react-pdf/renderer` is already a dependency. A "Export report" on a completed research run that renders the report + its LegalBasisCards (cited Richtlinie + § + excerpt) into a clean PDF with the project brief as a cover sheet. Deliverable an architect can hand to the authority. Pairs with #2.

## 4. Seed-chat everywhere (`?ask=`) — extend the pattern
**Value: medium. Effort: S. Risk: low.**
The `?ask=` composer-prefill wired for #1 should also power: "ask a follow-up" on every LegalBasisCard, the Overview "Grid still doesn't know: …" prompts, and the missing-info items. Cheap, makes the whole app feel connected — every fact becomes a launch point into grounded chat.

## 5. Project-scoped chat sessions
**Value: high. Effort: M. Risk: medium.**
CX finding (cx-03): file uploads are project-scoped but chat sessions are global — a coherence gap. The `conversations` table already has a `projectId` FK; the work is filtering the sessions list/store by the active project and defaulting new sessions to it. Makes each project a real self-contained workspace (matches the sidebar IA).

## 6. Cross-project RAG — "Ask the portfolio"
**Value: very high (strategic). Effort: L+. Risk: high.**
The existing vision doc (`2026-07-03-cross-project-rag-vision.md`): every project enriches a cross-project embedding index (pgvector, respecting org boundaries) so the agent can say *"3 similar projects — the Hochhaus in Q2 had the same sprinkler-riser conflict."* Network effects: 100 projects become more valuable than 1. The platform bet. Needs infra (pgvector) and careful tenant isolation — do it deliberately, not quickly.

## 7. Backend DB migration mechanism
**Value: medium (hygiene). Effort: M. Risk: low.**
`init-db.sql` only runs on first-ever volume init, so schema changes to the backend DBs (aiq_jobs/aiq_checkpoints) never re-apply — a latent footgun (the research-runs feature sidestepped it with runtime `ALTER TABLE IF NOT EXISTS`). Add a lightweight, idempotent migration runner in the backend entrypoint, mirroring what the UI's drizzle-kit does.

## 8. Deep-research input balance revisit
**Value: medium. Effort: S. Risk: medium.**
The chat redesign kept the deep-research input hard-lock + auto-open panel as intentional concurrency guards. Worth revisiting: let users queue a follow-up or browse prior messages during a run instead of a full lock — softer guard, better feel. Needs runtime iteration to get right.

## 9. Harden the NAT monkeypatch
**Value: medium (stability). Effort: S. Risk: low.**
`websocket_reconnect.install_reconnectable_handler()` patches NAT internals at import; a NAT upgrade can break it silently, and there's an acknowledged upstream bug where `_running_workflow_task` is always None (cancellation-on-disconnect may not fire). Pin the NAT version and add a regression test asserting the patch target still exists.

---

### Recommended sequence
**2 → 3 → 4** is the highest-ROI thread: it makes GRID *produce the compliance deliverable*, which is the product's reason to exist. **5** is a coherence win to slot in alongside. **6** is the strategic platform bet for when the core loop is proven. **7/9** are stability hygiene to schedule opportunistically.
