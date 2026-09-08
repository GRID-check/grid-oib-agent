# Büro-Chat and the knowledge hierarchy — UI/UX design

**Status:** Design, follows the decision brief (D4 and D5). The five decisions in
that brief are given; this document elaborates them into components, copy and
flows. Where the code contradicts a decision, the contradiction is recorded in
§10 and the decision stands.

**Reads against:** [`grid-design-language.md`](grid-design-language.md),
[`project-surfaces.md`](project-surfaces.md),
[`click-dummy-overhaul-spec.md`](click-dummy-overhaul-spec.md) §5,
[`../adr/0026-unified-source-kind-model.md`](../adr/0026-unified-source-kind-model.md),
[`../adr/0047-document-shelf-travels-as-data.md`](../adr/0047-document-shelf-travels-as-data.md),
[`../user-guides/chat.md`](../user-guides/chat.md),
[`../ux/visual-screenshots.md`](../ux/visual-screenshots.md),
[`../../frontends/ui/AGENTS.md`](../../frontends/ui/AGENTS.md).

---

## 1. Purpose, and the one-line rule

Piloti gains a second place to ask: the **Büro**, at `/app/chat`, above any
project. Same agent, same composer, same transcript, same Herleitung. What
changes is what it may read and what it may name.

**The rule, in one line: the Büro and a project chat are the same `MainLayout`;
the scope chip and the missing rail are the only visual difference; and the
reader must never be one glance away from knowing which of the two they are in.**

Everything below is a consequence of that sentence. The two surfaces are built
from one component tree on purpose — the alternative is two chat screens that
drift on the first token retune, which is the failure
[`project-surfaces.md`](project-surfaces.md) was written about. But a surface
that is deliberately identical needs its *one* difference to be loud, legible
and repeated, because the cost of confusing them is not cosmetic: it is an
architect reading a Baurecht-only answer as if it had considered their project.

The second half of the work is the hierarchy control. Today the composer's scope
chip opens a popover with one true row ("Aktuelles Projekt") and one disabled row
("Alle Projekte · Bald verfügbar"). It becomes the **Wissensbasis** tree — the
one place, on both surfaces, that states the knowledge levels in authority order
and says which of them this turn may read. It ships on the project chat in the
same change, because a hierarchy control that exists only in the Büro teaches
nothing about the project chat the reader spends their day in.

---

## 2. Information architecture

### Routes

| Route | Chrome | What it is |
|---|---|---|
| `/app/chat` | `OrgHeader` (no rail) | **The Büro.** `WorkspaceChatClient` → `MainLayout` with `projectId = null`, `scope = 'workspace'` |
| `/app/chat?session=<id>` | — | Unchanged: the existing inbox deep-link resolver. A conversation with a `projectId` still redirects into that project's chat; a workspace conversation now resolves to `/app/chat` itself and renders |
| `/app/chat?mount=<projectId>` | `OrgHeader` | The Büro with that project pre-mounted (the target of "Im Büro fragen →") |
| `/app/projects/[id]/chat` | `AppSidebar` | Unchanged |

`AppShellChrome` needs no change: `projectIdFromPathname('/app/chat')` already
returns `null`, so the Büro gets the org header for free. That is the point of
D5 — the chrome difference is not implemented, it is inherited.

### Navigation entries

| Where | Entry | Detail |
|---|---|---|
| `OrgHeader` | **"Piloti fragen"**, first, before Archiv and Postfach | `MessageSquare`, the same icon `project-sections.ts` gives the project's chat. Rendered with **icon + label** while Archiv and Postfach stay icon-only: it is the org scope's primary job-to-be-done, and the header holds a wordmark and three controls, so there is room. Below `sm` it collapses to the icon with its tooltip |
| Project rail, `org` group | **"Büro"** | `Building2`, `href: '/app/chat'`, `group: 'org'`, above Archiv and Postfach — the group the IA already calls the cross-project doorways. New `ProjectSection` row with `gate: 'canAccessWorkspaceChat'` (the `workspace-chat` flag) |
| ⌘K | **"Piloti fragen (Büro)"** | The rail row carries `inPalette: true`, which puts it in the palette's *current project* group. That group is not rendered above a project, and above a project is exactly where the reader wants it — so the Büro is **also** added explicitly to the palette's `general` group, beside "Alle Projekte" |
| Keyboard | `g b` | `shortcutKey: 'b'` on the section row. `jumpTargets` derives the binding and the cheatsheet row from that one field, so the shortcut cannot drift from the IA |

### The two cross-links

**Project chat → Büro.** The scope tree's project row carries the action **"Im
Büro fragen →"** at the bottom of the tree, in the slot the disabled "Alle
Projekte · Bald verfügbar" row occupies today. It pushes
`/app/chat?mount=<projectId>`. This is the honest replacement for a control the
click dummy assumed and nobody had built ([`click-dummy-overhaul-spec.md`](click-dummy-overhaul-spec.md)
§2.3: *ship the picker disabled … do not fake it*) — the disabled row exists
because there was nothing behind it, and now there is.

**Büro → project.** A citation whose shelf is `project` offers **"Im Projekt
weiterfragen"** in its `CitationPeek`, pushing
`/app/projects/<id>/chat?ask=<the reader's question>`. It reuses the existing
`?ask=` prefill pipe that `project-chat-client.tsx` already consumes and strips
from the URL; no new mechanism.

### Titles and breadcrumb

- Tab title: **"Büro — Piloti"** from route metadata, matching the project
  chat's `"{Projekt} · Chat — Piloti"`.
- `ChatToolbar` breadcrumb: the project chat renders `{Projekt} / {Sitzung}`; the
  Büro renders **`Büro / {Sitzung}`**. The first segment is never empty and never
  omitted, because the first segment IS the scope. On a phone the project chat
  drops its first segment (documented behaviour); the Büro **keeps** it, because
  in a project the rail still names where you are and in the Büro nothing else
  would.

---

## 3. The psychology of scope clarity

A reader arriving at an answer must be able to answer four questions without
clicking anything, and each is owned by exactly one element.

