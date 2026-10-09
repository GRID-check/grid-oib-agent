/**
 * The Tailwind motion utilities this design language does not have a use for,
 * and the motion.dev props that animate layout.
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
 *   `duration-200`        — and every other numeric or arbitrary duration.
 *   and friends             The motion scale is four steps and a loop, each a
 *                           token (`duration-snap` 120, `duration-quick` 180,
 *                           `duration-base` 240, `duration-deliberate` 320,
 *                           `duration-ambient` for indeterminate loops), so a
 *                           literal number is either a token wearing its value
 *                           on its sleeve — which stops tracking the token the
 *                           day the scale is retuned — or a fifth step nobody
 *                           designed. The pattern anchors on the numeric /
 *                           bracketed value, so the tokens themselves
 *                           (`duration-snap`, `data-[state=open]:duration-base`)
 *                           never trip it.
 *
 *   `animate-pulse`       — Tailwind's 2s pulse to 50%, a loop off the motion
 *                           scale on its own bezier. A loop here runs on
 *                           `--motion-ambient` and `--ease-cycle`; for a live
 *                           mark that is `animate-caret-breathe` (globals.css).
 *
 *   `ease-in-out`,        — `ease-in-out` is a loop curve spelled outside the
 *   `ease-in`               vocabulary (`ease-cycle` is the loop curve), and
 *                           `ease-in` starts slow and stops hard, which is the
 *                           shape of nothing this app does: arrivals decelerate
 *                           (`ease-entrance`), departures use `ease-exit`.
 *
 *   `[animation-delay:…]` — a hand-written timing number, the same finding as a
 *   `[animation-duration:…]` literal duration. A stagger that is part of a
 *                           primitive lives in its `@utility` (the typing dots
 *                           derive theirs from `--motion-ambient`), and a
 *                           delayed entrance is a choreography decision that
 *                           belongs to a token, not to a call site.
 *
 *   `height`/`width`/     — as keys of a motion.dev `initial`/`animate`/`exit`
 *   `top`/`left` in         object literal. Same cost as a layout transition,
 *   motion props            run from JS. The design language permits a height
 *                           tween in one case only: a block arriving or folding
 *                           at or below the reading point, through the shared
 *                           arrival primitive, never in the frame of a large
 *                           commit, and instant under reduced motion. Such a
 *                           site says so with one `eslint-disable-next-line
 *                           grid/motion-vocabulary -- <why>` above the
 *                           element's opening tag (the finding is reported once
 *                           per element, there), so every height animation in
 *                           the tree is one grep away and carries its reason.
 *
 *   a spring on       — a motion element whose `animate`/`exit` (or `while*`)
 *   `opacity`             target animates `opacity` while the transition that
 *                         governs it is a spring token (`springSnap`, …), bare
 *                         or spread with no `opacity:` override. Opacity never
 *                         springs: a spring has no duration, so the fade runs
 *                         as long as the spring takes to settle (~500ms on
 *                         `springSnap`, played by WAAPI as a `linear()` curve),
 *                         and `<MotionConfig reducedMotion="user">` drops only
 *                         transforms, so the reduced-motion reader keeps that
 *                         half-second fade. Spring the transform, tween the
 *                         opacity: `iconSwapTransition` / `useIconSwapTransition`
 *                         in the motion kit, or `{ ...springSnap, opacity:
 *                         motionQuick }` through `useMotionToken`. Only
 *                         literals and the kit's spring names are read; a
 *                         transition held in a local variable is not followed.
 *
 * Reported as warnings, not errors, on the same reasoning as `no-console`: the
 * rule exists to stop new instances, and the handful already in the tree
 * (vendored shadcn sidebar chrome, one progress bar) should be visible without
 * turning every unrelated lint run red.
 */

/** Layout properties whose transition costs a re-layout per frame. */
const LAYOUT_PROPERTIES = ['width', 'height', 'margin', 'padding', 'top', 'left', 'right', 'bottom']

const LAYOUT_TRANSITION = new RegExp(
  `^transition-\\[[^\\]]*\\b(?:${LAYOUT_PROPERTIES.join('|')})\\b`
)

/**
 * A duration spelled as a number (`duration-200`) or an arbitrary value
 * (`duration-[180ms]`) rather than as one of the scale's tokens. Anchored on
 * the value so the tokens themselves — `duration-snap`, `duration-quick`,
 * `duration-base`, `duration-deliberate`, `duration-ambient`, with or without
 * variant prefixes — never match.
 */
const LITERAL_DURATION = /^duration-(?:\d+(?:\.\d+)?|\[[^\]]*\])$/

