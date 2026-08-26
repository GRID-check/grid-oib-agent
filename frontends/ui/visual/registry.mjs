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
    id: 'pdf-passage',
    path: '/dev/pdf-passage',
    description:
      'Cited passage lit up inside the in-app PDF viewer, over a real one-page Bescheid rendered by pdf.js. Left pane freezes the arrival pulse mid-swell, right pane shows the resting mark. The quoted passage spans two printed lines and is cited without the line-break hyphen, so both the de-hyphenation and the per-line rectangle merge are visible.',
    waitFor: '[data-testid="passage-mark"]',
  },
  {
    id: 'app-rail',
    path: '/dev/app-rail',
    description:
      'The expanded 236px project rail on its own — brand row and collapse control, the grouped nav (work / automate / organisation) with its separators, and the footer stack of Settings, connection presence and the user tile. Every gated entry is on, so the column is at full height and competes for vertical space the way it does for a real member.',
    waitFor: '[data-testid="app-rail-preview"]',
  },
  {
    id: 'app-rail-collapsed',
    path: '/dev/app-rail?variant=collapsed',
    description:
      'The 64px icon rail — the rail\'s OTHER layout, not a narrower one: labels go sr-only, group labels unmount, tiles become square hit areas. Captures what previously had no visual evidence at all, so the icon column\'s horizontal alignment against the brand mark, the group separation, and the footer\'s bottom edge (Settings, presence dot, avatar) are all reviewable.',
    waitFor: '[data-testid="app-rail-preview"]',
  },
  {
    id: 'app-rail-wide',
    path: '/dev/app-rail?variant=wide',
    description:
      "The rail at 400px — a width no design review had ever seen, because until now no reader could ask for one: the edge showed a resize cursor and only toggled. It is a real drag handle now, so every width between 200px and 420px is a state the product ships in, and the two that carry layout risk are the ends. Here the nav labels stop truncating and the footer tile spreads; the seam, the group rhythm and the footer's bottom edge are the same ones the 236px shot pins.",
    waitFor: '[data-testid="app-rail-preview"]',
  },
  {
    id: 'app-shell-scopes',
    path: '/dev/app-shell-scopes',
    description:
      'The persistent rail in BOTH scopes, side by side — project scope (switcher, project sections, pinned Settings) against org scope (a "Zurück zu <project>" control from the return trail, the org destinations, no Settings row) on a distinct surface tint. The comparison is the evidence: the top edge, the 36px context slot, the group rhythm, the footer edge and the 236px width line up across the seam, so stepping out of a project changes the contents and moves nothing.',
    waitFor: '[data-testid="app-shell-scopes-preview"]',
  },
  {
    id: 'sessions',
    mobile: true,
    path: '/dev/sessions',
    description:
      'Chat-history panel over the real app rail — flush with the viewport top (it replaces the rail rather than starting below a header that the chat route does not have), pinned New chat + search, day-grouped list with sticky day headings, and a footer that owns the destructive delete-all. Fixture spans today/yesterday/older and overflows the panel so grouping and scroll behaviour are visible.',
    waitFor: '[data-testid="sessions-preview"]',
  },
  {
    id: 'sessions-search',
    mobile: true,
    path: '/dev/sessions?variant=search',
    description:
      'Chat history with a live query — trailing clear button, the "n of N chats" count, and the filtered list.',
    waitFor: '[data-testid="sessions-preview"]',
  },
  {
    id: 'sessions-no-match',
    path: '/dev/sessions?variant=no-match',
    description:
      'Chat history with a query that matches nothing — the search-specific empty state quotes the query and offers the way back out, instead of leaving a blank panel.',
    waitFor: '[data-testid="sessions-preview"]',
  },
  {
    id: 'sessions-empty',
    path: '/dev/sessions?variant=empty',
    description:
      'Chat history for a project with no chats — no search field and no delete-all (both could only ever act on nothing), and exactly one new-chat CTA.',
    waitFor: '[data-testid="sessions-preview"]',
  },
  {
    id: 'sessions-busy',
    path: '/dev/sessions?variant=busy',
    description:
      'Chat history while a turn is in flight — every row dimmed and unclickable, with the panel saying why rather than leaving the user to discover it row by row.',
    waitFor: '[data-testid="sessions-preview"]',
  },
  {
    id: 'sessions-research',
    path: '/dev/sessions?variant=research',
    description:
      'Chat history with the FB-10 Deep Research section expanded — server-truth runs (running / completed / failed) above the day groups, and the per-row Deep Research chips.',
    waitFor: '[data-testid="deep-research-toggle"]',
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
  // The answer layer INSIDE an answer. Every card, the lede and the provenance
  // footer had only ever been reviewed in the card gallery — isolated, on a bare
  // page, at full width — which cannot show a card breaking the reading rhythm,
  // an inline card misaligned with the prose column, or a fallback block
  // colliding with the sources row. These four capture the answer at the
  // thread's real 680px column, in the turn it actually ships in.
  //
  // `answer-follow-ups` is the odd one out and deliberately so: it is the only
  // target here whose subject is NOT inside the answer. It used to be — the
  // entry read "the chips have to still read as part of the answer rather than
  // as footer chrome", which was a committed argument for the placement this
  // change reverses. The chips now live below the message, so the target
  // captures the new truth and the old rationale is gone rather than left
  // contradicting the code.
  {
    id: 'answer-lede-card',
    mobile: true,
    path: '/dev/chat-turn?variant=lede-card',
    description:
      'A long answer over the lede threshold — first paragraph typeset as the lede — with a calculation card spliced in mid-answer by a [[card:1]] marker, so marker placement and the gap a card leaves on both sides are visible in the prose column.',
    waitFor: '[data-testid="answer-layer-preview"]',
  },
  {
    id: 'answer-two-cards',
    mobile: true,
    path: '/dev/chat-turn?variant=two-cards',
    description:
      'Two cards in one turn — a condition_tree placed inline by a marker and a process_map left unplaced, so it lands in the fallback block between the prose and the provenance footer. The "two cards is plenty" rule, seen rather than asserted.',
    waitFor: '[data-testid="answer-layer-preview"]',
  },
  {
    id: 'answer-follow-ups',
    mobile: true,
    path: '/dev/chat-turn?variant=follow-ups-rail',
    description:
      'The follow-up chips BELOW the answer rather than inside it (docs/architecture/post-answer-stages.md §6, §8). The same turn twice — once as the answer lands, once with the rail a post-answer stage delivered two seconds later — because the comparison is the evidence: the rail reserves no space, so everything above it must be pixel-identical in the two panels. Cover the rail; if the answer card, the provenance footer and the meta row do not line up, the licence to arrive late is void. The other thing to judge is what the rail must NOT read as: a second answer. It carries no frame and no surface of its own, sits outside the answer card in the same 680px column, and on the phone shot the four chips wrap one per line at the 12rem floor.',
    waitFor: '[data-testid="answer-layer-preview"]',
  },
  {
    id: 'answer-memory-chip',
    mobile: true,
    path: '/dev/chat-turn?variant=memory-chip',
    description:
      'The „Piloti hat sich gemerkt" chip as a fact about ONE TURN (docs/architecture/post-answer-stages.md §1.7, §5.1). The same answer twice, as two turns of one thread: above, the reflection stage ran and recorded nothing — its most common correct outcome — and there is no chip; below, it recorded two things and the chip says two. That difference is the change: the chip used to be fed by a three-shot poll of the whole conversation\'s memory fired by every rendered answer, so BOTH panels would have carried it and both would have shown the thread\'s running total. The second thing to judge is the meta row. The chip lands seconds after the answer and reserves nothing, which is only safe because it arrives into a row that is already on screen — confidence, copy, thumbs and timestamp are in it from the start. Cover the chip: the two footers must line up to the pixel, and on the phone shot the row must not gain a line. What a screenshot cannot show is the popover, which is where the in-turn write and the post-answer one are labelled apart; that distinction is held by MemoryNotedChip.spec.tsx.',
    waitFor: '[data-testid="answer-layer-preview"]',
  },
  {
    id: 'answer-verdict-lede',
    mobile: true,
    path: '/dev/chat-turn?variant=verdict-lede',
    description:
      'The verdict_header + lede pair. Above: the card at the top of the body, where its marker suppresses the lede by design and the card IS the lede. Below: the same card after an opening paragraph, so the lede fires too and the ruling is stated twice — the misuse the piloti-cards skill rules out.',
    waitFor: '[data-testid="answer-layer-preview"]',
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
    id: 'chat-welcome-model',
    mobile: true,
    path: '/dev/chat-welcome-model',
    description:
      'The same empty chat canvas in a project that HAS a readable IFC model: two building questions lead, marked with the model glyph, ahead of the OIB-corpus ones. This is where the model feature is discovered — chat is where a model is used, and nothing else on the canvas says the building can be counted, checked or compared.',
    waitFor: 'h1',
  },
  {
    id: 'confirm-dialog',
    mobile: true,
    path: '/dev/confirm-dialog',
    description:
      'Shared destructive ConfirmDialog (backs admin confirms + delete modals), shown open.',
    waitFor: '[role="alertdialog"], [role="dialog"]',
  },
  {
    id: 'document-grid',
    mobile: true,
    path: '/dev/document-grid',
    description:
      'Chat document_grid surfacing card — FileCard previews and human summaries; one file peeks, several is a short grid. No retrieval snippet or score.',
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
    id: 'document-rename',
    mobile: true,
    path: '/dev/document-actions',
    description:
      'Renaming a document. The field holds the STEM and the extension sits beside it as a fact about the bytes, so nobody can rename a PDF into something else; a document that already carries a rename offers to restore its file name in the same dialog. Behind it, the resting state of the overflow trigger in a preview header — the control has to be ignorable until it is wanted.',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'document-delete',
    mobile: true,
    path: '/dev/document-actions?variant=delete',
    description:
      'Deleting a document, through the shared destructive ConfirmDialog. This replaces a full-width red button in the preview\u2019s metadata rail whose confirm step expanded IN PLACE, pushing the rest of the column down: the question now names the file, the answer says what is lost, focus is trapped, and the dialog cannot be dismissed mid-request.',
    waitFor: '[role="dialog"]',
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
    id: 'file-preview-model',
    mobile: true,
    path: '/dev/file-preview-model',
    description:
      'The same file-preview modal opened on an .ifc — a model is just another file, previewed as the building rather than as a page mock, with the analytical workspace one link away. Headless Chromium has no WebGPU adapter (as on /dev/bim-model), so what this pins is the degraded state a Safari or Firefox user sees: it must read as "the picture is missing, everything else is over there", never as "this file is broken".',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'file-preview-model-archiv',
    mobile: true,
    path: '/dev/file-preview-model?shelf=archiv',
    description:
      'The same model previewed from the org-wide Archiv, which has no project. Compare it with `file-preview-model`: the building, the Aus-dem-Modell figures and the metadata rail are identical, and the ONLY difference is that "Im Modellbereich öffnen" is absent, because the model workspace is a project surface. What this pins is that the shelf no longer decides whether a model can be looked at — this surface used to render the grey "no inline preview" placeholder for a file that had been parsed, indexed and listed as ready.',
    waitFor: '[role="dialog"]',
  },
  {
    id: 'upload-tray',
    mobile: true,
    path: '/dev/upload-tray',
    description:
      'The upload surface in all four stages plus the explorer detail view. The point of the shot is that the stages look DIFFERENT: a determinate track with a percentage only while bytes are in flight, an indeterminate sweep with an elapsed time while the backend indexes, a settled mark with no track at all, and a failed row carrying the server\u2019s own reason next to a retry. The old surface drew one bar across all four and sat at a hard-coded 15%.',
    waitFor: '[data-testid="upload-tray"]',
  },
  {
    id: 'file-browser',
    mobile: true,
    path: '/dev/file-browser',
    description:
      'The Files page as a page. Three things moved at once and they only make sense together: the search left the listing for the header band, where every other control on this screen already was; the grid moved inside the app\u2019s own content column instead of running edge to edge, so four previews fill a row where six stamps used to; and the folder chip row became tiles that carry what is inside each folder. Compare the preview height with `document-grid` \u2014 the chat card keeps the compact metric, because widening cells in a chat column costs it a column.',
    waitFor: '[data-testid="file-card"]',
  },
  {
    id: 'file-browser-uploading',
    mobile: true,
    path: '/dev/file-browser?variant=uploading',
    description:
      'The grid a second after a batch lands — the one row where the cards are not all the same shape. A document still being read has no AI summary yet, and the leftmost one already shows its page preview because a PDF thumbnail is produced at upload time while the rest of ingestion runs after it. Two things are pinned here: skeleton lines HOLD the description slot on the unsettled cards rather than leaving a blank gap that reads as a card which failed to render, and every tile reaches the bottom of its cell so the size · time footers line up across the row. Before, the short tile kept its natural height inside the stretched cell and its footer floated mid-card over a band of dead space.',
    waitFor: '[data-testid="file-card"]',
  },
  {
    id: 'file-browser-search-failed',
    path: '/dev/file-browser?variant=search-failed',
    description:
      'A semantic search that could not RUN, held apart from one that ran and found nothing. The hook fails open to an empty hit list so the pane cannot crash, and reports which of the two happened — but nothing read that flag, so a backend timeout rendered as "Keine semantischen Treffer für …": the surface told the reader something about their own corpus that the app had no way of knowing, and offered them a reset for it. The retry re-runs the SAME query, because they had already typed it once.',
    waitFor: '[data-testid="file-browser-search-failed"]',
  },
  {
    id: 'document-actions-move',
    path: '/dev/document-actions?variant=move',
    description:
      'Where a document can be re-filed to. Folders were create-only for the FILE as well as for themselves: `documents.folder_id` was written at upload and had no second writer, so a document dropped in the wrong folder stayed there. Each destination is named by its whole path (two projects can both have a \u201cFluchtwege\u201d), the folder it is in now carries a check and is not offerable, and the project root is a real destination rather than the absence of one. The submenu trigger also gets shadcn\u2019s own `gap-2` and `[&_svg]` rules back \u2014 they were dropped when this file was vendored, so its icon sat flush against its label while every ordinary row beside it was spaced.',
    waitFor: '[data-slot="dropdown-menu-sub-content"]',
  },
  {
    id: 'document-actions-moved',
    path: '/dev/document-actions?variant=moved',
    description:
      'The same submenu with a destination actually picked, printing what reached `onMoved`. It exists because jsdom never delivers a synthetic click to a submenu item \u2014 the unit test can assert what the menu OFFERS but not that choosing works, so this is where the selection itself is verified, in a real browser, against a shimmed PATCH.',
    waitFor: '[data-testid="document-moved-result"]',
  },
  {
    id: 'file-browser-search-list',
    path: '/dev/file-browser?variant=search-list',
    description:
      'A semantic search answered in the DETAIL view. The card/list toggle was read only on the un-searched branch, so pressing Enter threw a reader who had deliberately chosen the list back into cards, and clearing the query threw them back again. The ranking comes with it: relevance is the column the list opens sorted by \u2014 its own default is newest-first, which would have silently discarded the order the backend ranked \u2014 and every row carries the passage that matched, with its page, in the slot the summary usually holds.',
    waitFor: '[data-testid="file-list-relevance"]',
  },
  {
    id: 'file-browser-folder-tiles',
    mobile: true,
    path: '/dev/file-browser?variant=folder-tiles',
    description:
      'Inside a folder \u2014 the level the chip row could never reach. Chips listed TOP-LEVEL folders only, so \u201cFluchtwege\u201d existed nowhere but the tree view, and a chip carried a name with nothing behind it where a tile carries what is inside (subfolders counted, so a folder whose files all sit one step down is not reported as empty). The trail above is the way back out: tiles only drill down, so without it this level would be the dead end the chips never were.',
    waitFor: '[data-testid="folder-tile"]',
  },
  {
    id: 'file-browser-folder-menu',
    path: '/dev/file-browser?variant=folder-menu',
    description:
      'A folder row\u2019s own \u22ef menu. Folders were create-only: a name typed wrong stayed wrong, and a folder made by mistake stayed in the tree forever. Rename and Delete now sit on the folder itself, one hover away, with the destructive one carrying its own colour \u2014 and the trigger stays lit while its menu is up, so the control that opened it does not vanish underneath the reader.',
    waitFor: '[role="menuitem"]',
  },
  {
    id: 'file-browser-folder-rename',
    path: '/dev/file-browser?variant=folder-rename',
    description:
      'Renaming a folder happens in the row itself \u2014 same indent, same width, pre-filled with the current name. The reader is looking at the name they want to change, so a dialog would take it off screen to ask about it. Enter commits, Escape cancels, an unchanged name makes no request at all, and a failed save leaves the field open with the typed text intact.',
    waitFor: '[data-testid="folder-rename-input-f-brand"]',
  },
  {
    id: 'archiv-library',
    mobile: true,
    path: '/dev/archiv-library',
    description:
      'The org Archiv sheet — back control, gold Büroarchiv identity row with the document count, search, category chips and the card grid inside one raised frame. The grid itself stays comparable with the Files browser; what is pinned here is the chrome around it, including the back control — the trail is seeded with a project visit, so it shows what it shows in the app, the NAME of the project the reader came out of — and the bottom scroll boundary that dissolves the last row instead of clipping it.',
    waitFor: '[data-testid="archiv-document-card"]',
  },
  {
    id: 'archiv-library-loading',
    mobile: true,
    path: '/dev/archiv-library?state=loading',
    description:
      'The Archiv while it loads. Evidence for the transition, so compare it band for band with `archiv-library`: chip row and card cells sit at the same heights in the same bordered bands, which is what stops the whole surface from jumping when the documents arrive. The search row is no longer one of those bands \u2014 the field sits in the identity row above, which is drawn either way, so there is nothing left to reserve for it.',
    waitFor: '[aria-busy="true"]',
  },
  {
    id: 'settings',
    mobile: true,
    path: '/dev/settings',
    description: 'Project settings — section chrome, headings, and danger zone.',
    waitFor: 'h1',
  },
  {
    id: 'project-chrome',
    mobile: true,
    path: '/dev/project-chrome',
    description:
      'Shared project section chrome — breadcrumb + title + subtitle + actions — every section that uses it, grouped as Work (Files, History), Automate (Jobs, Skills), Project (Knowledge, Settings, Setup) and Organization (Archiv, Inbox). Chat is the documented exception and is not shown.',
    waitFor: '[data-testid="project-chrome-preview"]',
  },
  {
    id: 'shortcuts',
    mobile: true,
    path: '/dev/shortcuts',
    description:
      'Keyboard-shortcuts cheatsheet (?) with every capability on — the widest sheet a user can be shown. Rows are derived from the shortcut registry, which reads the same IA the rail and the ⌘K palette render, so the navigation group here IS the navigation: a section cannot gain a rail entry without appearing with its jump key. Two balanced columns on desktop (the full set fits without scrolling), physical keycaps, and a footer band outside the scroll region so the way to turn the feature off never dissolves into the fade.',
    waitFor: '[data-shortcut-group="navigation"]',
  },
  {
    id: 'shortcuts-minimal',
    path: '/dev/shortcuts?variant=minimal',
    description:
      'The same sheet for a plain member with no optional feature enabled — the floor. Workflows, Knowledge, Archiv, Inbox, Organization and the mention row are all gated off, so this is the proof that the sheet stays composed (and keeps its column balance) when the registry shrinks, instead of leaving eyebrow labels above empty cards.',
    waitFor: '[data-shortcut-group="navigation"]',
  },
  {
    id: 'cards-gallery',
    mobile: true,
    path: '/dev/cards',
    description:
      'Full Grid card gallery — every card type with fixture data, pinned to German so a translated string cannot render in English beside the cards whose copy is hardcoded. Captured on a phone as well, because the schematics are drawn geometry rather than styled boxes: a drawing that outgrows the card is clipped at its edge with the dimension number on the wrong side of the cut, and only the mobile shot shows it.',
    waitFor: 'main',
  },
  {
    id: 'card-reveals',
    mobile: true,
    path: '/dev/card-reveals',
    description:
      "The cards whose value is behind a click, driven into that state before the shot. The Rechenweg with its sources open (provenance tag, ± band and where each figure is written down, plus the line saying the card computed the result rather than copying it); the same card on a derivation whose exact result would ROUND onto the other side of its limit, which is the shot that proves the printed number and the printed verdict cannot disagree; and the Verfahrensablauf with a step opened AGAINST the one the project is at — dashed chrome, the correcting sentence inside the panel, while the current row keeps its node and its \u201Ehier stehen Sie\u201C chip. Then the three later cards in the state that carries their point: a conditional Einreichunterlage opened onto the case that makes it necessary, under a tally the card counted from its own rows (including the three documents nobody has asked about); a Frist opened onto what happens when it lapses, over a footer saying the rail is not to scale and no date is computed; and a change-impact card with NO known starting point, which says so in the header and again where the before/after pair would sit. None of it is visible in the gallery, which photographs every one of them folded.",
    waitFor: '[data-testid="card-reveals-preview"]',
  },
  {
    id: 'condition-tree',
    mobile: true,
    path: '/dev/condition-tree',
    description:
      "The Bedingungsbaum in its three states, in the real 680px thread column: the case that applies open at rest; another case opened AGAINST it (Konjunktiv lead, dashed chrome, „Nur zum Vergleich …\" inside the panel) while the active row keeps its tinted node, its outcome and its „trifft zu\" chip; and a tree with no case marked, which opens closed rather than picking one for the reader. The middle block is driven into the switched state before the shot, because that state — not the resting one — is what stops the wrong case being screenshotted into an Einreichung.",
    waitFor: '[data-testid="condition-tree-preview"]',
  },
  {
    id: 'report-outline',
    mobile: true,
    path: '/dev/report-outline',
    description:
      'The deep-research report\'s outline, on a report long enough for it to exist: the real ReportTab against a ~1.400-word report in a box the size of the research panel. Collapsed and scrolled into the middle (the sticky row names the section in view), and open (ten entries, H3 indented, the current one marked). Both claims are properties of the report around it, so neither is reviewable from the component alone.',
    waitFor: '[data-testid="report-outline"]',
  },
  {
    id: 'platform-skills',
    path: '/dev/platform-skills',
    description:
      'Platform \u2192 Skills \u2014 the catalogue Piloti writes for every organization, and the surface that replaced the per-tenant "clone a platform skill" button. Three row states, because they are the whole model: a published OFFER (on every org\'s Skills tab, each deciding whether to switch it on), a published STANDARD (running for the whole fleet, on nobody\'s tab, and not something a tenant can switch off or shadow) and a DRAFT (invisible fleet-wide, which is what makes this usable as a writing surface rather than a publish-on-save wire). The switch means published, not enabled; the select beside it is the one control that decides whether an organization gets a choice at all.',
    waitFor: '[data-testid="platform-skills-preview"] [role="switch"]',
  },
  {
    id: 'skills-panel',
    path: '/dev/skills-panel',
    description:
      'Agent Skills tab (ADR-0045) — FEATURED first (what Piloti curates for every organization, each with an activation switch), then the org\'s own skills, and NOTHING schedule-shaped: everything about when something runs moved to the Jobs tab. The pipeline\'s builtin skills are deliberately absent, because they are absent from the endpoint: they are machinery, nobody installs or edits one, and the clone button that used to sit on them is gone. The fixture covers a taken-up offer and an untaken one, plus an org skill in play and one switched off — the switch is the only state this page has an opinion about, so both positions have to be on screen.',
    waitFor: '[data-testid="skills-panel-preview"]',
  },
  {
    id: 'jobs-panel',
    path: '/dev/jobs-panel',
    description:
      'Jobs tab, list mode — the Files shape: a compact bordered bar (title, one-line subtitle, the single New-job action) over a card GRID that fills the pane, not a narrow centred column. A card leads with the PROMPT, not the skill, because the prompt is what the job is and the skill is the optional extra; the fixture carries two jobs with no skill and two with one, so "Ohne Skill" is visibly a stated fact rather than a blank. Both output kinds (Chat / Bericht) are on screen, plus a disabled job (dimmed, badge, run-now unavailable) and one with no cron, which reads "Nur manuell". Captured at 1200px, which is the 2-up band; 3-up starts at 2xl, chosen so the run/edit/delete row still fits on one line.',
    waitFor: '[data-testid="jobs-panel-preview"] [role="switch"]',
  },
  {
    id: 'job-builder',
    path: '/dev/job-builder',
    description:
      'The job builder editing a fully populated job, reached the way a user reaches it — the preview presses Bearbeiten on a real card, so the shot carries the panel shell the builder now shares with the list (same bar, same body, only the title and the action change). Its point is the right-hand pane: "Was der Agent erhält" shows the COMPOSED fire prompt — the job prompt, then the attached skill block, closing fence included — which is byte-identical to what the server submits when the job fires. The left column runs in the order the decisions happen (name → prompt → output → skill → sources → schedule) with deep-research selected, so the picker below it is the one that output can actually run.',
    waitFor: '[data-testid="job-prompt-preview"]',
  },
  {
    id: 'job-run-history',
    path: '/dev/job-run-history',
    description:
      'A job\'s run history with one row per outcome, which is the only place the product answers "where did this run end up?". Each row joins the recorded submission against the live backend job state, and that state picks BOTH the badge and the link: a finished chat run offers the conversation it minted, a finished deep-research run its report, a live one its progress, a failed one its thinking — and the skipped run, which never became a job, offers nothing rather than a dead link.',
    waitFor: '[data-testid="job-run-history-preview"] li',
  },
  {
    id: 'skill-composer',
    mobile: true,
    path: '/dev/skill-composer',
    description:
      'The composer half of Agent Skills (ADR-0045) — the `/` menu open on a typed fragment, with the invoked-skill chip below it. A row carries exactly the level-1 metadata the agent itself is given and nothing else: the token to type, with the matched fragment emphasised, and the sentence that says when to type it. The fixture matches the same fragment two ways, in the name and in the description only, which is the ranking the menu applies. The chip beneath states the CONSEQUENCE — these instructions will be loaded — because a `/token` in a sentence says nothing about what it does.',
    waitFor: '[data-testid="slash-command-picker"]',
  },
  {
    id: 'skill-composer-empty',
    path: '/dev/skill-composer?variant=empty',
    description:
      'The `/` menu for an organization that has authored no skills. Registered separately because this panel is the only place in the product that explains what a skill IS — the state a first-time user meets is the state that has to teach.',
    waitFor: '[data-testid="slash-command-picker"]',
  },
  {
    id: 'skill-editor',
    path: '/dev/skill-editor',
    description:
      'The two panes beside the skill editor form: the SKILL.md the form is writing, split at the seam that decides everything about how a skill behaves (frontmatter in the agent’s context on every turn, instructions loaded only on activation), and the reviewer’s verdict on the draft beneath it. The draft is deliberately mediocre — a description that never says when to use the skill — so the findings show all three severities across all three fields rather than a clean bill of health that would prove nothing. The preview presses the check itself, because findings do not exist until somebody asks for them.',
    waitFor: '[data-testid="skill-review-findings"]',
  },
  {
    id: 'skill-editor-advanced',
    path: '/dev/skill-editor-advanced',
    description:
      'The skill editor’s advanced section — the whole SKILL.md, editable, folded away under the form. Both of its open states are on one page because the section’s only output while open is which of them it is in: a document that parses and differs from the form, where applying is live, and one whose frontmatter was never closed, where the reason is named and applying is refused. It has a route of its own because it sits at the bottom of a tall dialog and never appears in the editor shot.',
    waitFor: '[data-testid="skill-raw-document"] textarea',
  },
  {
    id: 'skill-activation',
    mobile: true,
    path: '/dev/skill-activation',
    description:
      'What the agent actually LOADED while writing an answer, in both of its states on one page: the quiet one-line summary under the answer, and the same disclosure opened, where each activated skill is named with the description that was fetched only on expand. One activated skill has since been renamed and so has no description — its row keeps the name rather than disappearing, because the answer really was written with it.',
    waitFor: '[data-testid="skills-used-panel"]',
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
    id: 'platform-knowledge-selection',
    mobile: true,
    path: '/dev/platform-knowledge-selection',
    description:
      'Base-knowledge selection toolbar — the bulk bar that replaces the search row once documents are ticked: change document type, re-index the selected documents, remove them.',
    waitFor: '[data-testid="data-toolbar-selection"]',
  },
  {
    id: 'project-reindex',
    mobile: true,
    path: '/dev/project-reindex',
    description:
      'Project settings — the knowledge-index card that rebuilds every document’s chunks, shown at rest and in flight. It sits above the danger zone because it destroys nothing a user uploaded, only the derived index answers are grounded on.',
    waitFor: '[data-testid="project-reindex-preview"]',
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
      'Platform default models and thinking levels — the model each agent group runs on and how hard it thinks, for every organization that has not chosen its own. Shows all three per-group model states (pinned, still on the workflow config, and pinned to a model with no zero-data-retention endpoint, which is flagged because ZDR tenants cannot inherit it) plus the thinking level on the same row, pinned at both ends of the scale and inheriting the concrete workflow level elsewhere.',
    waitFor: '[data-testid="platform-models-preview"]',
  },
  {
    id: 'platform-retrieval',
    mobile: true,
    path: '/dev/platform-retrieval',
    description:
      'Platform retrieval settings — the fleet-wide retrieval counts (knowledge chunks, surfaced files, web/RIS results) every query resolves against. Shows both per-key states: pinned to a platform value and still on the build-time config default.',
    waitFor: '[data-testid="platform-retrieval-preview"]',
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
    id: 'platform-cards',
    mobile: true,
    path: '/dev/platform-cards',
    description:
      "Platform → cards: the agent's presentation vocabulary as a gallery. Each entry is a REAL render through the same GridCards dispatcher chat uses, so the page cannot advertise a card the renderers do not produce — a Stellplatznachweis with a failing count beside a passing one, a legal-basis excerpt, the system-emitted memory proposal carrying both badges (and inert, because a gallery must not be able to fire the write behind its Yes), and the IFC viewer described rather than faked because it needs a loaded model. The values each card carries expand underneath, and the request-a-card link sits in the header and again at the foot, where the reader who found nothing has arrived.",
    waitFor: '[data-testid="platform-cards-preview"]',
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
      'What happens when you USE a citation: inline [N] markers tinted by the provenance family of the source they name (three OIB passages and one binding legal source, distinguishable mid-sentence), each previewing document\u2009\u00b7\u2009authority\u2009\u00b7\u2009page\u2009\u00b7\u2009passage in place and marking the chip it belongs to \u2014 rendered through the real AgentResponse in both shells. Includes a claim carried by two sources, written [2][3], as the two separate pills it must render as.',
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
    id: 'platform-storage',
    path: '/dev/platform-storage',
    description:
      'Platform storage table (ADR-0042) — the operator side of the quota. A table rather than meters, because the question here is comparative ("who is about to cause a problem") rather than personal, and rows are ordered by consumption so the answer is at the top. The fixture covers every row state that has to be distinguishable at a glance: over quota, near quota, comfortably within, explicitly unlimited, and inheriting the platform default. One org has no display name so the id fallback is visible, and sizes span GB to MB to exercise the byte formatter across units. Editing is inline and one row at a time — a quota is a per-tenant commercial commitment, so there is no bulk path.',
    waitFor: '[data-testid="platform-storage"]',
  },
  {
    id: 'storage-usage',
    mobile: true,
    path: '/dev/storage-usage',
    description:
      'Organization storage panel (ADR-0042). One meter, because there is one question: how close is this tenant to being cut off. The track IS the quota, so the fill is literal rather than rescaled, and it carries STATE (within / at-or-over) rather than category — the two scopes below are a text breakdown, not a stacked bar, because project-vs-Archiv is not the decision anyone opens this page to make. Rendered twice, from two named fixtures rather than by call order: the within-quota card at 82%, so the meter is visibly filling without being in the error state, and the over-quota card with the critical fill and the limit tick. The two scopes differ by an order of magnitude to exercise the byte formatter at both GB and MB. The panel is read-only for EVERY role including org admin — the quota belongs to the platform operator, and the editor lives in Platform → Storage.',
    waitFor: '[data-testid="storage-usage"]',
  },
  {
    id: 'budget-usage',
    mobile: true,
    path: '/dev/budget-usage',
    description:
      'Organization spend card (ADR-0015) after the dataviz pass. Three forms for three questions: two meters for "am I about to be cut off" (fill carries STATE, not model identity — accent within the limit, critical status step at or over it, with a limit tick only in the over state), a full-width stacked bar plus its always-open table for "where is the money going", and the 30-day trend for "is it getting worse". The fixture deliberately shows one meter within its limit and one over it, and enough models to exercise the 8-slot palette plus the neutral Other fold. The table is not a toggle: light-mode aqua/yellow/magenta fall under 3:1 contrast, so a text path to every value is obligatory, not optional.',
    waitFor: '[data-testid="spend-composition"]',
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
    id: 'answer-feedback',
    mobile: true,
    path: '/dev/answer-feedback',
    description:
      'Platform \u2192 answer quality: the thumbs users leave on answers, across every organization, and the questions behind them \u2014 both halves. Opens with an AI-written summary of the window (what is working and what needs attention as peer columns, with its age and the "written by AI" provenance beside it), then the HELPFUL rate as the headline, a trend where up means better, the four-bar breakdown of why answers missed (zero-filled, so a reason nobody picked still shows), a per-topic table sorted best-first, the per-organization rollup, and a drill-in that switches between the answers that landed and the ones that missed. Includes the honest edge cases: a vote whose turn was never persisted has no question to show and says so, and a topic or tenant below the rate floor keeps its counts and withholds the percentage.',
    waitFor: '[data-testid="answer-feedback-preview"]',
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
      "A shared thread with three people plus the agent (spec CC-4/CC-5/CC-13/CC-19): every human message attributed, one author's consecutive messages GROUPED under a single header, the unread separator, an @Piloti mention chip, and the turn-in-flight banner telling an observer whose question the agent is answering. All four voices distinguishable — colleague, you, the agent's answer, the agent's status.",
    waitFor: '[data-testid="shared-thread-preview"]',
  },
  {
    id: 'shared-thread-live',
    mobile: true,
    path: '/dev/shared-thread?variant=live',
    description:
      "The same shared thread with liveness on (ADR-0039). The observer WATCHES the colleague's turn — the Herleitung building and the answer streaming in — instead of a banner that says only that something is happening; and Anna is composing alongside it. The two live signals stay visually distinct on purpose: the agent keeps the Piloti glyph and the shimmering label, a person gets their avatar and three bouncing dots, so a reader can tell a machine working from a colleague thinking without reading a word.",
    waitFor: '[data-testid="spectated-turn"]',
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
  {
    id: 'organization-access-people',
    mobile: true,
    path: '/dev/organization-access',
    description:
      'Organization → Access, People: the member directory under the real sub-tab strip. The roster is chosen for the states that are easy to get wrong — a role the catalog knows (rendered as "Billing Admin", slug kept underneath), a CUSTOM role it does not (must degrade to the raw slug, never to "unknown"), a membership with no role at all, a pending invitation, and a member WorkOS knows only by email. The WorkOS management widget that normally sits beneath is suppressed: it needs a live token endpoint, and a backend-free route would capture it as a spinner.',
    waitFor: '[data-testid="people-directory"]',
  },
  {
    id: 'organization-access-roles',
    mobile: true,
    path: '/dev/organization-access?view=roles',
    description:
      'Organization → Access, Roles: every role in `lib/authz/catalog.ts` grouped by tier in reading order (organization → project → workflow → platform), each with the human name of every permission it grants and the slug in muted mono. The platform group is deliberately SHOWN and marked not-assignable-here rather than hidden — "exists, but not for you" is the real access rule, and the marker keys off `scope: platform-org`, the property WorkOS actually refuses on.',
    waitFor: '[data-testid="role-catalog"]',
  },
  {
    id: 'organization-access-permissions',
    mobile: true,
    path: '/dev/organization-access?view=permissions',
    description:
      'Organization → Access, Permissions: the catalog inverted — every permission with the roles that grant it, computed from `ROLES` at render rather than stored, so it cannot drift. Deprecated permissions (`project:edit`) and WorkOS-owned ones (`widgets:*`) are marked instead of hidden, because an admin auditing a role meets those slugs either way.',
    waitFor: '[data-testid="permission-reference"]',
  },
  {
    id: 'bim-model',
    mobile: true,
    path: '/dev/bim-model',
    description:
      'The IFC/BIM model page (ADR-0045): overview stats read from the model itself, the spatial tree with signed storey elevations, the element table filtered to the selected storey, the property panel for the selected wall (occurrence + type-inherited Pset merged), and — in place of the 3D viewport — the no-WebGPU fallback. Headless Chromium has no WebGPU adapter, so the fallback IS what this route captures, which is the right thing to pin: it is what a Safari or Firefox user sees, and it has to read as "the picture is missing", never as "the feature is broken".',
    waitFor: '[data-testid="bim-model-preview"]',
  },
  {
    id: 'bim-tables',
    mobile: true,
    path: '/dev/bim-tables',
    description:
      'The model surfaces that produce work products rather than views: the Raumbuch with a room that publishes no area (shown as missing, counted against the storey total, and named in the banner), the Massenermittlung split by material with a group that publishes nothing, the revision timeline with signed per-step deltas, the derived project facts with the evidence behind each one, and an element chip as it renders inside a chat answer. Every fixture here includes the awkward case on purpose — a total that quietly excludes rooms is the failure this whole subsystem exists to prevent, and only the incomplete fixtures can show that it does not.',
    waitFor: '[data-testid="bim-tables-preview"]',
  },
  {
    id: 'bim-confirmation-failed',
    path: '/dev/bim-confirmation-failed',
    description:
      'A manual confirmation on an OIB requirement that could NOT be saved. The write used to fail silently \u2014 the note form simply stayed open \u2014 so an architect who had just signed off a requirement had every reason to believe it was recorded, on the one surface whose whole purpose is to be a record. The alert now carries the same weight as a verdict and says plainly that the confirmation is NOT stored. The preview drives the form itself and the capture waits on the alert, because the state does not exist until somebody presses Save.',
    waitFor: '[data-testid="bim-confirmation-failed"]',
  },
  {
    id: 'bim-compliance',
    mobile: true,
    path: '/dev/bim-compliance',
    description:
      'The Prüfbuch: OIB requirements evaluated against the values the model publishes. The fixture is deliberately a MESSY project, because a green list would prove nothing — two failing doors with the reading that produced each verdict, thirty-four walls whose fire rating the model never published, a wall declared "F 90" that the catalogue refuses to score against REI 60 rather than raising a false alarm, a rule that stood down because the brief carries no Gebäudeklasse, and a rule with no affected elements. Every row prints the threshold it applied so the architect checks the rule and not only the result, "not decidable" carries the same visual weight as a failure, and the missing-property list is rendered as actions to take in the CAD rather than as a score. The header carries a BCF 2.1 download of exactly the rules that leave work behind, so the open items land back in ArchiCAD or Revit as an issue list with the affected elements selected.',
    waitFor: '[data-testid="bim-compliance-preview"]',
  },
  {
    id: 'bim-cards',
    mobile: true,
    path: '/dev/bim-cards',
    description:
      'The four model-backed chat cards — Raumbuch, Bauteil, Anforderungen, Revisionsvergleich. Each carries an identifier and fetches its own numbers, so the agent can point at the wrong table but can never state a floor area the model does not publish. The fixtures show the hard states rather than the happy ones: a storey where two rooms publish no area so the total is visibly a subset, a wall whose Pset and Qto come from the model, one requirement nothing can decide (34 walls with no fire rating) beside the BCF download that turns it into work, and a revision whose single added door is only meaningful against the 99 unchanged elements behind it.',
    waitFor: '[data-testid="bim-cards-preview"]',
  },
  {
    id: 'bim-viewport',
    mobile: true,
    path: '/dev/bim-viewport',
    description:
      'The model viewer\'s chrome, over the muted panel the stage itself uses. The canvas needs WebGPU and headless Chromium has none — /dev/bim-model pins the fallback for that reason — but every control is now an atom that owns no canvas, so the whole of what an architect touches is capturable. Four states: the stage (rail of models and levels on the left, a floating dock at the bottom, nothing at all in the middle — the building is the surface), the selection card that does not exist until something is selected and leads with "Wall" rather than with IfcWallStandardCase, that card again with Isolieren pressed — the one control on it that survives its own press, so the only one that has two states to draw; it read as a one-way door for exactly as long as it drew them the same — and the two loading states, which differ on purpose: a download reports its real percentage, and geometry-building reports none, because it has no honest one and the mesh count it used to show measured the exporter\'s tessellation settings rather than the wait. The three ways back are drawn together on purpose, because their names are the whole distinction between them: Undo takes back the last thing the reader did (a level, a cut, a hide, an isolate — one press, one act), the camera button re-frames the building without changing anything, and the reset drops every hide and isolation at once. All three used to be reachable and two of them were called some version of "show everything".',
    waitFor: '[data-testid="bim-viewport-preview"]',
  },
  {
    id: 'composer-subject',
    mobile: true,
    path: '/dev/composer-subject',
    description:
      'Native chat when Ask Piloti is about a project file: the subject bar (project-green) sits in the composer, same pipe as ?ask= / IFC / standards. Not a second chat.',
    waitFor: '[data-testid="composer-subject-bar"]',
  },
  {
    id: 'file-chat-dock',
    mobile: true,
    path: '/dev/file-chat-dock',
    description:
      'Ask Piloti from a file: chat is home, the file sits as a right-hand peek of what you are talking about — not a 50/50 split.',
    waitFor: '[data-testid="file-chat-dock"]',
  },
  {
    id: 'file-ask-split',
    path: '/dev/file-ask-split/chat',
    description:
      'The file-ask split as the project layout actually mounts it: FilePreviewBridge wrapping the chat column inside the shell\u2019s scrolling <main>. Distinct from file-chat-dock, which hand-rolls the peek and therefore stays green no matter what the real split does \u2014 the pane was never the broken half.',
    waitFor: '[data-testid="file-ask-split-preview"]',
  },
  {
    id: 'file-ask-split-arrive',
    path: '/dev/file-ask-split/chat?variant=arrive',
    description:
      'The same split reached the way Ask Piloti reaches it. `FilePreviewBridge` is mounted by the PROJECT layout, so on this journey it mounts in Files with the split OFF and its file panel collapsed, and only opens once chat is reached. That transition shipped broken: the pane rendered in peek mode inside a zero-width panel parked off the right edge, while every other check \u2014 mode, mount count, and the hand-rolled file-chat-dock mockup \u2014 stayed green. Held apart from `file-ask-split`, which mounts with the peek already open and therefore cannot see it.',
    waitFor: '[data-testid="file-preview-host"][data-mode="peek"]',
  },
  {
    id: 'file-ask-split-wide',
    path: '/dev/file-ask-split/chat?variant=wide',
    description:
      'The file peek opened wide — a remembered width of 720px, which the 1200px capture viewport trims to about 578px because the chat column keeps its own 40% floor. That trim is half the evidence: the two constraints meet without either column collapsing. The other half is that this state exists at all — the seam fought the drag after about twenty pixels and the ceiling stood at 560px, so nobody could reach it. Held beside `file-ask-split` (the 320px default) because the ratio is what needs reviewing: what the transcript does with the width it is left, and whether the peek toolbar still reads at the far end of the range.',
    waitFor: '[data-testid="file-ask-split-preview"]',
  },
  {
    id: 'file-ask-split-indexing',
    path: '/dev/file-ask-split/chat?variant=indexing',
    description:
      'The peek on a document that is still being read. Its status rides in the peek toolbar — the modal has carried it under the name since the day it was built, while the peek, the one surface that exists because this file is what the next question is about, showed a file the agent cannot cite yet as identical to one it can. Silent for a ready document, so the chrome stays quiet; here it is the answer to "why did the answer not use my file". Also the shot that holds the toolbar band: 48px, held 10px off the top, on the same line as the chat pills across the seam.',
    waitFor: '[data-testid="file-ask-split-preview"]',
  },
  {
    id: 'file-ask-split-failed',
    path: '/dev/file-ask-split/chat?variant=failed',
    description:
      "The peek on a document whose indexing failed — the one state here that will not resolve itself, and therefore the one that carries a way out rather than only the bad news. Destructive tint (the indexing strip stays on the quiet ground, since that one settles on its own), and a Details control that opens the enlarged view where the ingestion error and its retry live. Held as its own shot because 'we told you and left you there' is exactly the state a screenshot review would otherwise never see.",
    waitFor: '[data-testid="file-ask-split-preview"]',
  },
  {
    id: 'file-ask-split-gone',
    path: '/dev/file-ask-split/chat?variant=gone',
    description:
      'The document is not there any more — deleted by a colleague, or no longer this reader\u2019s to open; the service answers 404 for both. The pane used to offer "Erneut versuchen" here, a button that could be pressed until the reader gave up, because nothing distinguished a permanent 404 from a hiccup. It now says what happened and offers the one move left: stop asking about it, which is also the only thing that cannot be done from inside a viewer that will not load.',
    waitFor: '[data-testid="file-ask-split-preview"]',
  },
  {
    id: 'file-ask-split-dismissed',
    path: '/dev/file-ask-split/chat?variant=hidden',
    description:
      'The peek put away — and the tab it left on the edge it went out through. Dragging the seam shut, Escape and the ✕ all land here, and until this shot existed the state had no picture at all: the chat simply reclaimed the row and the only way back was a control in the composer that belongs to the question rather than to the viewer. The tab reopens the document at the width the reader had chosen. It is the state that proves no gesture on this surface is one-way.',
    waitFor: '[data-testid="file-ask-split-preview"]',
  },
  {
    id: 'projects-home',
    mobile: true,
    path: '/dev/projects-home',
    description:
      'Projects home at nine projects — the size the page is actually used at. The three the viewer has worked in sit on the resume rail as large cards ordered by their OWN last message (12 minutes, 3 hours, yesterday), and the remaining six are rows: initials tile on the left to index a scan by, brief, status, document count and timestamp in right-aligned tabular columns. The page used to be one uniform card grid sorted oldest-first, so the project touched ten minutes ago rendered below three nobody had opened. The rail is a fixed three regardless of how many projects exist, which is what stops the page changing shape as the list grows.',
    waitFor: '[data-testid="projects-home-preview"]',
  },
  {
    id: 'projects-home-fresh',
    path: '/dev/projects-home?variant=fresh',
    description:
      'The same page for someone who has not worked in any project yet: the rail is filled by project recency instead, and the heading says "Your projects" rather than "Pick up where you left off". The label is load-bearing — the data cannot support a "continue" claim here, and the row timestamps fall back to the project’s own last movement.',
    waitFor: '[data-testid="projects-home-preview"]',
  },
]