| Question | Answered by | Always visible? |
|---|---|---|
| **Where am I?** | Chrome (rail vs. org header) · breadcrumb first segment · `ScopeChip` label | Yes, all three |
| **What can Piloti read right now?** | `ScopeChip` (scope + mounted count) · `MountedProjectsRow` ("Im Blick") | Yes |
| **Why did it read that?** | The answer's Herleitung, grouped by the same five levels · project attribution on the citation | On demand, one click |
| **How do I widen or narrow it?** | `ScopeTree`: "+ Projekt einblenden", per-mount remove, the link to the Datenbasis | One click |

Three carriers for "where am I" is deliberate redundancy. Two of them can be
absent at once — the rail is gone in the Büro and the breadcrumb is hidden on an
empty thread — and the chip survives both.

### The failure modes this is designed against

**1. A project question asked in the Büro, answered from Baurecht only, without
being told.** The reader types "wie haben wir das bei uns gelöst?", the agent has
no project corpus in scope, and a fluent OIB answer comes back. Nothing lied;
nothing said what was missing either.

Two guards. First, register recall: the agent names the projects that match and
offers to mount them, so the absence becomes a sentence in the answer rather than
a silence. Second, and structurally: **an absent knowledge level is rendered as
absent, never omitted.** The Herleitung shows all five levels; the project level
of a turn with nothing mounted reads "Projekt — nichts eingeblendet" in the
`--source-auto` gray, exactly the way a knowledge gap ("Lücke") is rendered
rather than hidden. A level that disappears when it is empty teaches the reader
that the hierarchy is whatever happened, and the whole point of a hierarchy is
that it is fixed and you can see the hole in it.

**2. Mounting a project silently.** The agent can widen its own scope mid-turn.
A widening the reader did not ask for and cannot see is a scope model they cannot
trust. Guard: every mount, agent or user, produces three simultaneous signals —
an inline notice in the transcript with an undo, a new chip in "Im Blick", and a
new row in the tree. There is no code path that mounts without all three, because
the chip and the row are rendered from the mount list and the notice is emitted by
the same store action.

**3. A project chat that looks identical to the Büro.** Guard: the missing rail,
the breadcrumb's first segment, the chip's glyph *and* label, and the Büro's own
empty state. The glyph matters on its own: the chip's label truncates at 44
characters and hides entirely below `sm`, so on a phone the glyph is the only
carrier left, and `Lock` vs `Building2` must be distinguishable at 14px.

**4. Reading "Büro" as "all our projects".** The most likely wrong model, and
copy is the only fix. The tree names the register level "Projektregister — Namen
und Steckbriefe, keine Dokumente" and the project level "Kein Projekt
eingeblendet"; the empty state's second example prompt is a register question,
not a corpus question. If the reader learns one thing from the empty state, it
should be that the Büro knows *which* projects exist and reads the ones you show
it.

---

## 4. Component inventory

Atomic layers per [`grid-design-language.md`](grid-design-language.md)
§"Component layers". Everything here composes kit atoms; nothing in this design
introduces a `<div className="…">` in an organism.

### Reused unchanged

`Popover` · `Command`/`CommandInput`/`CommandItem`/`CommandGroup`/`CommandEmpty` ·
`Item`/`ItemList`/`ItemMedia`/`ItemContent`/`ItemTitle`/`ItemActions` ·
`EmptyState`/`EmptyStateDisc` · `SectionLabel` · `Chip`/`ChipCount` · `Badge` ·
`Sheet` · `Skeleton` · `Alert` · `Button` · `CountPill` · `SourceSignalChip` ·
`iconForTint` · `Tooltip`. `MainLayout`, `ChatArea`, `ResearchPanel`,
`AnswerCitations` and `SourcePreview`'s resolution machinery are untouched.

### New and changed

