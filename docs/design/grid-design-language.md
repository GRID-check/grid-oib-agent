# GRID Design Language

> Branding note (2026-07-17): the user-facing product brand — wordmark, tab titles, all UI copy — is **Piloti** (`src/lib/brand.ts`). GRID remains the internal/platform name, including this design language and its tokens (e.g. the `--grid-blue` alias).

The single reference every page redesign builds against. Goal: an **understated, premium, precise** tool for architects doing building-compliance work — Linear/Vercel/Stripe-dashboard restraint, not consumer SaaS. Calm, trustworthy, dense-but-legible. No gradients, no emojis, no decorative color.

The visual language is **warm paper monochrome + provenance signal colors** (adopted from the click-dummy overhaul, see `docs/design/click-dummy-overhaul-spec.md` §1/§4): warm paper surfaces, a near-black ink ramp, hairline alpha-ink borders, layered soft shadows, **near-black action buttons** — and the *only* chroma in the app is the source/provenance signal system.

## Principles

1. **Restraint is the aesthetic.** Warm paper surfaces (`#f6f6f4`-family, warm charcoal in dark mode), a near-black ink ramp, and **no brand accent color**: the primary action is ink (`#1f2023`, white text; paper-white on ink in dark mode). If everything is highlighted, nothing is. Blue is *not* the action color — it belongs to the Baurecht provenance signal.
2. **Provenance is the only color.** The one place chroma exists is the source signal system (`--source-law` blue, `--source-project` green, `--source-office` gold, `--source-auto` gray, `--signal-error` red). It runs through composer, citations, history filters, and insights — it is the product's trust affordance. **Color never travels alone: every signal is always icon + label + color together** (a11y and legibility). Green doubles as status "Aktiv"; red is for errors only.
3. **Authority through precision.** This tool cites Austrian building law. Citations, legal-basis, and document provenance must look verifiable and exact — monospace for identifiers, clear source attribution, never decorative.
4. **Hierarchy over density.** Dense is fine (architects handle complex data), but every screen has ONE clear focal point and a legible reading order. Whitespace does the separating, not boxes-within-boxes.
5. **Motion with a reason.** Movement here is an argument, not an ornament: it says where something came from, that a press landed, or that a change took. Entrance fades with a slight rise for arriving content; smooth height for accordions and thinking steps; skeleton→content. **Springs are allowed where the motion's trajectory carries information the endpoint does not** — a panel arriving from an edge, a toggle thumb clicking into its detent, a dropped file landing, a row gliding to its new group. They are physics, not personality: the overshoot budget is **1–2 pixels of visible travel**, so the spring is chosen by distance, never by taste. Everything else — colour, opacity, hover, system-initiated entrance — is a tween, 120–240ms. Never a spring on colour, on legal content, on errors, or on anything repeating more than about five times per screen. Respect `prefers-reduced-motion` absolutely: motion must be droppable with no loss of information.
6. **Every state is designed.** Loading, empty, error, partial, success. Empty states especially are craft opportunities, not afterthoughts — they orient and invite the next action.

## Tokens (already defined in src/styles/tokens.css)

Use shadcn semantic classes: `bg-background/card/muted/accent`, `text-foreground/muted-foreground`, `border`, `bg-primary/text-primary-foreground` (primary = **ink**, near-black), `bg-destructive`, `ring-ring`. Feedback subtle backgrounds via the `--background-color-feedback-*-subtle` vars (already wired into Badge/Alert success/warning/info/destructive variants — these now resolve to the provenance tints). Never hardcode hex/oklch in components.

**Surfaces (light):** app bg `--background` ≈ #f6f6f4 warm paper · sidebar/rails `--background-color-surface-sunken` ≈ #f1f1ef · cards white · subtle input surface `--input-background` ≈ #fafaf8 · chip/quiet fill `--secondary`/`--muted` ≈ #f2f2f0 · inset/hover `--accent` ≈ #ececea. Dark mode is the derived warm-charcoal equivalent (same warm hues, no cold blue-grays).

**Surfaces (dark):** sidebar/rails #100f0d · app bg `--background` #171613 · input well `--input-background` #1c1b18 · cards `--card` #22211d · popovers #2a2825 · chip/quiet fill #2e2c28 · inset/hover `--accent` #373531.

