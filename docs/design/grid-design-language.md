# GRID Design Language

The single reference every page redesign builds against. Goal: an **understated, premium, precise** tool for architects doing building-compliance work — Linear/Vercel/Stripe-dashboard restraint, not consumer SaaS. Calm, trustworthy, dense-but-legible. No gradients, no emojis, no decorative color.

## Principles

1. **Restraint is the aesthetic.** Near-monochrome zinc surfaces, one blue accent used sparingly (active state, primary action, brand mark, in-progress). If everything is highlighted, nothing is.
2. **Authority through precision.** This tool cites Austrian building law. Citations, legal-basis, and document provenance must look verifiable and exact — monospace for identifiers, clear source attribution, never decorative.
3. **Hierarchy over density.** Dense is fine (architects handle complex data), but every screen has ONE clear focal point and a legible reading order. Whitespace does the separating, not boxes-within-boxes.
4. **Quiet motion.** Entrance fades, smooth height transitions (thinking steps, accordions), skeleton→content. 150–250ms, ease-out. No bounce, no spring, no decoration. Respect `prefers-reduced-motion`.
5. **Every state is designed.** Loading, empty, error, partial, success. Empty states especially are craft opportunities, not afterthoughts — they orient and invite the next action.

## Tokens (already defined in src/styles/tokens.css)

Use shadcn semantic classes: `bg-background/card/muted/accent`, `text-foreground/muted-foreground`, `border`, `bg-primary/text-primary-foreground`, `text-primary`, `bg-destructive`, `ring-ring`. Feedback subtle backgrounds via the `--background-color-feedback-*-subtle` vars (already wired into Badge/Alert success/warning/info/destructive variants). Never hardcode hex/oklch in components.

## Type ramp (Tailwind classes — use verbatim)

| Role | Classes |
|---|---|
| Page title | `text-2xl font-semibold tracking-tight` |
| Section heading | `text-lg font-semibold tracking-tight` |
| Card/subsection title | `text-sm font-semibold` |
| Eyebrow / label | `text-xs font-medium uppercase tracking-wider text-muted-foreground` |
| Body | `text-sm` (leading-relaxed for prose) |
| Body secondary | `text-sm text-muted-foreground` |
| Caption / meta | `text-xs text-muted-foreground` |
| Identifiers (job id, § refs, collection names) | `font-mono text-xs` |
| Numeric stat | `text-2xl font-semibold tracking-tight tabular-nums` |

## Spacing & layout rhythm

- **Page container:** `mx-auto w-full max-w-5xl px-4 py-8 md:px-8` (content pages). Chat/full-bleed surfaces are exceptions.
- **Vertical section gap:** `space-y-8` between major sections; `space-y-4` within a section; `gap-3` in tight lists.
- **Card padding:** `p-6` for feature cards, `p-5` for stat cards, `px-4 py-3` for list rows.
- **Radius:** cards `rounded-lg` (var --radius), inputs/buttons follow shadcn defaults, pills/badges `rounded-md`.
- **Borders:** hairline `border` (border-border). Prefer a single border + `bg-card` over nested boxes. Use `divide-y` for list groups inside one bordered container.

## Component patterns

**Page header** — every content page opens with:
```tsx
<header className="flex items-end justify-between gap-4">
  <div>
    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    <p className="mt-1 text-sm text-muted-foreground">{oneLineContext}</p>
  </div>
  {primaryAction}
</header>
```

**Section** — eyebrow label + content, no heavy chrome:
```tsx
<section className="space-y-3">
  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
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

**Error** — `Alert variant="destructive"` for load failures with a helpful message + retry; `sonner` toast for transient action failures; inline field errors for forms (already handled by the TanStack Form FieldShell).

**Status badges** — Badge variants: `success` (ready/completed), `info` (in-progress/running), `warning` (needs attention), `destructive` (failed), `secondary` (neutral/cancelled).

## Motion vocabulary

- Content entrance: `animate-in fade-in-0` (+ `slide-in-from-bottom-1` for cards) via tw-animate-css.
- Height changes (accordions, thinking steps): CSS grid-rows or Radix Collapsible transitions, ~200ms ease-out.
- Hover: `transition-colors` on interactive rows/links; never transform on hover for dense UI.
- Skeleton pulse is the only ambient motion.

## Domain-specific treatments

- **LegalBasisCard** = the product's proof-of-work. Treat as a first-class quotation: a distinct but quiet card, a thin left accent border (`border-l-2 border-l-primary/40`), the law/Richtlinie + article/§ in a header row (§ refs in `font-mono`), the cited excerpt as an actual blockquote (`border-l` muted, italic optional, readable measure), and a plain-language summary. It should read like an authoritative citation, not a chat bubble.
- **Citations/sources** — numbered, verifiable, hover-to-preview where possible; source filenames in the file corpus should feel traceable.
- **Deep-research progress** — legible over noisy: a calm task checklist as the primary signal; thinking/tools/files are secondary tabs. Progress should feel like watching a competent analyst work, not a log stream.
- **Project Brief** (overview) — the architect's owned context; reads like a concise fact sheet the agent works from, with clear "what Grid still doesn't know" prompts.

## Do-not

- No gradients (the one hairline brand gradient on /projects is being removed).
- No emojis anywhere in UI. Icons are lucide-react only.
- No hardcoded colors — tokens only, so dark mode is free.
- No nested cards (card-inside-card). Flatten with borders/dividers/spacing.
- No purple/generic-AI aesthetic. Blue accent is the only chroma.