/** An arbitrary-property animation timing: `[animation-delay:160ms]`. */
const ARBITRARY_ANIMATION_TIMING = /^\[animation-(?:delay|duration):[^\]]*\]$/

/** Off-vocabulary easings: the loop curve spelled wrong, and the in-ramp. */
const OFF_VOCABULARY_EASING = new Set(['ease-in-out', 'ease-in'])

/** The motion.dev props whose keys are animated values. */
const MOTION_TARGET_PROPS = new Set(['initial', 'animate', 'exit'])

/** Layout keys in a motion target: each frame re-runs layout. */
const MOTION_LAYOUT_KEYS = new Set(['height', 'width', 'top', 'left'])

/** Targets that animate to their values; `initial` is where they start from. */
const MOTION_ANIMATING_PROPS = new Set([
  'animate',
  'exit',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileInView',
  'whileDrag',
])

/**
 * The motion kit's springs, legacy aliases included. `springSnapLinear` and the
 * other `*Linear` / `*Seconds` exports are CSS strings and numbers, not motion
 * transitions, and the anchors keep them out.
 */
const SPRING_TOKEN = /^spring(?:Press|Snap|Drawer|Glide|Snappy|Gentle)$/

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
  if (LITERAL_DURATION.test(base)) return 'literalDuration'
  if (ARBITRARY_ANIMATION_TIMING.test(base)) return 'arbitraryAnimationTiming'
  if (base === 'animate-pulse') return 'animatePulse'
  if (OFF_VOCABULARY_EASING.has(base)) return 'offVocabularyEasing'
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

/** The static name of a property key, or null for a computed one. */
function keyName(property) {
  if (property.computed) return null
  if (property.key.type === 'Identifier') return property.key.name
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value
  }
  return null
}

/**
 * The layout keys in one `initial={{…}}` / `animate={{…}}` / `exit={{…}}`.
 *
 * Only an object literal written in the attribute itself is read: a variants
 * object or a value built elsewhere is not followed, because a half-followed
 * data flow is a rule that is wrong in both directions. That leaves the common
 * shape, the one a reviewer would otherwise have to catch.
 */
function layoutKeysOf(attribute) {
  if (attribute.type !== 'JSXAttribute') return []
  if (attribute.name.type !== 'JSXIdentifier' || !MOTION_TARGET_PROPS.has(attribute.name.name)) {
    return []
  }
  const value = attribute.value
  const expression = value?.type === 'JSXExpressionContainer' ? value.expression : null
  if (expression?.type !== 'ObjectExpression') return []
  return expression.properties
    .filter((property) => property.type === 'Property')
    .map(keyName)
    .filter((name) => name !== null && MOTION_LAYOUT_KEYS.has(name))
}

/**
 * One finding per ELEMENT, reported on its opening tag, so a sanctioned height
 * arrival takes one `eslint-disable-next-line` above the `<motion.div` with
 * its reason, rather than one per `initial`/`animate`/`exit` line.
 */
function checkMotionElement(context, node) {
  const keys = [...new Set(node.attributes.flatMap(layoutKeysOf))]
  if (keys.length === 0) return
  context.report({
    node,
    messageId: 'motionLayoutKey',
    data: { keys: keys.map((key) => `\`${key}\``).join(', ') },
  })
}

/** The `{…}` written in a JSX attribute, or null for anything else. */
function attributeExpression(attribute) {
  const value = attribute.value
  return value?.type === 'JSXExpressionContainer' ? value.expression : null
}

/** The value of a statically named property in an object literal, or null. */
function propertyValue(object, name) {
  const property = object.properties.find(
    (candidate) => candidate.type === 'Property' && keyName(candidate) === name
  )
  return property ? property.value : null
}

/**
 * The spring that would drive `opacity` under this transition expression, or
 * null when opacity tweens (or the expression is not one this rule can read).
 *
 * A bare spring token springs every key. An object literal springs opacity when
 * it has no `opacity:` key and its default is a spring, by spread
 * (`{ ...springSnap }`) or by `type: 'spring'`; with an `opacity:` key, the
 * answer is whatever that key holds. A conditional is a spring when either
 * branch is, since the branch that runs is the one a reviewer cannot see.
 */
function opacitySpring(node) {
  if (!node) return null
  if (node.type === 'Identifier') return SPRING_TOKEN.test(node.name) ? node.name : null
  if (node.type === 'ConditionalExpression') {
    return opacitySpring(node.consequent) ?? opacitySpring(node.alternate)
  }
  if (node.type === 'LogicalExpression') return opacitySpring(node.left) ?? opacitySpring(node.right)
  if (node.type !== 'ObjectExpression') return null
  const opacity = propertyValue(node, 'opacity')
  if (opacity) return opacitySpring(opacity)
  const spread = node.properties.find(
    (property) => property.type === 'SpreadElement' && opacitySpring(property.argument)
  )
  if (spread) return opacitySpring(spread.argument)
  const type = propertyValue(node, 'type')
  return type?.type === 'Literal' && type.value === 'spring' ? "type: 'spring'" : null
}

