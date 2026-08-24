# Click-Dummy Overhaul Spec — "Ask Piloti v6" → GRID

**Status:** Accepted working spec (2026-07-17). Owner: product/frontend.
**Sources:** the team's click dummy `Ask_Piloti_v6_standalone2.html` (external, not in
repo — a self-contained React bundle; fully reverse-engineered for this spec),
the current `frontends/ui` implementation, `docs/design/grid-design-language.md`,
`feedback_backlog.md` (FB-2/4/6/8/9/10/11/12), `ux_audit_log.md`.

**Scope guard:** the **Herleitung reasoning-trace** (chain-of-thought UI, §7) is
**specified here but explicitly NOT implemented in this pass** — it depends on the
in-flight backend overhaul and is owned by a separate colleague. Everything else
is fair game.

---

## 1. What the click dummy is

A German-language, project-centric shell around one core surface ("Frag Piloti"):

- **Home = Projektübersicht** (no sidebar): project-card grid (name, address,
  Aktiv/Abgeschlossen chip, last activity, per-card settings) + a full-width
  **Archiv** entry card. Top bar: wordmark, "Organisation" button, avatar menu.
- **Project shell** (sidebar, collapsible to icon rail): project switcher popover,
  nav **Frag Piloti / Workflows / Dateien / Archiv / Historie**, bottom
  **Einstellungen** + user footer. Org-scoped screens (Archiv without project,
  org settings) render with a neutral top bar instead of the sidebar.
- **Frag Piloti**: greeting empty state; composer with **scope picker**
  (project vs. all projects), **Datengrundlage picker** (RIS / BO Wien / OIB /
  Projektunterlagen / Büroarchiv / Websuche with count badge), **Deep-Research
  toggle**, source-preset **shortcut chips**. Thread = breadcrumb
  `{Projekt} / {editable chat title}` + the **Herleitung** trace (§7) ending in a
  structured **Ergebnis** card: status chip, cited intro, "Voraussetzungen"
  checklist (per-row citation chips), "Nächster Schritt", an architectural
  sketch ("Umsetzung im Entwurf"), "Belegt durch" chip row, thumbs feedback.
- **Dateien**: folder chips + card grid with **content-aware thumbnails**
  (Grundriss/Schnitt/Lageplan/Doc/Bescheid/Foto), one-line AI description per
  file, name search; preview modal with **"Von Piloti indexiert"** panel
  (AI summary, key-value props, **editable tags**).
- **Archiv** (org scope): four Ablage-Ordner + a **detail library** — theme
  filter chips incl. **user-created categories**, detail cards (number D-204…,
  drawing preview, provenance "Aus ‹Projekt› · Geprüft ‹Jahr›"), preview modal
  with the same AI-index panel.
- **Workflows**: curated template gallery ("Vorprüfung Einreichung — Dauer ca.
  4 Min · Starten", "Richtlinien-Monitoring — Läuft wöchentlich · Einrichten",
  "Weitere folgen" placeholder).
- **Historie**: cross-chat list with provenance dot per row + source-type filter
  chips; row click reopens the answered thread.
- **Einstellungen**: project tab (Projektparameter form + **Insights**: request
  count, source-mix bars, "Zuletzt" narrative) and org tab (members with
  Admin/Bearbeiten/Lesen roles, org form, Wissensquellen explainer).
- **Feedback**: per-answer thumbs (down → reason chips) and a recurring NPS
  popover (0–10).

### The visual language (extracted tokens)

Warm paper monochrome. `Inter`; app bg `#f6f6f4`, sidebar `#f1f1ef`, white
cards with 0.5px hairline borders (`rgba(28,30,33,.08–.32)`) and layered soft
shadows; 10-step ink ramp `#1f2023 → #b3b3af`; **near-black action buttons**
(`#1f2023`, white text) — *no* brand accent color. The only color is a
**source/provenance signal system**, always icon+label+color together:

| Signal | Color | Meaning |
|---|---|---|
| blue `#2359d3` | Baurecht & Richtlinien (RIS, BO, OIB) | icon "§" |
| green `#17914d` | Projektwissen (project docs) | doc icon; doubles as status "Aktiv" |
| gold `#c08c28` | Büroarchiv (office archive) | archive-box icon |
| gray `#83837f` | Automatisch / **Lücke** (knowledge gap) | globe/gap |
| red `#c14a38` | errors only | — |

Type ramp 9.5–24px with uppercase 10.5px labels (+0.05em). Radii 7–14px.
Motion: `nodeIn` (fade + 14px rise, .7s) per trace node, pulsing dots while
thinking. A `sourceColors: boolean` prop exists in the dummy — the team is
visibly undecided whether provenance colors stay; **decision: keep them**
(they are the product's most distinctive trust affordance), but always
paired with icon + label so color is never the only carrier (a11y).

---

## 2. Verdicts

### 2.1 What is genuinely good (adopt)

1. **Provenance as a first-class visual system.** Colors/icons for
   law/project/office/gap running through composer, trace, citations, history
   filters, and insights. We already have origin badges (`[KB]/[RIS]/[Web]`,
   FB-2) — this generalizes them into the whole app.
2. **The "Lücke" concept.** Explicitly rendering *missing* knowledge ("TRVB
   F 134 — nicht im Bestand → MA 68 kontaktieren") as a source card of its own.
   Honesty as UI. Nothing in the current UI does this; it's cheap to carry in
   the citation model and extremely valuable for trust.
3. **Structured result card.** Status chip → cited intro → requirement
   checklist with per-row citations → "Nächster Schritt" → "Belegt durch" chip
   row. Maps almost 1:1 onto our existing grid-cards (LegalBasisCard,
   RequirementChecklist, Summary) — this is a composition/restyling job, not
   an invention.
4. **Decision branches ("Folgewege").** The agent pauses on a genuine design
   decision (four compliant paths for the second escape route), each option
   carrying its legal basis, consequence tags, and expandable detail; the
   answer is then composed *for the chosen branch*, with "Weg ändern" to
   revisit. This is our existing HITL `system_interaction` machinery wearing a
   much better suit.
5. **Calm project-first IA.** Chat-first nav, settings tucked at the bottom,
   org screens in neutral chrome. Matches FB-9 (sidebar slim-down) almost
   exactly and confirms the direction.
6. **AI-indexed files.** Content-aware thumbnails, one-line AI summary per
   file card, editable tags with the note "deine Korrekturen verbessern
   künftige Antworten" (a human-in-the-loop metadata feedback loop). We
   already have the tagging backfill + `files-metadata-panel` flag (FB-8);
   the dummy shows how to surface it.
7. **Archiv as a curated detail library** (numbered, themed, *verified*
   details with provenance from source projects) rather than a raw document
   dump. "Geprüft ‹Jahr›" is a strong trust marker for reusable office
   knowledge.
8. **Historie with provenance filters** that reopens threads — a real page,
   not just a side panel.
9. **The warm monochrome visual language.** Consistent with our design
   language's "understated, premium" goals but more distinctive than the
   current blue-accent look; near-black actions age better than accent-blue
   buttons and make the provenance colors pop.
10. **Micro-interactions**: hover-reveal collapse handle at the sidebar edge,
    inline title rename in the breadcrumb, per-node entrance animation.

### 2.2 What we should NOT do as designed (reject / adapt)

1. **Single-turn threads.** The dummy has exactly one user turn; a follow-up
   restarts the trace. We keep our multi-turn conversation model — the trace
   becomes a *per-turn* artifact, collapsible per answer (§7).
2. **Blocking the answer on a branch choice.** In the default scenario the
   dummy renders *no result* until the user picks a Folgeweg. Real users ask
   ambiguous questions and walk away. Rule: branches are offered **only when
   the agent genuinely needs a decision**, always with a **recommended
   default** and a "just answer for the likely path" escape; the answer for
   the recommendation renders after a timeout/skip, never a dead end.
3. **Faked staging.** Trace stages appear on 1.8s timers. Ours must be driven
   by real intermediate frames (we already stream `system_intermediate` /
   SSE task events) — no theatrical delays.
4. **Auto-collapse of the trace** 1.6s after the answer lands (doc-lookup
   scenarios). Disorienting; things move under the cursor. Ours: the trace
   collapses only on user action or when a *new* turn starts; the collapsed
   "Herleitung" summary bar (n Zwischenschritte · m Quellen) is the good part
   — keep that.
5. **NPS on every new chat.** Demo artifact. Real cadence: at most once per
   user per 30 days, only after ≥3 answered turns, dismissal persisted
   server-side. Per-answer thumbs are the primary channel.
6. **Manual Deep-Research toggle as the *only* entry.** Our agent
   auto-escalates (ADR/FB history) and that stays; the toggle becomes a
   *user intent hint* ("förmliche Recherche erzwingen") — an addition, not a
   replacement for auto-escalation.
7. **Dropping Overview/Members/Knowledge from nav** without a home for their
   content. The dummy simply has no equivalent of the project brief, memory
   panel, member roster, or KB transparency. We consolidate instead (§5):
   Members + project parameters + insights + danger zone move under a project
   **Settings** page (exactly FB-9); Knowledge stays a flagged page reachable
   from Settings/Files, not top-level nav.
8. **A separate "Historie" data model.** The dummy's history rows hardcode
   reopened answered states. Ours is a view over the existing
   conversations + research-runs store (server truth, FB-10) — one model,
   two surfaces (page + panel).
9. **Wordmark "Piloti".** Originally the pilot office's colloquial name (see
   `feedback_backlog.md`). Since decided (2026-07-17, §8 item 1): the
   user-facing wordmark IS **Piloti**; GRID stays the internal/platform name.
10. **No mobile, no loading/error/empty states, no a11y semantics.** The
    dummy is a happy-path desktop demo (fixed 720px thread, 3-col grids).
    Our current shell is responsive with drawer nav and skeletons — that
    quality bar is non-negotiable and carries over into every restyled
    screen.
11. **Sketchy details in the dummy itself** (for the record): duplicated
    `componentDidUpdate` (scroll-reset silently dead), a `chatTitleCommit`
    ReferenceError from lowercase event-handler wiring, unused leftovers
    (`traceRelevant`, `openCheckliste`), file search matching names only.
    Reminder that the dummy is a *direction*, not a reference implementation.

### 2.3 What the dummy silently assumes but nobody has built

- **Cross-project scope** ("Alle Projekte einbeziehen") — backend has no
  cross-project retrieval (see `docs/roadmap/cross-project-rag-vision.md`).
  Ship the picker **disabled with an explanatory tooltip** or hide behind the
  vision work. Do not fake it.
- **Detail-library semantics in Archiv** (detail numbers, themes,
  verified-year, source project). The Archiv (ADR-0024) stores documents with
  tags; "Geprüft" needs a review workflow that doesn't exist. Phase it:
  category chips + tags now, verification workflow later.
- **Per-project insights** (request counts, source mix, "häufigstes Thema").
  No per-project telemetry aggregation exists (budgets are org-level).
  Requires a BFF aggregation over conversations/runs — small but real backend
  work; UI ships behind a flag with honest empty states until then.
- **Workflow templates** ("Vorprüfung Einreichung", "Richtlinien-Monitoring")
  as one-click products. Our Workflows feature (ADR-0023) is a cron builder.
  The gallery is a *presentation* of predefined templates on top of it — the
  monitoring template also implies diffing OIB/norm versions, which is a
  backend feature we do not have. Gallery ships with the templates we can
  actually run (scheduled deep research presets).
- **Sharing model** ("Privater Workspace" chip) — implies private vs. shared
  chats. **Now specified:** `collaboration-sharing-and-inbox-spec.md` defines
  the reusable sharing substrate (private / project / organisation visibility
  plus additive per-person grants) and the access chip this dummy element
  implies (SH-18). Still no UI here until that spec's Phase 1 ships.
- **Answer feedback storage + NPS** — needs a small BFF domain (§6, WS-7).

---

## 3. Feature mapping (dummy ↔ current)

| Dummy | Current state | Verdict |
|---|---|---|
| Home project grid + Archiv card | `/app/projects` grid exists (create, soft-delete, restore) | Restyle; add status chip, last-activity, per-card settings, Archiv entry card |
| Sidebar: Frag Piloti/Workflows/Dateien/Archiv/Historie + Einstellungen | Overview/Chat/Files/Knowledge/Research/Workflows/Members | **Re-cut nav** (FB-9): Chat, Files, Workflows*, Archiv*, History, Settings. Research merges into history (FB-10). Overview+Members fold into Settings |
| Composer: scope/sources/deep-research/shortcuts | DataSourcesPanel exists; deep research auto-escalates; no scope UI; no shortcuts | Restyle composer; sources chip = existing panel; scope picker display-only; DR toggle = intent hint; shortcut chips = data-source presets |
| Herleitung trace | ChatThinking (per-turn steps) + ResearchPanel (Tasks/Thinking/Report) | **Shipped (source-hero):** `docs/superpowers/specs/2026-07-18-herleitung-source-hero-design.md` — bar + per-doc source cards; full stage spine/gaps deferred |
| Folgewege branch picker | HITL `system_interaction` (choice prompts) exists, plainly styled | Restyle as branch cards when backend sends decision-class interactions (part of §7 contract, UI shell can come earlier) |
| Ergebnis structured card | grid-cards: LegalBasis, RequirementChecklist, Summary + roughjs schematics | Compose + restyle; add "Belegt durch" chip row + status chip |
| Citation chips → source preview modal | Origin badges behind flag; **no click-through** (FB-4); PdfViewerDialog exists unwired | Build source-preview popover/modal wired to citations (high value, independent of CoT) |
| Files cards + AI index panel + tags | Mature files feature; metadata/tags behind `files-metadata-panel` (FB-8) | Restyle cards w/ kind thumbnails; promote metadata panel; keep ingestion status (dummy lacks it!) |
| Archiv detail library | Archiv behind `organization-archiv` flag, document rows | Restyle toward library: category chips, card grid, provenance line. Verification workflow = later phase |
| Workflows gallery | Cron builder behind flag | Add template-gallery presentation layer over existing builder |
| Historie page | SessionsPanel + research-runs section (FB-10) | New page over same stores + provenance filter chips |
| Settings (project params + insights) | Intake wizard + overview panels + members page | New Settings page consolidating; insights behind flag pending telemetry |
| Org settings neutral chrome | OrgTopbar pattern exists | Aligned already; restyle only |
| Thumbs + reasons + NPS | **Nothing exists** | New small feedback domain (BFF table + routes) + UI |
| Provenance color system | oklch tokens, single blue accent | New `--source-*` token family; monochrome action tokens |

**What we have that the dummy ignores (must survive every restyle):** multi-turn
chat + HITL + WS resilience + deep-research resume; sessions panel; memory
(project/org/conversation) + MemoryNotedChip; confidence chip; ingestion
status; budgets/usage; BYOK; model config; audit; legal holds/deletion;
platform/base-knowledge admin; onboarding; i18n (EN **and** DE); dark mode;
mobile drawer nav; command palette; a11y/reduced-motion; marketing landing.

---

## 4. Visual-language decision

Adopt the dummy's system, mapped onto our existing token architecture
(`src/styles/tokens.css` keeps its shadcn + legacy var names so components
don't churn):

- Surfaces → warm paper (light: bg `#f6f6f4`-equivalent oklch, sidebar
  slightly darker, white cards; dark mode: warm charcoal equivalents, derived,
  not shipped-in-dummy — we design them, `.dark` stays).
- `--primary`/action → near-black ink (dark mode: paper-white on ink).
  `--grid-blue` ceases to be the action color; blue is reassigned to the
  **Baurecht** source signal.
- New token family:
  `--source-law`, `--source-project`, `--source-office`, `--source-auto`,
  each with `-tint` and `-text` variants + `--status-active/done`,
  `--signal-error`. Both modes. Components must consume tokens, never hex
  (unchanged rule).
- Type: stay on **Geist Sans** (metrically close to Inter; avoids a font
  swap with zero user value). Adopt the dummy's ramp where it differs
  (uppercase 10.5px section labels, 20px page titles, 23px hero greeting).
- Depth: hairline borders + layered soft shadows (we already have
  `--elevation-*`; retune values).
- Motion: keep 150–250ms vocabulary; add `nodeIn`-style fade-rise for
  cards/trace nodes; respect reduced motion (existing infra).
- `docs/design/grid-design-language.md` is updated in the same change as the
  token retune (docs obligation).

---

## 5. Target information architecture

```
/                          marketing (unchanged)
/app/projects              Home: project grid + Archiv entry card   [OrgTopbar]
/app/organization          org settings (restyle only)              [OrgTopbar]
/app/archiv                Archiv, org scope (library restyle)      [OrgTopbar]
/app/platform, /app/profile, onboarding, legal   (unchanged)
/app/projects/[id]/
  chat        ← project landing (root redirects here)               [Sidebar]
  files                                                             [Sidebar]
  workflows   (flagged, gallery + builder)                          [Sidebar]
  archiv      → same Archiv content, project chrome (flagged)       [Sidebar]
  history     NEW: cross-session list + provenance filters          [Sidebar]
  settings    NEW: project params (intake data) + members + memory
              + insights(flagged) + danger zone                     [Sidebar, bottom entry]
  knowledge   stays flagged, linked from Settings (not top-nav)
  research    legacy → redirect into history (completes FB-10)
  intake      unchanged (edit path from Settings)
```

Sidebar (top→bottom): wordmark · project switcher · Chat / Files / Workflows* /
Archiv* / History · (spacer) · Settings · user footer. Overview and Members
leave the nav; their content lives in Settings (route stubs 301 there).
Project root (`/app/projects/[id]`) redirects to `chat`.

---

## 6. Workstreams

Ownership boundaries are file-level to allow parallel agents. Every WS: keep
tests green (`npx tsc --noEmit`, `vitest run` scoped), i18n EN+DE for every
string in the WS's own namespace files, dark mode + mobile + a11y parity,
update user-guide docs it invalidates.

- **WS-1 Design tokens & language** — `src/styles/tokens.css`,
  `src/app/globals.css`, `docs/design/grid-design-language.md`. Retune to §4.
  No component file changes.
- **WS-2 IA / navigation** — `src/components/shell/*`, project `layout.tsx`,
  new `settings/` + `history/` pages, `research` redirect, `i18n/*/nav.ts`,
  `settings.ts`. Implements §5 (incl. FB-9/FB-10 completion).
- **WS-3 Chat surface (non-CoT)** — `src/features/chat/components/InputArea*`,
  `ChatToolbar*`, breadcrumb/title rename, shortcut chips, DR-intent toggle,
  sources summary chip, `i18n/*/chat.ts`. No changes to
  `use-websocket-chat.ts` / `use-deep-research.ts` message contracts.
- **WS-4 Files** — `src/features/documents/*` card grid, kind-detection
  thumbnails, metadata/tags panel promotion, search field, `i18n/*/files.ts`.
  Ingestion-status affordances must survive.
- **WS-5 Home** — `src/components/projects/*` grid card restyle, status chip,
  Archiv entry card, `i18n/*/projects.ts`.
- **WS-6 Archiv library** — `src/features/documents/components/archiv-*`,
  category chips (custom categories = org-scoped saved tags), provenance
  line, `i18n/*/archiv.ts`.
- **WS-7 Feedback** — new `lib/feedback` domain (repository/service/route per
  ADR-0017), `answer_feedback` table (+ drizzle migration), thumbs + reason
  chips on answers, NPS popover with §2.2(5) cadence, flag `answer-feedback`.
  (shipped: thumbs; NPS deferred)
- **WS-8 Workflows gallery** — template cards over existing builder
  (flag-gated as today), `i18n/*/workflows.ts`.
- **WS-9 Source preview** — citation chip → source preview surface (doc
  passage w/ highlighted quote via existing PdfViewerDialog where possible;
  law sources link RIS). Addresses FB-4. Depends on citation metadata only,
  not on the CoT overhaul.

Suggested order: WS-1 first (pure token retune recolors everything), then
WS-2..WS-6 in parallel, WS-7/8/9 as a second wave.

## 7. Herleitung / chain-of-thought — contract (+ source-hero v1)

Owner: was deferred to backend-overhaul; **v1 (source-hero) is live** in chat.
Design: `docs/superpowers/specs/2026-07-18-herleitung-source-hero-design.md`.

**Shipped in v1:** collapsible bar `Herleitung · n Zwischenschritte · m Quellen`;
parallel per-document source cards (lane tab · name · detail · Treffer) from KB
`## Trace-Lanes` (+ FE fallbacks); technical NAT steps secondary; multi-turn safe;
no timer theatrics. Captured lanes survive storage prune.

**Still contract target (not v1):** full stage spine
(`understood` → `sources[]` → `findings[]` → optional `decision` → `result`),
explicit **gap** emission with remediation, HITL Folgeweg card chrome, and a
deep-research DAG (graph lib) that must not drop ResearchPanel capabilities
(stop/cancel, reconnect, token/tool counts, report export).

## 8. Open questions (need humans)

1. Product name/wordmark: DECIDED (2026-07-17): user-facing brand is
   **Piloti**; internal/platform name stays GRID (env vars, headers, CSS
   variables, storage keys, DB identifiers, repo/product-platform name are
   untouched). Single source of truth: `frontends/ui/src/lib/brand.ts`.
2. `sourceColors`: spec says keep (§1) — confirm with design.
3. Sharing model for chats ("Privater Workspace") — undesigned.
4. Insights telemetry: which aggregates are acceptable org-policy-wise?
5. Archiv verification workflow ("Geprüft 2025") — who verifies, how often?
6. Cross-project scope timeline (vision doc exists, no backend).

## 9. Post-build decisions

Decisions made after the initial build, recorded here so the rationale isn't lost.

### 9.1 Project profile — one surface, one editor (2026-07-18)

**Context.** The fidelity pass had added a dummy-style "Projektparameter" field
card to the project **Settings** page. But the same profile facts were already
shown by the **Projekt-Briefing** card, and *both* linked to the **intake
wizard** to edit — so the profile appeared twice and the wizard read as a
confusing third way to do the same thing.

**Decision.** The project profile is shown in **one** place and edited in
**one** place:
- **Display:** the single profile card on Settings is the `ProjectBrief`
  (facts, AI summary, focus areas, Piloti's assumptions, and the open gaps).
  The duplicate `Projektparameter` field card was removed.
- **Editor:** the guided **intake wizard** is the only editor (Settings links
  to it once via "Briefing bearbeiten"). Its assumptions/gaps surfacing and
  end-of-wizard AI consistency check are the reason it exists.
- **No inline field-editing on Settings.** Project facts are *interdependent*
  — building class, use, and floor count drive which OIB standards apply — so
  editing them one field at a time on Settings would bypass the wizard's
  consistency check and let the profile desync. Right tool for the job: the
  card is "what Piloti thinks this project is"; the wizard is "change it."
- `ProjectBrief` gained a `canEdit` gate so viewers get a read-only brief.

Follow-up (optional): the surviving profile card could take the dummy's
stacked labelled-field look instead of the fact-sheet layout — a pure restyle
on top of this decision, not a change to the one-surface/one-editor rule.
