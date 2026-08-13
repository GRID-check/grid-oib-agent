# Project surfaces — the card is the staple, atoms are the material

**The rule, in one line: a new surface that lists a project renders
`ProjectCard`, or is composed from `project-atoms.tsx`. It never hand-rolls a
lookalike.**

The project card is part of the design language, not one page's component. It is
the click-dummy's Projektübersicht card (spec §1/§3) and it is what "a project,
listed" looks like everywhere in Piloti: a subtle-surface body carrying a raised
white plate with the name, the status chip and the brief line, and a quiet meta
strip underneath with the timestamp and a settings gear.

Two lookalike cards do not stay lookalikes. They drift on the first token retune
— one keeps a 12px radius while the other moves, one gets the new hover lift,
one keeps showing a timestamp that means something the other's no longer does —
and the drift surfaces as a page that feels subtly broken without anyone being
able to point at the bug. This document exists because that nearly happened: the
projects-home rework grew a second, larger `ProjectResumeCard` beside
`ProjectCard` rather than reusing it.

## The files

| File | What it is |
|---|---|
| `components/ui/raised-card.tsx` | The **shape**: the tray, the laid-in white sheet, the footer tab. Shared with the document and job cards |
| `components/ui/section-label.tsx`, `components/ui/count-pill.tsx` | The eyebrow and the quiet number beside it. The grid's `SectionHeading` is only the arrangement of these two |
| `components/projects/project-atoms.tsx` | The **project-specific parts**: links, brief, activity, doc count, initials tile |
| `components/projects/project-card.tsx` | **The card.** `RaisedCard` + the atoms. Use this by default |
| `components/projects/project-list-row.tsx` | The dense row — the same atoms in a different arrangement |
| `components/projects/project-status.tsx` | The status chip and the (deliberately honest) status derivation |

The split matters: the card's geometry is not a project concern. `RaisedCard`
exists because that two-surface shape had been hand-rolled four times over
(`file-card`, `file-grid`, `DocumentGridCard`, `project-card`) and drifted. The
projects-home rework migrated `project-card` onto it; a project-owned copy of
`rounded-b-[10px] bg-card shadow-xs` would have been the fifth.

The same rework hand-rolled the section eyebrow and its count too, and the drift
was immediate and measurable: the eyebrow at nearly double the documented
tracking, and the count dimmed to `text-muted-foreground/70` — roughly 2.2:1 on
paper, well under the 4.5:1 floor. That is what reaching for a bespoke `<span>`
costs. **Before styling anything on a project surface, check `components/ui/`
for the primitive.** It is usually there.

## The atoms

| Atom | Owns |
|---|---|
| `ProjectOpenLink` | The name as the surface's primary link, **stretched** over the whole surface, with the `Open {name}` label |
| `ProjectSummaryLine` | The brief, falling back to the shared invitation when a project has none |
| `ProjectActivity` | **Whose timestamp this is** — see below |
| `ProjectDocCount` | Ingested document count, pluralized |
| `ProjectSettingsLink` | The gear, layered above the stretched link (`relative z-10`) — never nested inside it |
| `ProjectInitialsTile` | The fixed left edge of a dense list, so a scan has a column to index by |

Two of them carry meaning rather than styling, and are the reason the atoms are
worth having at all:

**`ProjectActivity` is the only place that decides whose timestamp is on
screen.** The viewer's own last message in a project and the project's own last
movement (profile write, then creation) are different facts. When the caller
passes `activityAt` the surface says "You were last here" with a speech-bubble
icon; without it, it falls back to the project's clock under the neutral "Last
activity" with a clock icon. They are never merged into one ambiguous number,
and no surface can imply the wrong one, because no surface makes that choice
itself.

**`ProjectOpenLink` owns the stretched-link mechanics.** Every project surface is
one large click target with independently focusable controls layered above it.
Re-implementing that per surface produces nested anchors — invalid HTML that
breaks keyboard navigation and screen-reader output in ways that pass a visual
review.

## Adding a surface

1. **Can it be a `ProjectCard`?** Then it is one. A grid, a rail, a picker, a
   related-projects strip — all of these are a selection and an arrangement, not
   a new card. The projects-home resume rail is exactly this: same card, three
   of them, ordered by the viewer's own activity.
2. **Does it need a genuinely different arrangement** (a table row, a compact
   menu item, a mention chip)? Compose it from the atoms, like
   `ProjectListRow` does. The row is the card's material caught in another
   state — its resting form is the paper with a hairline under it, and on hover
   it becomes the card surface.
3. **Does it need something no atom provides?** Add the atom, then use it. An
   atom added for one surface is available to the others; a bespoke `div` in one
   component is not.
4. **Is what you are about to add really a shape, not a project concern?** Then
   it belongs in `components/ui/`, not here — check whether it already exists
   there first.

What must not happen: a new component that redraws the card's border, radius,
plate, hover lift or timestamp inline because it needed to be a bit bigger or a
bit denser.

## Honesty constraints these surfaces inherit

- **Status.** `projects` has no status, phase or completion column — only
  `deletedAt`, and soft-deleted rows never reach these surfaces. So every
  project rendered here is truthfully `active`, and `getProjectStatus` refuses to
  invent a "Done". A grouped-by-phase surface is a data-model change first, a
  layout second.
- **Timestamps.** See `ProjectActivity` above. `lastProjectActivityByUser`
  (`lib/conversations/repository.ts`) is per-caller by construction and is asked
  only for projects that survived FGA filtering, so what reaches the card can
  neither be someone else's working pattern nor name a project the viewer cannot
  open.

## Visual evidence

`/dev/projects-home` renders the real `ProjectsGrid` over fixture data at nine
projects (`?variant=fresh` for a viewer with no activity anywhere), and
`visual/registry.mjs` captures both. Screenshots land in
`visual/screenshots/projects-home*.png`. See `docs/ux/visual-screenshots.md`.
