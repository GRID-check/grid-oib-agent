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
