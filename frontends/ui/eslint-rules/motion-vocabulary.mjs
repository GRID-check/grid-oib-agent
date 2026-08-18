/**
 * Three Tailwind motion utilities this design language does not have a use for.
 *
 * Motion here is decoration with a job: it explains what changed and where it
 * came from. That makes it cheap to get wrong in ways nobody notices until a
 * dense screen starts to shimmer, so the three below are worth catching in the
 * editor rather than in a screenshot diff.
 *
 *   `transition-all`      — animates every animatable property, including the
 *                           ones you did not think about. A card that meant to
 *                           cross-fade its border now also animates its shadow,
 *                           its background-position and its width when a
 *                           sibling reflows. It is also the reason "why did
 *                           this flash on mount" bugs are hard to find: the
 *                           offender is a property nobody chose. Name the
 *                           properties (`transition-colors`, `transition-opacity`,
 *                           `transition-transform`).
 *
 *   `ease-linear`         — constant speed from a standstill. Nothing physical
 *                           moves that way, and the eye reads it as mechanical,
 *                           which is the opposite of what an understated tool
 *                           wants. The exception is a LOOP, where there is no
 *                           arrival to decelerate into — and a loop should say
 *                           so with `ease-cycle`, or use `linear` inside its own
 *                           `@keyframes`/`animation` shorthand rather than as a
 *                           transition timing function.
 *
 *   `transition-[width]`  — and height/margin/padding/top/left/right/bottom.
 *   and friends             These are LAYOUT properties: the browser cannot
 *                           composite them, so every frame re-runs layout for
 *                           the whole subtree. On a sidebar or a list that is
 *                           the difference between motion and jank. The
 *                           substitutes are real: `transform`/`scale` for size
 *                           and position, a `grid-template-rows: 0fr → 1fr`
 *                           transition (or Radix's collapsible height vars) for
 *                           an accordion, `translate` for anything sliding.
 *
 * Reported as warnings, not errors, on the same reasoning as `no-console`: the
 * rule exists to stop new instances, and the handful already in the tree
 * (vendored shadcn sidebar chrome, one progress bar) should be visible without
 * turning every unrelated lint run red.
 */

/** Layout properties whose transition costs a re-layout per frame. */
const LAYOUT_PROPERTIES = ['width', 'height', 'margin', 'padding', 'top', 'left', 'right', 'bottom']

const LAYOUT_TRANSITION = new RegExp(
  `^transition-\\[[^\\]]*\\b(?:${LAYOUT_PROPERTIES.join('|')})\\b`,
)

/**
 * The utility itself, with any variant prefixes and `!` important marker
 * stripped, so `md:transition-all` and `transition-all!` are the same finding.
 *
 * Prefixes are only stripped while they are plain (`hover:`, `md:`): a variant
 * carrying its own brackets (`group-data-[side=left]:`) is left alone, because
 * the result would not match any pattern below anyway and a half-parsed token
 * is worse than an unparsed one.
 */
function baseUtility(token) {
  return token.replace(/^(?:[^:[\]]+:)+/, '').replace(/!$/, '')
}

/** The finding for one whitespace-delimited class token, or null. */
function classify(token) {
  const base = baseUtility(token)
  if (base === 'transition-all') return 'transitionAll'
  if (base === 'ease-linear') return 'easeLinear'
  if (LAYOUT_TRANSITION.test(base)) return 'layoutTransition'
  return null
}

/**
 * Report every off-vocabulary utility in one string of class names.
 *
 * Matching is on whole whitespace-delimited tokens rather than on substrings:
 * a string that contains `transition-all` as its own token is a class list in
 * practice, while a substring match would flag prose and CSS-in-JS that merely
 * mentions the word.
 */
function checkText(context, node, text) {
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    const messageId = classify(token)
    if (messageId) context.report({ node, messageId, data: { utility: token } })
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Ban transition-all, ease-linear and transitions of layout properties, which are outside the GRID motion vocabulary',
    },
    schema: [],
    messages: {
      transitionAll:
        '`{{utility}}` transitions every animatable property, including ones this component never chose to animate — that is where surprise shadow/background/size moves come from. Name the properties instead: transition-colors, transition-opacity, transition-transform.',
      easeLinear:
        '`{{utility}}` moves at constant speed from a standstill, which reads as mechanical rather than physical. Use `ease-out` (`--ease-out`) for responses, `ease-entrance` for arrivals, `ease-exit` for dismissals, or `ease-cycle` for something that genuinely loops.',
      layoutTransition:
        '`{{utility}}` animates a LAYOUT property, so the browser re-runs layout for the subtree on every frame instead of compositing. Use transform/scale/translate for size and position, or a grid-template-rows 0fr→1fr transition for an accordion height.',
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