/**
 * The spring an element puts on `opacity`, or null. Each animating target that
 * names `opacity` is governed by its own `transition:` key when it has one, and
 * by the element's `transition` prop otherwise.
 */
function springOnOpacity(node) {
  const elementTransition = node.attributes
    .filter((attribute) => attribute.type === 'JSXAttribute')
    .find((attribute) => attribute.name.name === 'transition')
  const fallback = elementTransition ? attributeExpression(elementTransition) : null
  for (const attribute of node.attributes) {
    if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier') continue
    if (!MOTION_ANIMATING_PROPS.has(attribute.name.name)) continue
    const target = attributeExpression(attribute)
    if (target?.type !== 'ObjectExpression' || !propertyValue(target, 'opacity')) continue
    const spring = opacitySpring(propertyValue(target, 'transition') ?? fallback)
    if (spring) return spring
  }
  return null
}

/** One finding per element, on its opening tag, like the layout-key check. */
function checkSpringOpacity(context, node) {
  const spring = springOnOpacity(node)
  if (spring) context.report({ node, messageId: 'springOpacity', data: { spring } })
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Ban transition-all, ease-linear/ease-in/ease-in-out, animate-pulse, transitions and motion targets of layout properties, springs on opacity, and literal durations and delays, which are outside the GRID motion vocabulary',
    },
    schema: [],
    messages: {
      transitionAll:
        '`{{utility}}` transitions every animatable property, including ones this component never chose to animate — that is where surprise shadow/background/size moves come from. Name the properties instead: transition-colors, transition-opacity, transition-transform.',
      easeLinear:
        '`{{utility}}` moves at constant speed from a standstill, which reads as mechanical rather than physical. Use `ease-out` (`--ease-out`) for responses, `ease-entrance` for arrivals, `ease-exit` for dismissals, or `ease-cycle` for something that genuinely loops.',
      layoutTransition:
        '`{{utility}}` animates a LAYOUT property, so the browser re-runs layout for the subtree on every frame instead of compositing. Use transform/scale/translate for size and position, or a grid-template-rows 0fr→1fr transition for an accordion height.',
      literalDuration:
        '`{{utility}}` is a literal duration outside the motion scale. Use the token for the job: `duration-snap` (120ms — press, checkbox, dense-row hover), `duration-quick` (180ms — the default: colour, opacity, small transforms), `duration-base` (240ms — content entrance, popover, accordion), `duration-deliberate` (320ms — the ceiling: sheet, drawer, panel), or `duration-ambient` for indeterminate loops.',
      arbitraryAnimationTiming:
        '`{{utility}}` writes an animation timing by hand. A stagger that belongs to a primitive lives in its `@utility` and derives from `--motion-ambient` (see `animate-typing-dot`); a delayed entrance takes its timing from a motion token.',
      animatePulse:
        "`{{utility}}` is Tailwind's 2s pulse, a loop off the motion scale. Loops run on `--motion-ambient` and `--ease-cycle`: use `animate-caret-breathe` for a live mark, or the skeleton shimmer for loading.",
      offVocabularyEasing:
        '`{{utility}}` is outside the easing vocabulary. Use `ease-out` for responses, `ease-entrance` for arrivals, `ease-exit` for dismissals, or `ease-cycle` for a loop.',
      motionLayoutKey:
        '{{keys}} in a motion `initial`/`animate`/`exit` animates a LAYOUT property from JS, re-running layout every frame. Animate opacity/transform. A height arrival or fold at or below the reading point, through the shared arrival primitive, is the one sanctioned case: mark the element with `// eslint-disable-next-line grid/motion-vocabulary -- <why>` above its opening tag.',
      springOpacity:
        '`{{spring}}` drives `opacity` here, and opacity never springs: the fade lasts as long as the spring takes to settle (~500ms on springSnap) and survives reduced motion, which drops only transforms. Spring the transform and tween the opacity — `useIconSwapTransition()` / `iconSwapTransition` from the motion kit, or the spring spread with `opacity: motionQuick` through `useMotionToken`.',
    },
  },

  create(context) {
    return {
      JSXOpeningElement(node) {
        checkMotionElement(context, node)
        checkSpringOpacity(context, node)
      },
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
