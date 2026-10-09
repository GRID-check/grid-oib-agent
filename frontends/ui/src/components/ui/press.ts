/**
 * The press — how a small control gives way under a click, written once.
 *
 * `Button` and `TabsTrigger` already dip to 0.98 on `--motion-snap` (the press
 * half of `springPress`, see the comment in `button.tsx`). The hand-rolled
 * controls around an answer had drifted to four scales (0.95, 0.98, 0.99,
 * 0.88) on two durations, so a citation chip, the copy link beside it and the
 * card row under it each answered the same click differently. This is that one
 * press for anything that is not a `Button`: the same scale, the same split of
 * durations (colour on `--motion-quick`, the transform on `--motion-snap`), and
 * the same reduced-motion escape.
 *
 * The transition list names `filter` and `border-color` as well as colour,
 * background and transform: a chip's hover is a brightness step and a card's
 * lifecycle accent is a border colour, and a property missing from the list
 * changes in one frame while its neighbours ease.
 *
 * Compose it with {@link FOCUS_RING} (`components/ui/focus-ring`), the one
 * keyboard ring, and `outline-none`.
 */
export const PRESSABLE =
  'transition-[color,background-color,border-color,filter,transform] ' +
  '[transition-duration:var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-snap)] ' +
  'ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
