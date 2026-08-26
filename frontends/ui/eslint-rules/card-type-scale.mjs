/**
 * The card type ramp is seven steps and one figure. This rule is what keeps it
 * seven.
 *
 * `docs/design/grid-card-charter.md` §A2 fixes the scale for
 * `src/features/grid-cards/**`: Eyebrow 10.5 (outside cards only), Meta 11,
 * Caption 12, Body 13.5, Prose 15/400, Title 14, Value 15/600, Figure 20 —
 * expressed as the `card-*` classes in `src/app/globals.css`.
 *
 * The audit that produced the charter found THIRTEEN
 * distinct sizes in the folder, ten of them arbitrary values, with
 * `text-[12px]` next to `text-xs` and `text-[14px]` next to `text-sm`: the same
 * size written two ways, twice. Nothing was wrong with any single call site,
 * which is exactly why it drifted — a size is chosen once, in a hurry, against
 * whatever the neighbouring card happened to do.
 *
 * So the rule bans FONT SIZES, not classes in general: every `text-<step>` from
 * Tailwind's own scale and every arbitrary `text-[…px|rem|em]`. The repo's
 * semantic ink utilities (`text-muted-foreground`, `text-subtle`, `text-error`,
 * `text-success`, …) are also spelled `text-*` and are untouched — a colour is
 * not a size, and §A3 gives colour its own five axes.
 *
 * It is switched on PER FILE in eslint.config.mjs rather than across the
 * folder. The charter's migration policy is deliberate (§A2): a flag-day
 * rewrite of 200 call sites is not worth the review burden, so a card is
 * migrated when a sprint touches it for another reason — and "a card that has
 * been through a §C sprint and still carries an off-ramp size has not passed."
 * A per-file `files:` list says exactly that in config, and it grows by one
 * line per card. The alternative — one rule over the whole folder with an
 * exemption list inside it — puts the not-yet-migrated cards somewhere nobody
 * reads, which is the failure mode `scripts/check-static-utility-modifiers.mjs`
 * argues against at length.
 */

/** Tailwind's own font-size scale. Every one of these is off-ramp in a card. */
const TAILWIND_TEXT_SIZES = new Set([
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'text-3xl',
  'text-4xl',
  'text-5xl',
  'text-6xl',
  'text-7xl',
  'text-8xl',
  'text-9xl',
])

/** `text-[13.5px]`, `text-[0.8rem]`, `text-[1em]` — an arbitrary font size. */
const ARBITRARY_TEXT_SIZE = /^text-\[[\d.]+(?:px|rem|em|pt)\]$/

/** The step to reach for, by the size the author wrote. */
const NEAREST_STEP = [
  [11.5, 'card-meta (11px)'],
  [12.75, 'card-caption (12px) — pill and chip text; a NOTE belongs at card-body'],
  [13.75, 'card-body (13.5px)'],
  [14.5, 'card-title (14px)'],
  [16, 'card-value (15px) for a measured quantity, or card-prose (15px) for a sentence'],
  [Infinity, 'card-figure-20 (20px) — and only if this is the card ANSWER (§A2: one per card)'],
]

/** Tailwind's `text-*` scale in px, so a bare `text-sm` gets advice too. */
const SIZE_OF = {
  'text-xs': 12,
  'text-sm': 14,
  'text-base': 16,
  'text-lg': 18,
  'text-xl': 20,
  'text-2xl': 24,
  'text-3xl': 30,
  'text-4xl': 36,
  'text-5xl': 48,
  'text-6xl': 60,
  'text-7xl': 72,
  'text-8xl': 96,
  'text-9xl': 128,
}

/** px for an arbitrary value, so rem/em land on the right step. */
function pixelsOf(token) {
  if (SIZE_OF[token] !== undefined) return SIZE_OF[token]
  const match = /^text-\[([\d.]+)(px|rem|em|pt)\]$/.exec(token)
  if (!match) return null
  const value = Number(match[1])
  if (match[2] === 'rem' || match[2] === 'em') return value * 16
  if (match[2] === 'pt') return value * (96 / 72)
  return value
}

/** The ramp step nearest a size in px. */
function suggestionFor(token) {
  const px = pixelsOf(token)
  if (px === null) return 'a step from the ramp'
  return NEAREST_STEP.find(([ceiling]) => px <= ceiling)[1]
}

/**
 * The utility with variant prefixes and the `!` important marker stripped, so
 * `md:text-sm` and `text-sm!` are the same finding. Prefixes are only stripped
 * while they are plain, for the reason motion-vocabulary.mjs gives: a variant
 * carrying its own brackets would leave a half-parsed token behind, and a
 * half-parsed token is worse than an unparsed one.
 */
function baseUtility(token) {
  return token.replace(/^(?:[^:[\]]+:)+/, '').replace(/!$/, '')
}

/** Report every off-ramp font size in one string of class names. */
function checkText(context, node, text) {
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    const base = baseUtility(token)
    if (!TAILWIND_TEXT_SIZES.has(base) && !ARBITRARY_TEXT_SIZE.test(base)) continue
    context.report({
      node,
      messageId: 'offRamp',
      data: { utility: token, step: suggestionFor(base) },
    })
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Grid cards use the seven-step type ramp from grid-card-charter.md §A2 (the card-* classes in globals.css), never a raw Tailwind or arbitrary font size',
    },
    schema: [],
    messages: {
      offRamp:
        '`{{utility}}` is a font size outside the card type ramp (grid-card-charter.md §A2). Thirteen sizes is how the card set lost its hierarchy — use {{step}}.',
    },
  },

  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return
        checkText(context, node, node.value)
      },
      TemplateElement(node) {
        checkText(context, node, node.value.cooked ?? node.value.raw ?? '')
      },
    }
  },
}
