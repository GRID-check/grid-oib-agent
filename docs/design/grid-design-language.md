# GRID Design Language

> Branding note (2026-07-17): the user-facing product brand — wordmark, tab titles, all UI copy — is **Piloti** (`src/lib/brand.ts`). GRID remains the internal/platform name, including this design language and its tokens (e.g. the `--grid-blue` alias).

The single reference every page redesign builds against. Goal: an **understated, premium, precise** tool for architects doing building-compliance work — Linear/Vercel/Stripe-dashboard restraint, not consumer SaaS. Calm, trustworthy, dense-but-legible. No gradients, no emojis, no decorative color.

The visual language is **warm paper monochrome + provenance signal colors** (adopted from the click-dummy overhaul, see `docs/design/click-dummy-overhaul-spec.md` §1/§4): warm paper surfaces, a near-black ink ramp, hairline alpha-ink borders, layered soft shadows, **near-black action buttons** — and the *only* chroma in the app is the source/provenance signal system.

## Principles

1. **Restraint is the aesthetic.** Warm paper surfaces (`#f6f6f4`-family, warm charcoal in dark mode), a near-black ink ramp, and **no brand accent color**: the primary action is ink (`#1f2023`, white text; paper-white on ink in dark mode). If everything is highlighted, nothing is. Blue is *not* the action color — it belongs to the Baurecht provenance signal.
2. **Provenance is the only color.** The one place chroma exists is the source signal system (`--source-law` blue, `--source-project` green, `--source-office` gold, `--source-auto` gray, `--signal-error` red). It runs through composer, citations, history filters, and insights — it is the product's trust affordance. **Color never travels alone: every signal is always icon + label + color together** (a11y and legibility). Green doubles as status "Aktiv"; red is for errors only.
3. **Authority through precision.** This tool cites Austrian building law. Citations, legal-basis, and document provenance must look verifiable and exact — monospace for identifiers, clear source attribution, never decorative.
4. **Hierarchy over density.** Dense is fine (architects handle complex data), but every screen has ONE clear focal point and a legible reading order. Whitespace does the separating, not boxes-within-boxes.
5. **Quiet motion.** Entrance fades (`nodeIn`-style fade + slight rise for cards/trace nodes), smooth height transitions (thinking steps, accordions), skeleton→content. 150–250ms, ease-out. No bounce, no spring, no decoration. Respect `prefers-reduced-motion`.
6. **Every state is designed.** Loading, empty, error, partial, success. Empty states especially are craft opportunities, not afterthoughts — they orient and invite the next action.

## Tokens (already defined in src/styles/tokens.css)

Use shadcn semantic classes: `bg-background/card/muted/accent`, `text-foreground/muted-foreground`, `border`, `bg-primary/text-primary-foreground` (primary = **ink**, near-black), `bg-destructive`, `ring-ring`. Feedback subtle backgrounds via the `--background-color-feedback-*-subtle` vars (already wired into Badge/Alert success/warning/info/destructive variants — these now resolve to the provenance tints). Never hardcode hex/oklch in components.

**Surfaces (light):** app bg `--background` ≈ #f6f6f4 warm paper · sidebar/rails `--background-color-surface-sunken` ≈ #f1f1ef · cards white · subtle input surface `--input-background` ≈ #fafaf8 · chip/quiet fill `--secondary`/`--muted` ≈ #f2f2f0 · inset/hover `--accent` ≈ #ececea. Dark mode is the derived warm-charcoal equivalent (same warm hues, no cold blue-grays).

**Ink ramp (light):** #1f2023 (foreground/action) → #55565a secondary → #6f706c muted → #8a8a86 placeholder → #b3b3af ghost. Borders are **alpha ink hairlines** (`rgba(28,30,33,…)` equivalents at .08 base / .12 input / .16 strong / .22–.32 selected), so they composite on any surface. Focus ring is ink-based (`--ring`), never blue.

**Provenance signal system** — each signal has a base color, a `-tint` surface (for chips/rows on cards), and a `-text` variant (AA-readable on the tint), both modes:

| Token family | Light base | Meaning | Paired icon |
|---|---|---|---|
| `--source-law(-tint/-text)` | blue #2359d3 | Baurecht & Richtlinien (RIS, BO Wien, OIB) | "§" |
| `--source-project(-tint/-text)` | green #17914d | Projektwissen (project documents) | doc |
| `--source-office(-tint/-text)` | gold #c08c28 | Büroarchiv (office archive) | archive box |
| `--source-auto(-tint/-text)` | gray #83837f | Automatisch / **Lücke** (knowledge gap) | globe / gap |
| `--status-active(-tint)` | = project green | status "Aktiv" | dot |
| `--status-done(-tint)` | warm gray | status "Abgeschlossen" | dot |
| `--signal-error(-tint)` | red #c14a38 | errors only | alert |

All are mapped as Tailwind colors (`bg-source-law-tint`, `text-source-law-text`, `border-source-office`, `bg-status-active-tint`, …). **Rule: color never travels alone — a provenance color always appears together with its icon and a text label.** Never use a source color decoratively or for anything but its meaning. `--grid-blue` survives only as a legacy alias of the law blue; it is not an accent.

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

**Page header** — every content page opens with:
```tsx
<header className="flex items-end justify-between gap-4">
  <div>
    <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
    <p className="mt-1 text-sm text-muted-foreground">{oneLineContext}</p>
  </div>
  {primaryAction}
</header>
```

**Section** — eyebrow label + content, no heavy chrome:
```tsx
<section className="space-y-3">
  <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
  {content}
</section>
```

**Stat** — `rounded-lg border bg-card p-5`, number in `text-2xl font-semibold tabular-nums`, label in `text-sm text-muted-foreground` below.

**List container** — one `rounded-lg border bg-card`, rows `divide-y`, each row `flex items-center justify-between gap-4 px-5 py-3`.

**Empty state** — crafted, never bare text:
```tsx
<div className="rounded-lg border border-dashed bg-muted/40 p-10 text-center">
  <Icon className="mx-auto size-8 text-muted-foreground/60" />
  <p className="mt-3 text-sm font-medium">{headline}</p>
  <p className="mt-1 text-sm text-muted-foreground">{oneLine why + what to do}</p>
  <Button className="mt-4">{primaryCTA}</Button>
</div>
```

**Loading** — Skeletons matched to the real content's shape (never a spinner for page-level loads; spinner only for inline/button-level). Match row heights and counts to the eventual layout.

**Error** — `Alert variant="destructive"` for load failures with a helpful message + retry; `sonner` toast for transient action failures; inline field errors for forms (already handled by the TanStack Form FieldShell). Error red (`--signal-error`) is for errors only — never for emphasis.

**Status badges** — Badge variants: `success` (ready/completed — project green family), `info` (in-progress/running — law blue family), `warning` (needs attention — office gold family), `destructive` (failed — signal red), `secondary` (neutral/cancelled). Project status chips: "Aktiv" = `--status-active(-tint)` (green), "Abgeschlossen" = `--status-done(-tint)` (warm gray) — always dot/icon + label, never a bare color dot.

## Motion vocabulary

- Content entrance: `animate-in fade-in-0` (+ `slide-in-from-bottom-1` for cards — the dummy's `nodeIn` fade-rise) via tw-animate-css.
- Height changes (accordions, thinking steps): CSS grid-rows or Radix Collapsible transitions, ~200ms ease-out.
- Hover: `transition-colors` on interactive rows/links; never transform on hover for dense UI.
- Skeleton pulse is the only ambient motion.

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