### Dark mode is derived, not mirrored

Dark builds depth **differently on purpose**, and this is the one place the two
themes are not the same system with swapped values. Copying light's ratios into
dark is what made the first pass read as mud, so before re-tuning any dark
surface, know why it is shaped this way:

- **Elevation is carried by lightness, not by shadow.** On paper a white card
  separates from the background mostly through its drop shadow — dark-on-light,
  high contrast — and the surface step itself only does ~0.03L of work. On
  charcoal that shadow contributes nothing (black on near-black is invisible),
  so the step has to carry the hierarchy alone. Dark therefore uses **wider
  steps** (bg→card is ~0.048L) and steps again for every plane above it.
- **Raised planes get a lit top edge.** `--elevation-sm/md/lg` in dark open with
  an `inset 0 1px 0` paper highlight: light comes from above, so a raised
  surface catches it on its top edge. This is what actually reads as "raised" in
  a dark UI, and it works where a drop shadow cannot. `--elevation-xs` stays
  shadow-only — on a chip or button that highlight reads as a seam.
- **Shadows anchor rather than lift.** They are deeper and tighter than light's,
  and their job is separating a floating plane from what it covers (dialogs,
  popovers), not creating the elevation itself.
- **Inputs are recessed, cards are raised.** `--input-background` sits one step
  *below* `--card`: a field is cut into its surface, not floated off it.
- **Surface direction is preserved from light:** sunken < background < card <
  popover < chip < hover.

Two failure modes this replaced, worth recognising if they reappear: a token
defined as a `color-mix()` of an **already transparent** token (that is how
`--input-background` became ~4% paper alpha and every field in dark mode went
invisible), and a scrim built from `--background` at near-full opacity (which
erased the page behind a modal instead of dimming it, so the dialog lost any
sense of sitting *on* something).

**Ink ramp (light):** #1f2023 (foreground/action) → #55565a secondary → #6f706c muted → #8a8a86 placeholder → #b3b3af ghost. Borders are **alpha ink hairlines** (`rgba(28,30,33,…)` equivalents at .08 base / .12 input / .16 strong / .22–.32 selected), so they composite on any surface. Focus ring is ink-based (`--ring`), never blue.

**Provenance signal system** — each signal has a base color, a `-tint` surface (for chips/rows on cards), and a `-text` variant (AA-readable on the tint), both modes:

| Token family | Light base | Meaning | Paired icon |
|---|---|---|---|
| `--source-law(-tint/-text)` | blue #2359d3 | Rechtsquellen (RIS, BO Wien, Behörde) | "§" |
| `--source-oib(-tint/-text)` | indigo | **Accent inside law** — OIB-Richtlinien & Erläuterungen | "§" (same as law) |
| `--source-project(-tint/-text)` | green #17914d | Projektwissen (project documents) | doc |
| `--source-office(-tint/-text)` | gold #c08c28 | Büroarchiv (office archive) | archive box |
| `--source-auto(-tint/-text)` | gray #83837f | Automatisch / **Lücke** (knowledge gap) | globe / gap |
| `--status-active(-tint)` | = project green | status "Aktiv" | dot |
| `--status-done(-tint)` | warm gray | status "Abgeschlossen" | dot |
| `--signal-error(-tint)` | red #c14a38 | errors only | alert |

All are mapped as Tailwind colors (`bg-source-law-tint`, `text-source-law-text`, `border-source-office`, `bg-status-active-tint`, …). **Rule: color never travels alone — a provenance color always appears together with its icon and a text label.** Never use a source color decoratively or for anything but its meaning. `--grid-blue` survives only as a legacy alias of the law blue; it is not an accent.

**Accents vs. signals.** `--source-oib` is the one *accent*: a hue inside an
existing signal, not a fifth family. OIB stays `law` everywhere the coarse
stratum is what matters (icon, composer presets, trust grouping, `SourceKind`) —
the accent exists only because OIB and RIS are the two tiers architects compare
most, and a Herleitung fan-out painting both the same blue left the authority
badge carrying that whole distinction alone. Resolve it with `accentForLane`
(`features/chat/lib/source-kinds.ts`), never by hand, so the Herleitung cards and
the "Belegt durch" chips cannot drift. The type is `SourceTint = SourceSignal |
'oib'`; an accent always keeps its stratum's icon.

