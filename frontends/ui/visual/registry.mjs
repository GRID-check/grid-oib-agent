/**
 * Visual screenshot registry — the single source of truth for the surfaces the
 * screenshot harness captures. Each target points at a self-contained `/dev/*`
 * preview route that renders a real component with fixture data (no backend), so
 * a screenshot is reproducible in CI and locally.
 *
 * Add a target here when you build a user-visible surface worth capturing as
 * evidence; give it a `/dev` preview route that renders the real component. The
 * harness (`visual/capture.mjs`) writes `<id>.light.png` / `<id>.dark.png` into
 * `visual/screenshots/`. See `docs/ux/visual-screenshots.md`.
 */

export const SCREENSHOT_TARGETS = [
  {
    id: 'herleitung',
    mobile: true,
    path: '/dev/herleitung',
    description:
      'Herleitung reasoning trace, expanded — the React Flow node graph (framing → parallel sources → assessment) wired into the real ChatThinking.',
    waitFor: '.react-flow__node',
  },
  {
    id: 'herleitung-dense',
    mobile: true,
    path: '/dev/herleitung?variant=dense',
    description:
      'Herleitung for a research-heavy turn (9 documents / 5 lanes) in the real 680px thread column — more sources than fit one row, so the fan packs into stacked COLUMNS instead of collapsing into a single vertical chain.',
    waitFor: '.react-flow__node',
  },
  {
    id: 'herleitung-branches',
    mobile: true,
    path: '/dev/herleitung?variant=branches',
    description:
      'Herleitung with a live choice prompt and NO findings — the parallel sources fan IN to the branches node directly (per-source handles); long question + four options exercise the measured, content-driven layout.',
    waitFor: '.react-flow__node',
  },
  {
    id: 'herleitung-live',
    mobile: true,
    path: '/dev/herleitung?variant=live',
    description:
      'Herleitung mid-stream — live activity phrase (in-progress step only), animated edges, executed-step chips with the running pulse, elapsed pill; narrow width shows the grouped Quellen node with two straight centred edges.',
    waitFor: '.react-flow__node',
  },
  {
    id: 'sessions',
    mobile: true,
    path: '/dev/sessions',
    description:
      'Session history panel — day-grouped list with sticky day headers, the selected row, and the hover-only rename/delete overlay. Fixture spans today/yesterday/older and overflows the panel so the grouping and scroll behaviour are visible.',
    waitFor: '[data-testid="sessions-preview"]',
  },
  {
    id: 'chat-turn',
    mobile: true,
    path: '/dev/chat-turn',
    description:
      'A chat turn at both transition endpoints — a LIVE turn (Herleitung auto-expanded, reasoning graph streaming, answer absent) and a COMPLETED turn (Herleitung collapsed to the one-line bar, cited "Ergebnis" answer card dominant, sources+confidence once) — desktop + mobile.',
    // Wait for the LIVE turn's reasoning graph to mount before capturing.
    waitFor: '.react-flow__node',
  },
  {
    id: 'composer',
    mobile: true,
    path: '/dev/composer',
    description:
      'The chat composer (real InputArea, backend-free) in its empty-thread state — textarea, scope/sources/deep-research controls, attach + send — desktop + mobile.',
    waitFor: '[data-testid="composer-preview"]',
  },
  {
    id: 'composer-files',
    mobile: true,
    path: '/dev/composer-files',
    description:
      'The chat composer with files attached (ready / ingesting / failed) — clickable inline FileChips, manage-files button, mobile "manage" text entry, per-file retry/remove — desktop + mobile.',
    waitFor: '[data-testid="composer-files-preview"]',
  },
  {
    id: 'composer-files-preview',
    mobile: true,
    path: '/dev/composer-files?state=preview',
    description:
      'The shared read-only FilePreviewDialog opened from a successful composer file chip (canManage=false) — desktop split vs. mobile full-screen sheet.',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'composer-files-sheet',
    mobile: true,
    path: '/dev/composer-files?state=sheet',
    description:
      'The mobile FileSourcesTab bottom-sheet (manage attached files) — slide-up sheet with per-file open + delete rows.',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'composer-research-done',
    mobile: true,
    path: '/dev/composer-files?state=research-done',
    description:
      'The post-research composer: after a SUCCESSFUL research run the field is locked and the send slot becomes an explicit "Neue Sitzung starten" forward action (replacing the old no-op explanation popover), with a helper line — desktop + mobile.',
    waitFor: '[data-testid="composer-files-preview"]',
  },
  {
    id: 'chat-welcome',
    mobile: true,
    path: '/dev/chat-welcome',
    description:
      'The authenticated empty chat state (real ChatArea WelcomeState) — greeting, the one-line subtitle telling first-timers that answers cite their sources, and the example-question chips — desktop + mobile.',
    waitFor: 'h1',
  },
  {
    id: 'confirm-dialog',
    mobile: true,
    path: '/dev/confirm-dialog',
    description: 'Shared destructive ConfirmDialog (backs admin confirms + delete modals), shown open.',
    waitFor: '[role="alertdialog"], [role="dialog"]',
  },
  {
    id: 'document-grid',
    mobile: true,
    path: '/dev/document-grid',
    description: 'Chat document_grid surfacing card — real project + Büroarchiv files as preview cards.',
    // Wait for the real card to mount and its resolution fetch to settle.
    waitFor: '[data-testid="document-grid-card"]',
  },
  {
    id: 'intake',
    mobile: true,
    path: '/dev/intake',
    description:
      'Project intake wizard (real ProjectIntakeWizard, backend-free) — mobile focus: sticky safe-area Back/Next footer, scroll-into-view stepper, ≥44px touch targets.',
    waitFor: 'main',
  },
  {
    id: 'file-preview',
    mobile: true,
    path: '/dev/file-preview',
    description:
      'File-preview modal (real FilePreviewDialog, backend-free) with rich metadata — desktop split (both columns scroll) vs. mobile full-screen sheet (preview capped, all metadata reachable).',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'file-browser',
    mobile: true,
    path: '/dev/file-browser',
    description: 'Files browser grid — the shared raised FileCard in its home surface.',
    waitFor: '[data-testid="file-card"]',
  },
  {
    id: 'archiv-library',
    mobile: true,
    path: '/dev/archiv-library',
    description: 'Archiv library grid — compared against the Files browser for unification.',
    waitFor: '[data-testid="archiv-document-card"]',
  },
  {
    id: 'settings',
    mobile: true,
    path: '/dev/settings',
    description: 'Project settings — section chrome, headings, and danger zone.',
    waitFor: 'h1',
  },
  {
    id: 'cards-gallery',
    path: '/dev/cards',
    description: 'Full Grid card gallery — every card type with fixture data.',
    waitFor: 'main',
  },
  {
    id: 'platform-workflow-templates',
    path: '/dev/platform-workflow-templates',
    description:
      'Platform workflow-templates manager (ADR-0027) — published + draft rows, provenance chips, cadence hints, and the JSON-import dropzone.',
    waitFor: '[data-testid="platform-template-list"]',
  },
  {
    id: 'workflow-template-gallery',
    path: '/dev/workflow-template-gallery',
    description:
      'Org Workflows template gallery (ADR-0027) — GRID built-in templates followed by the platform-published ones.',
    waitFor: '[data-testid="workflow-templates"]',
  },
  {
    id: 'workflow-run-history',
    path: '/dev/workflow-run-history',
    description:
      'A workflow’s run history joined with live job status — a run in flight (View progress), a finished one (View report), a failed one (View thinking) and a skipped one with no job.',
    waitFor: '[data-testid="run-history-preview"] a',
  },
  {
    id: 'platform-knowledge',
    mobile: true,
    path: '/dev/platform-knowledge',
    description:
      'Platform knowledge section, rebuilt on the shared admin primitives (SectionCard + DataToolbar + Table + Sheet).',
    waitFor: '[data-testid="platform-knowledge-preview"]',
  },
  {
    id: 'platform-norms',
    mobile: true,
    path: '/dev/platform-norms',
    description:
      'Platform norms section, rebuilt on the shared admin primitives (SectionCard + DataToolbar + Table + Sheet).',
    waitFor: '[data-testid="platform-norms-preview"]',
  },
  {
    id: 'platform-workflows',
    mobile: true,
    path: '/dev/platform-workflows',
    description:
      'Platform workflows section, rebuilt on the shared admin primitives (SectionCard + DataToolbar + Table + Sheet).',
    waitFor: '[data-testid="platform-workflows-preview"]',
  },
  {
    id: 'platform-overview',
    mobile: true,
    path: '/dev/platform-overview',
    description:
      'Platform overview section, rebuilt on the shared admin primitives (SectionCard + DataToolbar + Table + Sheet).',
    waitFor: '[data-testid="platform-overview-preview"]',
  },
  {
    id: 'platform-models',
    mobile: true,
    path: '/dev/platform-models',
    description:
      'Platform default models — the model each agent group runs on for every organization that has not chosen its own. Shows all three per-group states: pinned to a platform default, still on the workflow config, and pinned to a model with no zero-data-retention endpoint (flagged, because ZDR tenants cannot inherit it).',
    waitFor: '[data-testid="platform-models-preview"]',
  },
  {
    id: 'platform-maintenance',
    mobile: true,
    path: '/dev/platform-maintenance',
    description:
      'Platform maintenance section, rebuilt on the shared admin primitives (SectionCard + DataToolbar + Table + Sheet).',
    waitFor: '[data-testid="platform-maintenance-preview"]',
  },
  {
    id: 'platform-primitives',
    mobile: true,
    path: '/dev/platform-primitives',
    description:
      'The platform admin primitives as one worked example — SectionCard chrome around a DataToolbar + Table + Pagination, plus the loading / error / empty states every section now shares. The shape each platform page is being converted to.',
    waitFor: '[data-testid="primitives-demo"]',
  },
  {
    id: 'platform-nav',
    mobile: true,
    path: '/dev/platform-nav',
    description:
      'Platform section nav — the sticky rail on desktop and the scrolling strip on mobile, with the active section marked. Replaces the single page that stacked seven admin domains in one column.',
    waitFor: '[data-testid="platform-nav"]',
  },
  {
    id: 'citation-interaction',
    mobile: true,
    path: '/dev/citation-interaction',
    description:
      'What happens when you USE a citation: inline [N] markers tinted by the provenance family of the source they name (three OIB passages and one binding legal source, distinguishable mid-sentence), each previewing document\u2009\u00b7\u2009authority\u2009\u00b7\u2009page\u2009\u00b7\u2009passage in place and marking the chip it belongs to \u2014 rendered through the real AgentResponse in both shells.',
    waitFor: '[data-testid="citation-interaction-preview"]',
  },
  {
    id: 'citation-peek',
    mobile: true,
    path: '/dev/citation-interaction?open=peek',
    description:
      'The citation peek OPEN \u2014 the surface a resting screenshot can never show. Clicking an inline marker answers "what is this?" in place: provenance kind, authority tier, document title, the cited page, the passage itself, and the actions (open at this passage, copy link, copy citation).',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'answer-sources',
    mobile: true,
    path: '/dev/answer-sources',
    description:
      'The answer\u2019s "Belegt durch" provenance row, where the document\u2192locus model becomes visible: ONE chip per document carrying every [N] and every page it was read at (the case that used to render four rows, three of them degraded to a raw filename with no badge), mixed provenance families side by side, a written-source-list-only answer resolving identically to the structured path, and the honest "L\u00fccke" row.',
    waitFor: '[data-testid="answer-sources-preview"]',
  },
  {
    id: 'source-list',
    mobile: true,
    path: '/dev/source-list',
    description:
      'The research panel\u2019s citation list — every document source kind in one place (OIB corpus, RIS, B\u00fcroarchiv, project upload, web page), each with its provenance tint, authority badge and cited marker. Evidence that a source renders and behaves identically here and in the answer\u2019s provenance chips.',
    waitFor: '[data-testid="source-list-preview"]',
  },
  {
    id: 'citation-health',
    mobile: true,
    path: '/dev/citation-health',
    description:
      'Platform citation-health card — clean-rate + defect stat tiles, the stacked per-day defect trend (with a visible incident mid-window), the removal-reason and flagged-source rankings, the per-organization table and the recent-findings list.',
    waitFor: '[data-testid="citation-health"]',
  },
  {
    id: 'inbox',
    mobile: true,
    path: '/dev/inbox',
    description:
      'The inbox list (spec IB-18…IB-21) — registry-driven rows carrying who/what/where/when: an unread actionable mention request with its quoted question, a grouped activity row (3 new messages), a shared-with-you row, an answered request, an unknown actor / untitled chat, and an INERT row whose target is gone (plain text, no link, no excerpt — IB-13). Plus the needs-me/all filter, mark-all-read, and the count badge including the collapsed-rail placement.',
    waitFor: '[data-testid="inbox-item"]',
  },
  {
    id: 'inbox-empty',
    mobile: true,
    path: '/dev/inbox?variant=empty',
    description:
      'The inbox with nothing in it — the crafted per-filter empty state ("Nichts zu tun" under Für mich), with mark-all-read correctly disabled.',
    waitFor: '[data-testid="inbox-list"]',
  },
  {
    id: 'mention-picker',
    mobile: true,
    path: '/dev/mention-picker',
    description:
      'The @-mention popover, open (spec MN-3/MN-4/MN-5). Anchored above the composer like Slack/Linear rather than caret-tracked. Avatars with a deterministic per-user hue, the matched substring emphasised, grouped agent -> in this chat -> elsewhere in project, "Wird eingeladen" on someone who will be invited by being tagged, and the keyboard hint strip.',
    waitFor: '[data-testid="mention-picker-preview"]',
  },
  {
    id: 'engagement-notice',
    mobile: true,
    path: '/dev/engagement-notice',
    description:
      'When Piloti answers a message that tags nobody (ADR-0036), stated where the question arises and doubling as the control. Three rows: a multi-person thread being OFFERED mention mode as a question about the future (never switched quietly — `ask` stays the default because Piloti is the point of the product, not a guest in a chat app), the rule stated in mention mode with the way back, and a viewer who gets the explanation without a control.',
    waitFor: '[data-testid="engagement-notice-preview"]',
  },
  {
    id: 'mention-pill',
    mobile: true,
    path: '/dev/mention-pill',
    description:
      'A mention inside message text: a pill, not plain text, with the person card it opens on hover/tap/focus (the same peek timing as a citation). Four rows — a colleague, YOU (filled ink, the one mention that asks something of the reader), Piloti, and someone no longer in the roster who deliberately gets NO card. Plus the card in its four shapes, including "Nicht in diesem Chat" in warning ink, which is the difference between a tag that reaches someone and one that quietly does nothing.',
    waitFor: '[data-testid="mention-pill-preview"]',
  },
  {
    id: 'awaiting-banner',
    mobile: true,
    path: '/dev/awaiting-banner',
    description:
      'The hand-off state every participant sees while the agent deliberately stays silent (spec MN-7/MN-8): "Warten auf Anna Berger", the reason it is quiet, who asked, and the release action so a thread can never be permanently stuck. The third block is the reader\'s own turn to answer, which also carries "Rückfrage an …" — the affordance for the most common outcome, being asked something you cannot answer yet.',
    waitFor: '[data-testid="awaiting-banner-preview"]',
  },
  {
    id: 'share-dialog',
    mobile: true,
    path: '/dev/share-dialog',
    description:
      'The sharing surface (spec SH-17/SH-19): visibility with its plain-words consequence, the roster with WHY each person has access, and an invite picker where someone outside the project appears DISABLED with the reason rather than hidden — sharing a chat never grants project access.',
    waitFor: '[data-testid="share-dialog-preview"]',
  },
  {
    id: 'access-overview',
    mobile: true,
    path: '/dev/access-overview',
    description:
      'The "who has access" answer (spec SH-18): the blanket visibility rule and the named exceptions together, grouped by role, each row carrying the reason for its access.',
    waitFor: '[data-testid="access-overview-preview"]',
  },
  {
    id: 'composer-addressee',
    mobile: true,
    path: '/dev/composer-addressee',
    description:
      'The composer\'s always-present statement of WHO receives this message (ADR-0034 addendum). Every rendering in one still: "Geht an Piloti" by default, "Geht an <Name>" the moment a colleague is tagged, both names when a person AND @Piloti are tagged, and "Geht an den Chat" + "@Piloti eingeben, um Piloti zu fragen" while the thread waits on a human. Always present on purpose — if it only appeared in the unusual case, "Piloti is next" would stay an inference.',
    waitFor: '[data-testid="composer-addressee-preview"]',
  },
  {
    id: 'shared-thread-handback',
    mobile: true,
    path: '/dev/shared-thread?variant=handback',
    description:
      'The hand-back offer at the point a wait resolves: the colleague answered, the wait closed, and the thread offers "Piloti weiterarbeiten lassen?". Its action PRE-FILLS the composer rather than firing a turn, so every message stays honestly authored. Derived from the thread rather than a live transition, because the asker usually arrives after the answer landed.',
    waitFor: '[data-testid="shared-thread-preview"]',
  },
  {
    id: 'share-dialog-invite',
    mobile: true,
    path: '/dev/share-dialog?variant=invite',
    description:
      'The invite half of the share dialog. Anyone already on the roster is filtered OUT (they carry their role control there, not here — one person, one control). Org members who cannot reach the container project stay VISIBLE but disabled with the reason, because silently omitting a colleague reads as a bug (spec SH-19).',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'share-dialog-project',
    mobile: true,
    path: '/dev/share-dialog?variant=project',
    description:
      'The dialog for a project-wide chat: the blanket rule stated in plain words ("Alle im Projekt koennen mitlesen und mitschreiben") ALONGSIDE the named exceptions, which is the hard part of answering "who can read this".',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'mention-picker-restricted',
    mobile: true,
    path: '/dev/mention-picker?variant=restricted',
    description:
      'The picker as a collaborator who may not invite (spec MN-5/OQ-3): people who would need an invitation are shown DISABLED with "Nur Eigentuemer koennen neue Personen in diesen Chat holen" rather than hidden, so the restriction is explicable instead of looking like a missing colleague.',
    waitFor: '[data-testid="mention-picker-preview"]',
  },
  {
    id: 'shared-thread',
    mobile: true,
    path: '/dev/shared-thread',
    description:
      'A shared thread with three people plus the agent (spec CC-4/CC-5/CC-13/CC-19): every human message attributed, one author\'s consecutive messages GROUPED under a single header, the unread separator, an @Piloti mention chip, and the turn-in-flight banner telling an observer whose question the agent is answering. All four voices distinguishable — colleague, you, the agent\'s answer, the agent\'s status.',
    waitFor: '[data-testid="shared-thread-preview"]',
  },
  {
    id: 'chat-toolbar',
    mobile: true,
    path: '/dev/chat-toolbar',
    description:
      'The floating chat toolbar in the 768px column it actually gets. Left pill = orientation (history door + the thread\'s name) and takes all the elastic width; right pill = status, a hairline, then controls — information is never clickable and every control looks like one. Only New chat stays in the open; share, rename and the report are in the "…" menu. Three rows: a solo private thread (no collaboration furniture and no bare separator), a shared thread with long project + session names and three people, and a project-wide thread, where the rule REPLACES the faces: the audience there was never enumerated, so avatars would be a partial sample of it rather than a summary. Exactly one of the two forms, never both.',
    waitFor: '[data-testid="chat-toolbar-preview"]',
  },
  {
    id: 'chat-toolbar-running',
    mobile: true,
    path: '/dev/chat-toolbar?variant=running',
    description:
      'The same three toolbars while deep research is in flight — the one research state that belongs in the open row, because it is STATUS and not a control: the thread\'s own progress banner scrolls away, so this is the persistent "still working" signal. Merely HAVING a finished report changes nothing here; that is a menu entry.',
    waitFor: '[data-testid="chat-toolbar-preview"]',
  },
  {
    id: 'focus-ring',
    path: '/dev/focus-ring',
    description:
      'Global :focus-visible outline on rounded controls — Tab-focused so the ring follows the control radius (guards against the border-radius:inherit square-corner regression).',
    waitFor: '[data-testid="focus-ring-preview"]',
    // Tab 1 lands on the layout's "Skip to content" link; Tab 2 focuses the
    // first form control (the text input) — the rounded shape that regressed.
    tabStops: 2,
  },
]
