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
    id: 'chat-turn',
    mobile: true,
    path: '/dev/chat-turn',
    description:
      'A complete chat turn as ChatArea composes it — user question, collapsed Herleitung, and the cited "Ergebnis" answer card — desktop + mobile.',
    waitFor: '[data-testid="chat-turn-preview"]',
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
      'The chat composer with files attached (ready / ingesting / failed) — inline FileChips, manage-files button, per-file retry/remove — desktop + mobile.',
    waitFor: '[data-testid="composer-files-preview"]',
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