## Type ramp (Tailwind classes — use verbatim)

The ramp targets the dummy's 9.5–24px scale: **20px page titles**, **23px hero greeting** (the one larger moment, chat empty state only), and the **uppercase ~10.5px eyebrow/label convention** (wide tracking, muted ink).

| Role | Classes |
|---|---|
| Hero greeting (chat empty state only, ≈23px) | `text-[23px] font-semibold tracking-tight` |
| Page title (≈20px) | `text-xl font-semibold tracking-tight` |
| Section heading | `text-lg font-semibold tracking-tight` |
| Card/subsection title | `text-sm font-semibold` |
| Eyebrow / label (uppercase ≈10.5px) | `text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground` (existing `text-xs` eyebrows are acceptable until a screen is restyled) |
| Body | `text-sm` (leading-relaxed for prose) |
| Body secondary | `text-sm text-muted-foreground` |
| Caption / meta | `text-xs text-muted-foreground` |
| Identifiers (job id, § refs, collection names) | `font-mono text-xs` |
| Numeric stat | `text-2xl font-semibold tracking-tight tabular-nums` |

## Spacing & layout rhythm

- **Page container:** `mx-auto w-full max-w-5xl px-4 py-8 md:px-8` (content pages). Chat/full-bleed surfaces are exceptions.
- **Vertical section gap:** `space-y-8` between major sections; `space-y-4` within a section; `gap-3` in tight lists.
- **Card padding:** `p-6` for feature cards, `p-5` for stat cards, `px-4 py-3` for list rows.
- **Radius:** cards `rounded-lg` (var --radius, 12px — inside the dummy's 7–14px range), inputs/buttons follow shadcn defaults, pills/badges `rounded-md`.
- **Borders:** hairline `border` (border-border — alpha ink, composites on any surface). Prefer a single border + `bg-card` over nested boxes. Use `divide-y` for list groups inside one bordered container. Depth = surface step + layered soft shadow (`shadow-xs/sm/md/lg` are bound to `--elevation-*`), never a heavy border.

## Component patterns

**Project card** — "a project, listed" has ONE component: `ProjectCard`
(`components/projects/project-card.tsx`). Rails, grids, pickers and any future
project surface render that card; a surface that genuinely needs another
arrangement (the dense projects-home row) is composed from
`components/projects/project-atoms.tsx`, the same material the card is made of.
Never hand-roll a lookalike — two of them drift on the first token retune. The
inventory, the honesty constraints on status and timestamps, and the decision
procedure are in **`docs/design/project-surfaces.md`**.

**Page header** — every content page opens with `PageHeader`
(`components/ui/page-header.tsx`), so the title stays on-spec (`text-xl`)
instead of drifting. It is ONE line, and the primitive has no other slot:
```tsx
<header className="flex min-w-0 items-center justify-between gap-4">
  <h1 className="min-w-0 text-balance text-xl font-semibold tracking-tight">{title}</h1>
  {primaryAction}
</header>
```
There is no subtitle and no breadcrumb trail. Both restated to the reader what
the rail's marked entry and the title already say, and cost every page ~50px
above its content. A page that genuinely needs to explain itself does it in the
content, next to the thing being explained — not in a caption under the title.

**Project section chrome** — every project section except **Ask Piloti**
(chat) opens with the same band: `border-b border-border bg-background px-4 py-4
md:px-8` around a `PageHeader`, so the title sits on one line with optional
actions on the right. The shapes are an action button (Jobs, Skills), a search
field (History), title-only (Settings), and — on Files, the densest of them —
the view and assignment toggles, the corpus search and Upload in that order,
left to right. **A section has one search.** Files puts its field in the header
beside the controls that act on the same listing, so there is no second search
band inside the pane; what stays over the listing is the result banner, which
belongs with the hits it counts. The field carries no run button: it reads as
the plain live filter History's does, and Enter commits the query to the corpus
search — the banner reports that run from its first frame. The intake wizard
is a content page too — `PageHeader` plus a `SectionLabel` eyebrow, never a
second `text-2xl` title. Projects home (above a project) uses the same
`PageHeader`. The org **Archiv** uses that same band as the first strip of its
sheet, carrying the document count beside the title and the upload control on
the right — it is the store's only header, not a second one under the page's.
Chat is the documented exception: it is a full-bleed conversation surface with
its own toolbar, not a content page. Evidence: `/dev/project-chrome`.

**Section** — eyebrow label + content, no heavy chrome:
```tsx
<section className="space-y-3">
  <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
  {content}
</section>
```

**Back navigation** — pages outside the project shell (Archiv, Organisation, Platform, Inbox, Profil) drop the rail, so their back control is the whole way out. It is `BackLink` (`components/shell/back-link.tsx`), never a hand-rolled `<Link>`: an arrow in a raised disc plus a label that **names where the reader actually came from**, read from the tab's return trail (`lib/navigation/return-trail`, recorded by `NavigationTrail` in the root layout). Out of a project the name is the PROJECT'S — "Zurück zu Stadthaus Wien" — written into the trail by `NavigationTrailLabel` in the project shell while the reader was there, because a path holds an id and an id is not a name, and leaving that project is what the reader is undoing. Everywhere else the label comes from the destination's own `nav.sections.*` entry, so the wording cannot drift from the rail's. Navigation goes through `history.back()`, which restores the page as it was left — scroll position and open panels included — where a push to the same URL would not. Each page still passes a server-resolved `fallbackHref`/`fallbackLabel` for the case with no trail (new tab, direct link). A back control that guesses a destination is worse than none: it teaches the reader that back does not work.

Tabbed shells (Organisation, Platform, and the same pattern on Inbox) are **one place**, not a stack of submenus. Switching Models → Knowledge `replace`s the URL and collapses those siblings on the trail, so Back leaves the shell and returns to the project — it does not walk the previous settings tab. Project sections stay a real stack: Files → Chat is a step.

**Stat** — `rounded-lg border bg-card p-5`, number in `text-2xl font-semibold tabular-nums`, label in `text-sm text-muted-foreground` below.

**Search** — `SearchField` (`components/ui/search-field.tsx`) is the one magnifier + input + clear control. The file surfaces compose it inside `FileSearchField`, which Files renders in the page header and the Archiv inside `FileSearchBar` (the sticky band, field + result banner). Its optional `runButton` decides how VISIBLE the semantic run is, never whether it is reachable: Enter always submits, so a field without the button — Files — still reaches the corpus search. The banner is `FileSearchBanner` and always sits over the hits it counts, wherever the field went. Admin lists compose `SearchField` inside `DataToolbar`. Do not hand-roll another `relative` + `Search` icon + `Input`.

**Exclusive / multi filters** — `ToggleGroup` (`components/ui/toggle-group.tsx`). Segmented icon clusters (Files view switcher) use `segmented`. Inverted pills (folder / category chips) use `variant="inverted"`. Exclusive form choices with a description (job output) use `RadioGroup`, not a toggle row.

**Form field** — `Field` + `FieldLabel` + `FieldDescription` + `FieldError`. TanStack-backed forms wrap the same anatomy through `FieldShell`. Raw `<label>` next to an `Input` is a leftover.

**List container** — `ItemList` (`rounded-lg border divide-y`) with `Item` / `ItemMedia` / `ItemContent` / `ItemTitle` / `ItemDescription` / `ItemActions`. That is the list molecule for History, Inbox, Settings rosters, and admin pickers. Do not hand-roll a second `rounded-lg border` + `divide-y` row. The raised product card (Files tiles, project cards) is `RaisedCard`, not `Item`.

**Empty state** — `EmptyState` (`components/ui/empty-state.tsx`), never bare
text and never hand-rolled. The icon sits in a **raised disc** — border, card
surface, soft shadow — because a disc that catches the light reads as
considered where a flat muted circle reads as a placeholder. `variant="panel"`
adds the dashed container; the bare variant is for an empty region inside a
surface that already has a border.

```tsx
<div className="flex w-full min-w-0 flex-col items-center justify-center text-center
                rounded-lg border border-dashed bg-muted/25 px-6 py-12">
  <div className="mb-4 flex size-12 items-center justify-center rounded-full
                  border bg-card text-muted-foreground/70 shadow-sm">
    <Icon className="size-5" aria-hidden />
  </div>
  <p className="text-balance text-[15px] font-semibold tracking-tight text-foreground">{title}</p>
  <p className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">{whyAndWhatToDo}</p>
  <div className="mt-5">{primaryAction}</div>
</div>
```

**Loading** — Skeletons matched to the real content's shape (never a spinner for page-level loads; spinner only for inline/button-level). Match row heights and counts to the eventual layout.

**Error** — `Alert variant="destructive"` for load failures with a helpful message + retry; `sonner` toast for transient action failures; inline field errors for forms (already handled by the TanStack Form FieldShell). Error red (`--signal-error`) is for errors only — never for emphasis.

**Counts** — `CountPill` (`components/ui/count-pill.tsx`) is the one rounded-full numeric pill. `tone="muted"` (default) for a quiet number beside a heading or tab label; `tone="attention"` — near-black action ink — only when the count *is* the signal that something waits for the reader (the inbox badge). Never hand-roll a third shape; never reach for chroma here (ink, because chroma belongs to provenance).

**People** — a group of people is `AvatarStack` (`components/ui/avatar-stack.tsx`): overlapping `Avatar` discs in the order given (it never re-sorts — ordering is the caller's information), ring-separated, tail collapsed into a neutral `+N`. `sm` is 28px, not 24px: below that the overlap plus the ring clips the second initial. A single disc is `PersonAvatar` from the same module. Identity colour and initials come from `components/ui/avatar-identity.ts` — keyed on the **user id** so one colleague is one colour on every surface, and generated as a hue only: lightness comes from `color-mix()` against `--card`/`--foreground`, so dark mode needs no second palette. **Identity is not signal**: these tints carry no meaning, always ride with initials or a photo, and are deliberately off the provenance hues.

**Scroll boundaries** — a bounded list that clips its next row through the middle of its text reads as broken, not as "there is more below". Dissolve the edge with the `scroll-fade-bottom` utility (`app/globals.css`) on the scroll container itself. It is a **mask**, not an overlay gradient: masking composites against whatever surface the list happens to sit on (popover, card, dialog), so it names no colour and light/dark are free — an overlay would have to hard-code a surface token and be wrong on the next surface. It stays a one-line utility rather than a wrapper component precisely because it is one paint rule with no DOM, no state and no children. Anything that must stay sharp (a keyboard-hint footer, a dialog footer) belongs *outside* the faded scroll region.

**Status badges** — Badge variants: `success` (ready/completed — project green family), `info` (in-progress/running — law blue family), `warning` (needs attention — office gold family), `destructive` (failed — signal red), `secondary` (neutral/cancelled). Project status chips: "Aktiv" = `--status-active(-tint)` (green), "Abgeschlossen" = `--status-done(-tint)` (warm gray) — always dot/icon + label, never a bare color dot.

## Motion vocabulary

One scale, one set of curves, four springs. Durations and easings are tokens
in `src/styles/tokens.css`; the springs and tweens live in
`src/components/motion/index.tsx`. **Never write a literal duration or
cubic-bezier in a component.**

### Durations

| Token / class | ms | For |
|---|---|---|
| `--motion-snap` / `duration-snap` | 120 | Press, checkbox tick, hover on dense rows |
| `--motion-quick` / `duration-quick` | 180 | **Default.** Colour, opacity, small transforms, chip in/out, row exit |
| `--motion-base` / `duration-base` | 240 | Content entrance (fade+rise), popover open, accordion height, skeleton→content |
| `--motion-deliberate` / `duration-deliberate` | 320 | **Ceiling.** Sheet, drawer, wizard step, panel open/close |
| `--motion-ambient` / `duration-ambient` | 1600 | Indeterminate loops: progress sweep, typing dots, connection ping |
| `--motion-ambient-slow` | 2600 | Text shimmer |

Exits run **one step shorter** than their entrance. Nobody wants to watch a
thing they just dismissed.

### Easings

| Token / class | cubic-bezier | For |
|---|---|---|
| `--ease-out` / `ease-out` | `0, 0, 0.2, 1` | Colour, opacity, hover, press |
| `--ease-entrance` / `ease-entrance` | `0.16, 1, 0.3, 1` | Anything that **moves** on arrival |
| `--ease-exit` / `ease-exit` | `0.4, 0, 1, 1` | Anything **leaving** — departure accelerates away |
| `--ease-cycle` / `ease-cycle` | `0.65, 0, 0.35, 1` | **Only** looping / indeterminate motion |

No `linear`, no `ease-in-out` on a one-shot, no bare `ease`. An eslint rule
(`grid/motion-vocabulary`) flags `transition-all`, `ease-linear` and
transitions on layout-triggering properties.

### Springs

| Name | stiffness / damping / mass | ζ | Overshoot | For |
|---|---|---|---|---|
| `springPress` | 600 / 38 / 0.6 | 1.00 | **0%** | Press and release, tap scale, checkbox. Chosen for interruptibility and velocity carry-over, not bounce — a tween cannot resolve a press interrupted mid-flight. |
| `springSnap` | 520 / 30 / 1 | 0.658 | **6.4%** | **Travel ≤ 24px only.** Toggle thumb, segmented indicator, icon swap, landing file, snap-back. |
| `springDrawer` | 260 / 26 / 1 | 0.806 | **1.4%** | **Travel ≤ ~145px.** Large but BOUNDED surfaces: research panel, wizard step, a card settling. |
| `springGlide` | 260 / 29 / 1 | 0.899 | **0.157%** | **Unbounded travel.** The distance is not knowable when the transition is written: shared-layout chips, anything whose travel is the reader's route history. |

`springSnapLinear` / `springDrawerLinear` are CSS `linear()` equivalents for
Radix-driven, class-only cases (`Switch`). A zero-overshoot spring needs none —
it *is* an ease-out.

**Overshoot is budgeted in pixels, not percent.** 6.4% of an 18px toggle thumb
is 1.2px — a detent you feel. 6.4% of a 400px drawer is 26px — a trampoline.
Same number, opposite verdict. That is why `springSnap` carries a 24px ceiling
as part of its contract rather than as advice.

**Which is why there are four and not three.** The first three each hold the
pixel budget up to a ceiling, so picking one means knowing the travel in
advance. Sometimes you cannot: the nav rail's active pill is a shared-layout
chip whose distance is whatever the reader's last two routes happen to be —
38px between neighbours, 288px from the top of the column to Inbox at the
bottom. On `springDrawer` the short hop is 0.53px and the long one is 4.0px,
which on a 38px row pitch is the pill barging into the row above its target.
`springGlide` is calibrated the other way round: ζ high enough that the pixel
overshoot is in budget at *any* distance (0.44px at 288px, 0.69px at 448px)
rather than up to a ceiling. It shares `springDrawer`'s natural frequency, so
only the landing differs, not the arrival time.

**And why a sheet takes a tween.** Past roughly 300px of travel there is no
spring left to pick: anything with a perceptible overshoot percentage is out of
budget by construction, and anything damped enough to stay in it is an ease-out
with extra steps. A sheet's travel is its own width — 288px on the mobile nav,
448px for a `sm:max-w-md` panel — so it takes `--motion-deliberate` on
`--ease-entrance`, the same pair `DockedPanel` uses. A panel half the screen
wide flying 6px past its edge and coming back is precisely the failure the
pixel budget exists to catch.

### When a spring is earned

A spring is earned when **the motion's trajectory carries information the
endpoint does not.** Three ways:

1. **Continuation** — the element is completing an input the user made in the
   last ~400ms. The spring is their gesture's momentum, handed back.
2. **Direction of travel** — it came from somewhere and the reader must know
   where, so it can be found again.
3. **Snap-back** — it failed to reach a destination and returned. The overshoot
   *is* the message "that didn't take."

Everything else is a tween. **Four vetoes override all of the above:** travel
over 24px never uses `springSnap`, and travel over ~145px never uses
`springDrawer`; anything carrying legal, evidentiary,
provenance or error content is tween-only; and anything appearing more than
about five times per screenful is tween-only, because a spring repeated thirty
times stops being a physical cue and becomes texture.

### Fixed choreography

- Content entrance: `animate-in fade-in-0` (+ `slide-in-from-bottom-1` for
  cards) via tw-animate-css.
- **Chat turn entrance** — every block arriving in the transcript uses the same
  fade-and-rise: `animate-in fade-in-0 slide-in-from-bottom-1 duration-base
  ease-entrance motion-reduce:animate-none`. That includes `AgentPrompt` and the
  `DeepResearchBanner` / `ErrorBanner` / `NoSourcesBanner` notices — a banner
  that pops in unanimated reads as a different class of object than the answer
  beside it.
- **State changes inside an arrived turn are transitions, not entrances**:
  `AgentPrompt` dims to `opacity-75`; the answer's meta row is reserved at chip
  height (`min-h-6`) so late chips cannot grow the footer, then fades in on a
  short delay with `[animation-fill-mode:backwards]`, and the source chips
  cascade on a 40ms per-chip stagger.
- **Staggers are always capped** — `Stagger` ships a ceiling
  (`staggerMaxSteps`), because an uncapped stagger delayed one screen's seventh
  row by 350ms. Never on a list the reader opened to reach one specific row.
- Height changes (accordions, thinking steps): CSS grid-rows or Radix
  Collapsible, `--motion-base`.
- Hover: `transition-colors` on interactive rows and links; never transform on
  hover for dense UI. The raised card's lift is the documented exception, and it
  is a tween.
- Skeleton pulse is the only ambient motion at rest, and never more than one
  ambient loop per viewport.

### Binding constraints

- **Transform and opacity only.** Never animate `width`, `height`, `margin`,
  `padding`, `top/left/right/bottom`, `gap` or `grid-template-*`. A panel that
  changes size sets its size in one pass and **translates** its content.
- **`prefers-reduced-motion` flattens everything.** `<MotionConfig
  reducedMotion="user">` covers motion/react; the global rule in `globals.css`
  clamps `animation-duration`, `transition-duration` **and the delays**. The
  delay is not optional: a staggered element that keeps its delay is simply
  invisible for that long, which is the opposite of what the reader asked for.
  Every animation still carries `motion-reduce:animate-none` and every non-hover
  transition `motion-reduce:transition-none`. (Hover `transition-colors` is
  exempt — a colour change on pointer intent is feedback, not motion.)
- **No chroma from motion.** Springs overshoot, and an overshooting colour lands
  outside its token — so colour never springs.

### Never

Numbers counting up. Shaking an error. Morphing a skeleton. Fading a focus ring.
Animating a citation, a legal basis, a § reference or a knowledge gap on its own.
More than one ambient loop on screen. `ease-linear`. `transition-all`.

## Domain-specific treatments

- **LegalBasisCard** = the product's proof-of-work. Treat as a first-class quotation: a distinct but quiet card, a thin left accent border in the law signal (`border-l-2 border-l-source-law/40`), the law/Richtlinie + article/§ in a header row (§ refs in `font-mono`), the cited excerpt as an actual blockquote (`border-l` muted, italic optional, readable measure), and a plain-language summary. It should read like an authoritative citation, not a chat bubble.
- **Citations/sources** — numbered, verifiable, hover-to-preview where possible; every citation chip carries its provenance signal (icon + label + color); source filenames in the file corpus should feel traceable.
- **Knowledge gaps ("Lücke")** — missing knowledge is rendered honestly as a first-class source entry in the gray `--source-auto` family (gap icon + label + remediation hint), never hidden.
- **Deep-research progress** — legible over noisy: a calm task checklist as the primary signal; thinking/tools/files are secondary tabs. Progress should feel like watching a competent analyst work, not a log stream.
- **Project Brief** (overview) — the architect's owned context; reads like a concise fact sheet the agent works from, with clear "what Piloti still doesn't know" prompts.

## Do-not

- No gradients.
- No emojis anywhere in UI. Icons are lucide-react only.
- No hardcoded colors — tokens only, so dark mode is free.
- No nested cards (card-inside-card). Flatten with borders/dividers/spacing.
- No purple/generic-AI aesthetic. **Provenance signals are the only chroma** — no accent-colored buttons, no blue active states (actions and focus are ink), and a source color is never used outside its meaning or without its icon + label.