| Component | Level | File | Composes | Props | States |
|---|---|---|---|---|---|
| `ScopeChip` | molecule | `features/layout/components/scope/ScopeChip.tsx` | `Button` (outline/sm), `ChipCount`, lucide `Lock`/`Building2`/`ChevronDown` | `{ variant: 'project' \| 'workspace'; label: string; mountedCount: number; disabled?: boolean }` | resting · hover · open (`aria-expanded`) · disabled (read-only chat) · label hidden `<sm` |
| `ScopeTree` | organism | `features/layout/components/scope/ScopeTree.tsx` | `SectionLabel`, `Item`+`ItemMedia`+`ItemContent`, `SourceSignalChip`, `Button`, `Command` (nested picker), `Sheet` (`<md`) | `{ levels: ScopeLevel[]; mounted: MountedProject[]; canMount: boolean; capReached: boolean; onMount(id); onUnmount(id); onOpenDataBasis(); onAskInWorkspace?() }` | loading (skeleton rows) · ready · mount pending (row spinner) · mount error (inline `Alert` + retry) · cap reached · empty project level |
| `scope-tree-model.ts` | pure model | `features/layout/components/scope/scope-tree-model.ts` | — | `buildScopeLevels({ scope, projectName, mounted, archivAvailable, sessionAttachmentCount, presetShelves })` | returns `ScopeLevel[]` with `state: 'on' \| 'off' \| 'unavailable' \| 'always'` |
| `MountedProjectsRow` | molecule | `features/layout/components/scope/MountedProjectsRow.tsx` | `SectionLabel` ("Im Blick"), `SourceSignalChip signal="project"`, `Button` (ghost, `×`) | `{ mounted: MountedProject[]; onUnmount(id); onOpenTree() }` | hidden at 0 mounts · 1–5 chips · horizontal overflow (`scroll-fade-right`) · removing (chip at `opacity-60`, no layout shift) |
| `ProjectMountPicker` | organism | `features/layout/components/scope/ProjectMountPicker.tsx` | `Command`, `CommandInput`, `CommandItem`, `CommandEmpty`, `Skeleton`, `Badge` | `{ mountedIds: string[]; capReached: boolean; onMount(id); onDeepResearch() }` | loading · ready · no readable projects (`EmptyState` bare) · all already mounted · cap reached (rows `aria-disabled` + visible reason) · fetch error |
| `WorkspaceEmptyState` | organism | `features/chat/components/WorkspaceEmptyState.tsx` | `EmptyState` (bare), hero greeting type step, `Chip interactive` ×3 | `{ firstName?: string; onPrompt(text, opts?) }` | greeting variants (morning/afternoon/evening) · with/without name |
| `ProjectAttribution` | molecule | `features/chat/components/ProjectAttribution.tsx` | `SourceSignalChip signal="project"` (`FolderKanban` for register rows), `Link` | `{ projectId: string; projectName: string; shelf: Shelf; onContinueInProject(): void }` | rendered only when `shelf ∈ {project, register}` **and** the conversation is `workspace` · link present/absent |
| `CitationPeek` (changed) | molecule | `features/chat/components/CitationPeek.tsx` | + `ProjectAttribution` | + `projectId`, `projectName` on `CitedDocument` | `DocumentHomeLink` now resolves the project from the citation, not from the store |
| `SourcePreview` (changed) | organism | `features/chat/components/SourcePreview.tsx` | — | index keyed by `(conversation, mounted project ids)` | project-shelf rows resolve per mounted project |
| `HerleitungLevels` | molecule | `features/chat/components/reasoning/HerleitungLevels.tsx` | `SectionLabel`, `SourceSignalChip`, the existing source cards | `{ groups: LevelGroup[] }` | all five levels always rendered · empty level (gray, "nichts eingeblendet") · project subgroup per project |
| `herleitung-levels.ts` | pure model | `features/chat/lib/herleitung-levels.ts` | — | `groupByLevel(traceLanes, citations)` | fixed order law → office → register → project(s) → conversation → web |
| `WorkspaceChatClient` | route client | `app/app/(shell)/chat/workspace-chat-client.tsx` | `MainLayout` | `{ canCollaborate, showSourceBadges, showConfidenceChip, showAnswerFeedback, showResearchInHistory, mountParam: string \| null }` | authenticated · signed out (`MainLayout`'s existing branch) |
| `SessionsPanel` (changed) | organism | `features/layout/components/SessionsPanel.tsx` | — | + `scope: 'project' \| 'workspace'` | Büro heading "Büro-Chats · N" · empty state · Deep-Research section hidden (no `projectCollection`) |
| `MountNotice` | molecule | `features/chat/components/MountNotice.tsx` | `Alert` (default variant), `Button` (link), lucide `FolderKanban` | `{ projectName: string; by: 'agent' \| 'user'; onUndo?(): void; undone?: boolean }` | fresh (undo offered) · undone (states so, no control) · undo failed (inline retry) |
| `MountCapNotice` | molecule | same file | `Alert`, `Button` | `{ max: number; onDeepResearch(): void }` | in the picker footer and, when the agent hits it, in the transcript |

#### `ScopeChip`

Today's chip is a `Button variant="outline" size="sm"` with a dashed
`--status-active` ring, the project name and a chevron. Two changes.

The dashed ring is replaced by a glyph: `Lock` for `project`, `Building2` for
`workspace`. The ring was ornament while there was one scope; with two, the
leading slot is where the distinction belongs, and the design language does not
allow a decoration to sit where a signal has to go. `size-3.5` — the badge/chip
glyph step. This also reconciles [`../user-guides/chat.md`](../user-guides/chat.md),
which has always described a lock the code never drew (§10, Q2).

The chip carries the mounted count as a trailing `ChipCount` when it is ≥ 1
("Büro · 2"). The count is on the chip and not only in the "Im Blick" row because
the row is the first thing a narrow viewport gives up, and the chip is the last.
`aria-label` spells the whole state: *"Suchbereich: Büro. 2 Projekte
eingeblendet. Öffnet die Wissensbasis."*

```tsx
<ScopeChip
  variant="workspace"          // 'project' locks, 'workspace' mounts
  label={t('workspace.title')} // "Büro" | the project's name
  mountedCount={mounted.length}
  disabled={cannotContribute}  // read-only participant, unchanged rule
/>
```

Keyboard: it is a `Button` and a `PopoverTrigger`; Enter/Space opens, Escape
closes and returns focus. Touch: `size="sm"` sits below 44px, so it takes
`pointer-coarse:min-h-11` — grown, not `touch-target`-ed, because the Datenbasis
trigger and the Deep-Research pill are its immediate neighbours and two
overlapping 44px catchments hand the tap to whichever comes later in the DOM.

#### `ScopeTree`

The Wissensbasis. Five levels, indented, in fixed authority order:

```
Basiswissen                    immer            Scale          law
Büroarchiv                     immer            Archive        office
Projektregister                immer (Büro)     FolderKanban   project   <- Büro only
  ↳ nur Namen und Steckbriefe, keine Dokumente
Projekt                                         FileText       project
  · Seestadt Nord                 ausblenden ×
  · Rosenhügel                    ausblenden ×
  + Projekt einblenden
Diese Unterhaltung             immer / leer     MessageSquare  project
```

In a project chat the register level is absent (not gray — it does not exist
outside the Büro) and the project level is a single locked row carrying the
project's name, with no remove and no add. At the foot of the tree, in place of
today's disabled "Alle Projekte" row: **"Im Büro fragen →"**.

**The tree reports and mounts; it does not toggle.** Four states from the
Datenbasis vocabulary (`source-basis-model.ts`) render, and only two of them are
reachable by pressing something in this control:

- `always` — the level is on every turn. No switch, because there is none.
- `on` / `off` — a level a source preset narrowed. The shortcut row's
  "Büroarchiv" preset genuinely turns Projektwissen off, so `off` is a real
  state, and an `off` row states **where** it was turned off and links there:
  *"Durch die Voreinstellung ‚Büroarchiv' ausgeschlossen · Voreinstellung zurücksetzen"*.
- `unavailable` — a door that is shut: the register outside the Büro, the
  conversation level with no attachment yet, a project the cap refuses. Always
  with a visible reason. `off` and `unavailable` stay different values for the
  reason `source-basis-model.ts` already gives: an unflippable switch is a lie
  about agency.

The only writes are mounting and unmounting. Anything else would be a control
promising retrieval behaviour the backend does not have, which is the mistake
[`click-dummy-overhaul-spec.md`](click-dummy-overhaul-spec.md) §2.3 tells us not
to repeat.

Semantics: **not** `role="tree"`. An ARIA tree promises roving focus and
expand/collapse that this hierarchy does not have and the reader would have to
learn. It is nested `<ul>`s, each level a list item with `SectionLabel` as its
`aria-labelledby` target, and each row states its status **in words** beside the
colour and the glyph.

Rows are `Item`s at `min-h-11` on a coarse pointer; the `×` grows with them
rather than taking a `touch-target`, for the same overlap reason as the chip.

Below `md` the tree renders inside a bottom `Sheet` instead of a `Popover`, and
the mount picker pushes as a second pane **inside that sheet**. A `Command`
popover nested in a `Popover` on a 390px viewport is two overlays deep and one
outside-click away from losing both.

#### `MountedProjectsRow`

"Im Blick" — a `SectionLabel` and one chip per mounted project, directly above
the composer, in the Büro only, hidden at zero mounts.

Each entry is a `SourceSignalChip signal="project"` (green, `FolderKanban`,
project name) with a `×` button as a **sibling** inside a shared bordered
wrapper, not nested inside it: the chip renders a `<button>`/`<a>` and a control
inside a control is invalid HTML that passes a visual review and breaks keyboard
navigation — the same trap `ProjectOpenLink` / `ProjectSettingsLink` layering
exists to avoid on project cards.

The `×` is present, not hover-revealed. Removing something you can see is the
undo of a one-click action, and hiding it behind a popover is the extra turn the
working-style rule calls a correction. `pointer-coarse:opacity-100` is not needed
because nothing here is opacity-gated.

Overflow scrolls horizontally at five chips on a phone. It uses a new
`scroll-fade-right` utility in `globals.css` — the horizontal sibling of
`scroll-fade-bottom`, a mask and not a gradient overlay, for the reason that
utility already documents: a mask composites against whatever surface the row
sits on. It never claims the page's vertical pan.

#### `ProjectMountPicker`

`Command`-based, so it inherits the ↑↓ / Enter / Esc contract the `/` skill
picker and the `@` mention picker already teach. Rows are readable projects from
`GET /api/projects` (the same list the switcher and the palette use, already
FGA-filtered — a project the reader cannot open is never a row, so the picker
cannot leak a name).

- Already mounted → row present, `aria-disabled`, trailing `Badge` "eingeblendet".
  Present rather than filtered out, so the list does not reorder under the
  reader's cursor as they mount.
- Cap reached → every unmounted row `aria-disabled` with the reason, and a footer
  `MountCapNotice` offering deep research.
- No other readable project → `EmptyState variant="bare"` naming that fact.
- Fetch error → inline `Alert` with retry inside the command list.

#### `WorkspaceEmptyState`

The chat empty state's hero greeting is the design language's one 23px moment; it
stays. Beneath it, an `EmptyState variant="bare"` (icon `Building2`) with a
description that says what the Büro is, and three example prompts as interactive
`Chip`s for outcome kinds A, B and C:

| Kind | German prompt | On click |
|---|---|---|
| A — Baurecht | "Wie lang darf ein Fluchtweg in GK4 sein?" | prefills the composer |
| B — register | "In welchen Projekten haben wir GK5 mit Holzbau?" | prefills the composer |
| C — compare | "Vergleiche die Brandschutzkonzepte von …" | prefills **and** opens `ProjectMountPicker` |

They prefill and do not send. A canned prompt that fires immediately is a
question the reader did not ask, and C in particular cannot be complete before a
project is chosen — which is why C opens the picker, teaching mounting at the one
moment the reader wants it.

#### `ProjectAttribution` on citations

`CitationPeek` gains a project line above the filename whenever the citation's
shelf is `project` or `register` **and** the conversation is a workspace one:
*"Projekt Seestadt Nord · Brandschutz.pdf · S. 7"*. In a project chat the line is
suppressed — naming the project the reader is standing in is noise.

`project_id` and `project_name` ride on the chunk as data (ADR-0047's doctrine
applied to one more field: the BFF knows the collection→project map when it
builds the scope, so it puts the name on the scope entry rather than letting the
frontend derive it from a `proj_` prefix).

Two consequences worth stating:

- `DocumentHomeLink` currently reads `projectId` off the chat store. In a
  workspace chat that is `null`, so the "in den Dateien öffnen" link silently
  disappears for exactly the citations that most need it. It now resolves from
  the citation's own `projectId`. This is a defect the design fixes rather than
  routes around.
- The peek gains **"Im Projekt weiterfragen"**, which carries the reader's last
  question into that project's chat via `?ask=`.

A citation can never name a project the reader may not open, because the scope it
came from was built from readable projects only. That is a property of the BFF,
not of this component, and it is why this component may render a name at all.

#### Herleitung, grouped by level

`groupByLevel` regroups what `deriveTraceLanes` already produces. It is a
**regrouping, not a new panel**: the same lane cards, the same citation model,
the same `ReasoningFlow` fan-out — only the columns' grouping and order change,
plus a subgroup header per project.

Fixed order, authority-descending, extending `STRATUM_ORDER`
(`law → office → project → auto`) with the two new positions:

```
law  →  office  →  register  →  project (one subgroup per project)  →  conversation  →  web
```

`register` sits between office and project because a Steckbrief is an assertion
about a project made by the office, not a document from inside one. `conversation`
sits after every persistent shelf because a file dropped into this chat is the
most local claim there is. `web` is not a knowledge level at all — it is the
outside — and sorts last, after everything the organization owns.

**This is not a rendering of the LangGraph topology, and must not become one.**
The graph (`shallow_research → clarifier → deep_research`, ADR-0052) is
implementation topology: it changes when we re-shape the agent, and it answers
"which node ran". The tree answers "which knowledge level was read", which is the
question the ScopeChip and the ScopeTree already promised the reader an answer
to. If the Herleitung's grouping is the graph and the tree's grouping is the
hierarchy, the reader has been shown two structures and told they are one thing.
Langfuse keeps the graph, for the people who need it.

Empty levels render (§3, failure mode 1) in `--source-auto` gray with the "Lücke"
treatment the design language already reserves for honest absence.

#### `MountNotice` — inline, not a toast

An agent mount emits an inline notice into the transcript, in the same visual
class as `DeepResearchBanner` and `NoSourcesBanner`, with the chat-turn entrance
(`fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance
motion-reduce:animate-none`):

> **Piloti hat Projekt Seestadt Nord eingeblendet.** · Rückgängig

Not a `sonner` toast. The design language reserves toasts for transient action
failures; this is a durable change to what every later turn may read, and its
undo is something a reader may reach for three turns later. A record belongs in
the record.

Undo removes the mount, replaces the notice's control with
*"Seestadt Nord wieder ausgeblendet."* — the notice stays, because the mount
happened and the transcript is a history — and the chip leaves "Im Blick" on the
`duration-quick` chip-out tween. Nothing here springs: provenance and
evidentiary content are tween-only by the motion vocabulary's fourth veto.

#### `SessionsPanel`, scoped

`conversationMatchesProject` fails open for a null `projectId` today — a
deliberate choice for legacy unscoped sessions, and exactly wrong once workspace
conversations exist, because every one of them would appear in every project's
history. It gains an explicit workspace branch keyed on the conversation's
`scope` column, with no fail-open: an unknown scope is not shown.

In the Büro the panel's heading reads "Büro-Chats · N", the Deep Research section
is absent (it is scoped by `projectCollection`, which the Büro has none of until
phase 5), and the empty state names the surface rather than the project.

---

## 5. Copy

Namespace `chat.workspace.*` unless noted. Every key lands in **both**
dictionaries or `key-coverage.spec.ts` fails.

### New keys

| Key | Deutsch | English |
|---|---|---|
| `nav.sections.workspaceChat` | "Büro" | "Office" |
| `nav.sectionSubtitles.workspaceChat` | "Fragen über Projekte hinweg — im Büro, nicht im Projekt." | "Questions across projects — in the office, not in a project." |
| `nav.orgHeader.askPiloti` | "Piloti fragen" | "Ask Piloti" |
| `title` | "Büro" | "Office" |
| `chipAria` | "Suchbereich: Büro. {count, plural, =0 {Kein Projekt eingeblendet} one {# Projekt eingeblendet} other {# Projekte eingeblendet}}. Öffnet die Wissensbasis." | "Search scope: Office. {count, plural, =0 {No project in view} one {# project in view} other {# projects in view}}. Opens the knowledge base." |
| `chipAriaProject` | "Suchbereich: {project}. Öffnet die Wissensbasis." | "Search scope: {project}. Opens the knowledge base." |
| `placeholder` | "Fragen Sie Piloti — über alle Projekte hinweg …" | "Ask Piloti — across your projects …" |
| `empty.title` | "Das Büro" | "The office" |
| `empty.description` | "Piloti liest hier Basiswissen, Büroarchiv und das Projektregister. Blenden Sie ein Projekt ein, damit auch dessen Unterlagen gelesen werden." | "Here Piloti reads base knowledge, the office archive and the project register. Add a project to have its documents read too." |
| `empty.examples.law` | "Wie lang darf ein Fluchtweg in GK4 sein?" | "How long may an escape route be in GK4?" |
| `empty.examples.register` | "In welchen Projekten haben wir GK5 mit Holzbau?" | "Which of our projects are GK5 with timber construction?" |
| `empty.examples.compare` | "Vergleiche die Brandschutzkonzepte von …" | "Compare the fire-safety concepts of …" |
| `tree.title` | "Wissensbasis" | "Knowledge base" |
| `tree.levels.base` | "Basiswissen" | "Base knowledge" |
| `tree.levels.archiv` | "Büroarchiv" | "Office archive" |
| `tree.levels.register` | "Projektregister" | "Project register" |
| `tree.levels.project` | "Projekt" | "Project" |
| `tree.levels.session` | "Diese Unterhaltung" | "This conversation" |
| `tree.hints.base` | "OIB-Richtlinien und Rechtsquellen." | "OIB guidelines and legal sources." |
| `tree.hints.archiv` | "Standards und Details der ganzen Organisation." | "Standards and details from the whole organization." |
| `tree.hints.register` | "Nur Namen und Steckbriefe — keine Dokumente." | "Names and profiles only — no documents." |
| `tree.hints.project` | "Unterlagen und Gedächtnis der eingeblendeten Projekte." | "Documents and memory of the projects in view." |
| `tree.hints.session` | "Dateien, die Sie hier angehängt haben." | "Files you attached here." |
| `tree.states.always` | "immer" | "always" |
| `tree.states.on` | "aktiv" | "on" |
| `tree.states.off` | "ausgeschlossen" | "excluded" |
| `tree.states.unavailable` | "nicht verfügbar" | "unavailable" |
| `tree.offByPreset` | "Durch die Voreinstellung „{preset}" ausgeschlossen." | "Excluded by the „{preset}" preset." |
| `tree.registerOutsideWorkspace` | "Nur im Büro-Chat." | "Only in the office chat." |
| `tree.sessionEmpty` | "Noch keine Datei in dieser Unterhaltung." | "No file in this conversation yet." |
| `tree.projectLocked` | "Dieser Chat ist auf {project} festgelegt." | "This chat is fixed to {project}." |
| `tree.noProjects` | "Kein Projekt eingeblendet" | "No project in view" |
| `tree.mountAdd` | "+ Projekt einblenden" | "+ Add a project" |
| `tree.mountRemove` | "{project} ausblenden" | "Remove {project}" |
| `tree.resetPreset` | "Voreinstellung zurücksetzen" | "Reset the preset" |
| `mounted.label` | "Im Blick" | "In view" |
| `mounted.aria` | "Eingeblendete Projekte: {names}" | "Projects in view: {names}" |
| `picker.title` | "Projekt einblenden" | "Add a project" |
| `picker.placeholder` | "Projekt suchen …" | "Search projects …" |
| `picker.mounted` | "eingeblendet" | "in view" |
| `picker.empty` | "Kein passendes Projekt." | "No matching project." |
| `picker.none` | "Sie können derzeit kein weiteres Projekt lesen." | "There is no further project you can read." |
| `picker.error` | "Die Projektliste konnte nicht geladen werden." | "The project list could not be loaded." |
| `cap.notice` | "Mehr als {max} Projekte kann eine Unterhaltung nicht gleichzeitig lesen." | "A conversation cannot read more than {max} projects at once." |
| `cap.deepResearch` | "Als Deep Research starten" | "Start as Deep Research" |
| `mount.byAgent` | "Piloti hat Projekt {project} eingeblendet." | "Piloti added project {project}." |
| `mount.byUser` | "{project} ist eingeblendet." | "{project} is in view." |
| `mount.fromProject` | "{project} ist eingeblendet, weil Sie aus diesem Projekt gekommen sind." | "{project} is in view because you came from that project." |
| `mount.undo` | "Rückgängig" | "Undo" |
| `mount.undone` | "{project} wieder ausgeblendet." | "{project} removed again." |
| `mount.failed` | "{project} konnte nicht eingeblendet werden." | "{project} could not be added." |
| `attribution.project` | "Projekt {project}" | "Project {project}" |
| `attribution.register` | "Steckbrief" | "Project profile" |
| `attribution.continueInProject` | "Im Projekt weiterfragen" | "Continue in the project" |
| `askInWorkspace` | "Im Büro fragen →" | "Ask in the office →" |
| `askInWorkspaceHint` | "Öffnet den Büro-Chat mit diesem Projekt eingeblendet." | "Opens the office chat with this project in view." |
| `herleitung.levels.*` | as `tree.levels.*` | as `tree.levels.*` |
| `herleitung.levelEmpty` | "nichts eingeblendet" | "nothing in view" |
| `herleitung.web` | "Web" | "Web" |
| `sessions.title` | "Büro-Chats" | "Office chats" |
| `sessions.empty` | "Noch kein Büro-Chat. Fragen Sie Piloti etwas, das über ein Projekt hinausgeht." | "No office chat yet. Ask Piloti something that goes beyond one project." |
| `sharing.blocked` | "{name} kann {project} nicht lesen und dieser Chat daher nicht geteilt werden." | "{name} cannot read {project}, so this chat cannot be shared with them." |

### Changed keys

| Key | Was | Becomes |
|---|---|---|
| `composer.scopeAll` | "Alle Projekte" / "All projects" | **Removed.** Its row becomes the `askInWorkspace` action |
| `composer.scopeAllSoon` | "Bald verfügbar – projektübergreifende Suche ist noch nicht möglich." | **Removed.** The tooltip's whole content was an apology for a control that now works |
| `composer.scopeCurrent` | "Aktuelles Projekt" | Kept, as the project level's status in the tree |
| `composer.scopeAria` | "Suchbereich: {project}" | Superseded by `chipAria` / `chipAriaProject`, which also state the mount count |

---

## 6. Provenance colour and iconography

No new brand accent, and no new `--source-*` family. The four existing signal
tokens carry all five levels; the two new levels take an existing tint and a new
glyph, which is exactly the mechanism ADR-0026's amendment established for `oib`
inside `law` — except here even the tint is shared, because a Steckbrief is not a
different *tier of trust* from a project document, only a coarser grain of the
same one.

| Level | Token | Glyph | Label | Why |
|---|---|---|---|---|
| Basiswissen | `--source-law` | `Scale` (`SIGNAL_ICON.law`) | "Basiswissen" | Unchanged |
| Büroarchiv | `--source-office` | `Archive` | "Büroarchiv" | Unchanged |
| **Projektregister** | `--source-project` | **`FolderKanban`** | "Projektregister" | Its rows are facts *about* projects. A fifth colour for a sub-shelf would make the palette carry a distinction the icon carries better, and would set the precedent that every new shelf earns a hue |
| Projektwissen | `--source-project` | `FileText` | "Projektwissen" | Unchanged |
| Diese Unterhaltung | `--source-project` | **`MessageSquare`** | "Private Sitzung" (citations) / "Diese Unterhaltung" (tree) | Already green via `kind: projekt`; the glyph is what separates a file you dropped in here from a file in the project |
| Absent level | `--source-auto` | `CircleSlash` | "nichts eingeblendet" | The "Lücke" family. Absence is a first-class source entry, not a hidden row |

**The `Büro` scope chip takes no provenance colour at all.** It is ink and muted
like every other composer control, with a `Building2` glyph. The chip states
*where you are standing*, not where an answer came from, and painting it gold
because "Büro" shares a word with "Büroarchiv" would make the composer claim a
provenance before a single source has been read. Provenance chroma stays on
provenance. This is the same line the design language drew when it withdrew
`--accent-pop` from the composer: a control that wants to stand out wants
contrast, not chroma.

Icon + label + colour still travel together everywhere: the tree rows, the "Im
Blick" chips, the Herleitung group headers and the citation attribution all
carry all three. The mounted chip is green **and** says the project's name
**and** shows `FolderKanban`; nobody has to read a hue.

Adding the register as a shelf is a row in `Shelf` (ADR-0047), a case in
`shelfLabel`, a row in this table and a row in the tree. That is the growth
property the hierarchy was designed for — a sixth level is not a redesign.

---

## 7. Flows

### (a) First visit to the Büro

1. Reader presses `g b` from anywhere, or "Piloti fragen" in the org header.
2. The rail disappears; the org header stays. Tab title becomes "Büro — Piloti".
3. The transcript is empty: hero greeting, then `WorkspaceEmptyState` — the
   description, then the three example chips.
4. The composer's `ScopeChip` reads **`[Building2] Büro`** with no count. `MountedProjectsRow`
   is not rendered (zero mounts). Placeholder: "Fragen Sie Piloti — über alle
   Projekte hinweg …".
5. Opening the chip shows the tree: Basiswissen `immer`, Büroarchiv `immer`,
   Projektregister `immer` with its "nur Namen und Steckbriefe" hint, Projekt
   with "Kein Projekt eingeblendet" and "+ Projekt einblenden", Diese
   Unterhaltung `nicht verfügbar — noch keine Datei`.

### (b) A Baurecht question (kind A)

1. Reader sends "Wie lang darf ein Fluchtweg in GK4 sein?".
2. The breadcrumb appears: **`Büro / Fluchtweglänge GK4`**.
3. The answer streams; "Belegt durch" chips are blue with `Scale`, identical to
   the project chat's.
4. The Herleitung shows **five** levels: `Basiswissen` with its cards,
   `Büroarchiv` empty-gray, `Projektregister` empty-gray, `Projekt — nichts
   eingeblendet` gray, `Diese Unterhaltung` gray.
5. Nothing about the answer differs from the same question in a project. That is
   the acceptance criterion for kind A, and step 4 is where a reader can verify
   it rather than trust it.

### (c) "In welchen Projekten haben wir GK5?" (kind B)

1. Reader sends the question.
2. Register recall runs at turn start; the answer names projects and cites
   Steckbriefe. Each citation chip is green with `FolderKanban` and the peek
   reads *"Steckbrief · Seestadt Nord"*.
3. Inline in the answer, the named projects render as `SourceSignalChip`s. The
   Herleitung's `Projektregister` level lists them; `Projekt` is still
   empty-gray, so the reader can see that no project's *documents* were read.
4. The agent's closing sentence offers to go deeper: "Soll ich Seestadt Nord
   einblenden?" — with a **"Seestadt Nord einblenden"** action beneath it.
5. Pressing it mounts (flow d, from step 3).
6. If the reader instead clicks a project chip, `CitationPeek` opens with "Im
   Projekt weiterfragen".

### (d) The agent mounts a project mid-turn

1. Mid-answer, the agent calls `open_project`. The BFF checks `project:chat`
   for **this** reader and returns a grant.
2. Immediately, three things: a chip slides into "Im Blick" (`duration-quick`
   tween), the `ScopeChip` count goes `Büro` → `Büro · 1`, and the tree's project
   level gains a row.
3. A `MountNotice` lands in the transcript with the chat-turn entrance:
   **"Piloti hat Projekt Seestadt Nord eingeblendet. · Rückgängig"**.
4. The turn continues; the rest of the answer may now cite that project's
   documents, each attributed "Projekt Seestadt Nord · …".
5. Undo removes the mount, the chip leaves, the count drops, and the notice
   becomes "Seestadt Nord wieder ausgeblendet." Citations already written stay —
   they are the record of what was read, and rewriting them would be a lie.
6. A denied mount (revoked access between turns) never produces steps 2–4: the
   agent says it cannot read that project, and the transcript carries
   `mount.failed`.

### (e) Manual mount, and the cap

1. Reader opens the tree, presses "+ Projekt einblenden".
2. `ProjectMountPicker` opens (a second pane on desktop, a pushed pane inside the
   sheet on mobile), focus in the search field, ↑↓/Enter/Esc.
3. Each mount: the row gains its "eingeblendet" badge in place, the chip appears
   in "Im Blick", the count increments. The picker stays open — mounting three
   projects is one task, not three.
4. At five, every remaining row goes `aria-disabled` with the reason, and the
   footer states the cap and offers **"Als Deep Research starten"**.
5. Taking that offer opens the existing deep-research path with the mounted set
   as its collection scope, and the `DeepResearchBanner` reports progress as it
   always does.
6. Removing one re-enables the rows without closing the picker.

### (f) Project chat → Büro → back

1. In `Seestadt Nord`'s chat, the reader opens the `ScopeChip` (`[Lock] Seestadt
   Nord`) and presses **"Im Büro fragen →"**.
2. `/app/chat?mount=<id>`. The rail is replaced by the org header; the chip
   becomes **`[Building2] Büro · 1`**; "Im Blick" carries one chip.
3. A `MountNotice` states *why*: **"Seestadt Nord ist eingeblendet, weil Sie aus
   diesem Projekt gekommen sind."** — no undo control needed, but the chip's `×`
   is there. The `mount` param is stripped from the URL after it is consumed, the
   same guard-ref pattern `?new=1` and `?ask=` already use, so a refresh does not
   re-mount a project the reader removed.
4. The reader asks a cross-project question and gets an answer citing two
   projects.
5. A citation from Seestadt Nord offers "Im Projekt weiterfragen"; taking it
   lands in that project's chat with the question prefilled, the rail back, and
   the chip `[Lock] Seestadt Nord`.
6. Browser back returns to the Büro conversation intact — it is a real route with
   a real conversation, not a mode.

### (g) Opening a shared workspace conversation without access to one mount (phase 2)

1. A colleague opens a shared Büro chat. The server checks `project:view` on
   every mounted project at read.
2. Refused at the boundary: the reader gets the standard "no access" surface, not
   a partial transcript. The brief's rule is enforced at grant *and* at read, and
   a half-rendered conversation whose citations quietly vanish is a worse answer
   than a closed door.
3. At **grant** time the sharing dialog is where this is prevented: a recipient
   who cannot read a mounted project is listed as blocked with
   `sharing.blocked` naming the project — the same "blocked with the reason"
   shape the sharing dialog already uses for a colleague who is not in the
   project.
4. Mounting a new project into an already-shared conversation re-validates every
   participant; a participant who would lose access is named before the mount is
   applied, and the mount is refused rather than silently unsharing them.
5. Phase 1 never reaches any of this: workspace conversations are private-only,
   guarded in the service, and the Share entry does not appear.

---

## 8. Accessibility and responsive behaviour

**Touch, on the pointer axis and never a breakpoint.** `ScopeChip`, tree rows,
`×` buttons, picker rows and prompt chips all reach 44px by **growing**
(`pointer-coarse:min-h-11`), not by `touch-target`, because each of them has an
immediate neighbour and two overlapping catchments hand the tap to the later
element. The one exception is the "Voreinstellung zurücksetzen" link at the foot of the
tree, which has room around it and takes `touch-target`. Held by the existing
`touch-target.spec.ts` and `mobile-affordances.spec.ts`.

**Mobile shapes.**

- `ScopeChip`: label hidden below `sm` (existing `hidden sm:inline`), glyph and
  count remain, `aria-label` unchanged and complete.
- `MountedProjectsRow`: horizontal scroll with `scroll-fade-right`; it never sets
  a `touch-action` that would take the page's vertical pan.
- `ScopeTree`: `Sheet` below `md`, bottom-anchored like every other `PageSheet`,
  with the picker as a pushed pane rather than a nested overlay.
- Breadcrumb: the Büro keeps its first segment on a phone, unlike the project
  chat, because in the Büro nothing else names the scope.

**Screen reader.** Nested lists, not `role="tree"`. Each level is a list item
labelled by its `SectionLabel`; each row states its status in words as well as in
colour and glyph. The mounted count is in the chip's accessible name, so a reader
who never opens the tree still hears the scope. `MountNotice` is `role="status"`
(polite) — it reports something that already happened and must not interrupt a
streaming answer.

**Motion.** Chip in/out is `duration-quick`; the mount notice takes the chat-turn
entrance; the sheet takes `--motion-deliberate` on `--ease-entrance`. **Nothing
here springs**: the motion vocabulary's veto on evidentiary and provenance
content covers every element in this design, and the "Im Blick" row would breach
the five-per-screen repetition rule anyway. `prefers-reduced-motion` drops all of
it with no loss of information, because every state is also stated in text.

**Contrast.** The provenance tints are used through `sourceSignalStyle`, whose
`-text` variants are the AA-readable pairs; no row invents a dimmed muted
foreground. The eyebrow ("Im Blick") is `SectionLabel`, not a hand-rolled
`<span>` — the drift that cost `project-surfaces.md` a 2.2:1 count pill.

---

## 9. Visual evidence

Per [`../ux/visual-screenshots.md`](../ux/visual-screenshots.md): a `/dev/*`
preview route, a `visual/registry.mjs` target, committed light/dark PNGs, and the
mobile twin wherever the surface is responsive. Pin the locale with
`<I18nProvider initialLocale="de" fixedLocale>`; a preview that drives an open
state guards with a **module-scope** flag and polls `aria-expanded`.

| Target id | Route | Captures | `mobile` |
|---|---|---|---|
| `workspace-chat` | `/dev/workspace-chat` | The Büro at rest: hero greeting, `WorkspaceEmptyState`, composer with `ScopeChip variant="workspace"` | yes |
| `scope-tree` | `/dev/scope-tree` | `ScopeTree`, driven open. `?variant=workspace` (two mounts), `?variant=project` (locked single project + "Im Büro fragen →"), `?variant=capped` (five mounts, cap notice) | yes |
| `mounted-projects` | `/dev/mounted-projects` | `MountedProjectsRow` at 1 / 3 / 5 mounts; the 5-chip row exercises the horizontal fade at 390px | yes |
| `project-mount-picker` | `/dev/project-mount-picker` | `ProjectMountPicker`: ready, one row already mounted, cap-reached, and the no-readable-projects empty state | yes |
| `citation-project-attribution` | `/dev/citation-project-attribution` | `CitationPeek` with `ProjectAttribution` and "Im Projekt weiterfragen", under a real `hover:` rest | no (hover-only) |
| `herleitung-levels` | `/dev/herleitung?variant=levels` | The five-level grouping with two project subgroups and two empty-gray levels | yes |
| `app-shell-scopes` (extend) | `/dev/app-shell-scopes` | The org header's new "Piloti fragen" entry beside the icon-only doorways | yes |
| `composer` (extend) | `/dev/composer?variant=workspace` | The composer control row in the Büro: workspace chip, mounted row above it | yes |

Spec files, named beside the component they hold:

| Spec | Holds |
|---|---|
| `features/layout/components/scope/scope-tree-model.spec.ts` | Level order, the five states, `off`-by-preset attribution, register absent outside the Büro. Pure model, like `source-basis-model.spec.ts` |
| `features/layout/components/scope/ScopeChip.spec.tsx` | Glyph per variant, count rendering, the accessible name at 0/1/N mounts, disabled in a read-only chat |
| `features/layout/components/scope/MountedProjectsRow.spec.tsx` | Remove control is present (not hover-gated), `×` is a sibling and not a nested control, hidden at zero |
| `features/layout/components/scope/ProjectMountPicker.spec.tsx` | Cap disables rows with a visible reason, mounted rows stay in place, error retry |
| `features/chat/lib/herleitung-levels.spec.ts` | Fixed order; empty levels survive grouping; one subgroup per project |
| `features/chat/components/ProjectAttribution.spec.tsx` | Rendered only in a workspace conversation; `DocumentHomeLink` resolves from the citation, not the store |
| `features/chat/lib/project-scope.spec.ts` (extend) | The workspace branch of `conversationMatchesProject` does **not** fail open |
| `components/shell/project-sections.spec.ts` (extend) | The Büro row's `g b` binding and palette membership |
| `i18n/key-coverage.spec.ts` (existing) | Every key above in DE **and** EN |

---

## 10. Decisions taken on the open questions (2026-09-08)

The five questions the first draft left for the product owner were decided by
the steering layer the same day; each is recorded here with its reason so the
implementer does not reopen it.

1. **The Datenbasis picker stays hidden.** The 2026-08 product decision that
   hid `SourceBasisPicker` stands. The tree's foot link reads "Voreinstellung
   zurücksetzen" and clears the shortcut preset, so a level shown as
   `ausgeschlossen` has a way back that exists. Restoring the picker is a
   separate decision with its own evidence.

2. **The lock is drawn.** The project variant of `ScopeChip` carries `Lock`
   and the dashed `--status-active` ring goes. The user guide promised the lock
   in 2026-07; the code owes it, and the glyph is the only carrier of scope
   below `sm`.

3. **Register-only answers carry a standing mount control.** When an answer
   cites Steckbriefe and nothing is mounted, the answer footer renders one
   `SourceSignalChip` per cited project with the action "einblenden", derived
   from the answer's register citations, never from prose. It is data the wire
   already carries, so it costs no new card type and survives a reload.

4. **The closed door.** A shared workspace conversation is refused, as one
   unit, to a reader who cannot read one mounted project. The partial view
   leaks the project's name through the mount list, and a name is exactly
   what `listProjects` exists to withhold (ADR-0038).

5. **Two names, not three.** "Büro" is the place: the chip, the breadcrumb's
   first segment, and the project rail's doorway in the `org` group, where its
   neighbours Archiv and Postfach are also named as places. "Piloti fragen" is
   the action, in the org header. "Büro-Chat" remains the feature's name in
   documents and in the sessions panel's heading ("Büro-Chats"), never as a
   navigation label.
