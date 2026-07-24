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
    id: 'herleitung-branches',
    mobile: true,
    path: '/dev/herleitung?variant=branches',
    description:
      'Herleitung with a live choice prompt and NO findings — the parallel sources fan IN to the branches node directly (per-source handles); long question + four options exercise the measured, content-driven layout.',
    waitFor: '.react-flow__node',
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
