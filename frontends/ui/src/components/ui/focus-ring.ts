/**
 * Focus ring — the two recipes, written once.
 *
 * A keyboard ring that changes alpha, offset and trigger (`focus:` vs
 * `focus-visible:`) from control to control is not a style choice, it is noise:
 * the reader has to re-learn "where am I?" on every widget, and one of the
 * variants (`focus:`) fires on a MOUSE CLICK, which teaches them the ring means
 * nothing. So there are exactly two, and every interactive primitive in
 * `components/ui` composes one of them rather than hand-rolling a third.
 *
 * The ring is the Piloti green (`--ring` resolves to `--brand`) — see
 * `docs/design/grid-design-language.md` ("the accent marks what is live or
 * chosen"). It is deliberately NOT the action colour: a button is ink, and the
 * ring around it is green, so "where am I" and "what does this do" are answered
 * by two different signals instead of one doing both jobs badly. Never blue —
 * blue belongs to the Baurecht provenance signal.
 */

/**
 * **Interactive controls** — buttons, chips, toggles, tabs, badges, menu
 * triggers, close buttons, drag handles.
 *
 * A 2px ink ring held off the control by a 2px background-coloured gap, so it
 * reads on a filled (near-black) button as clearly as on a ghost one. `/60`
 * because a full-strength ink ring on a dense toolbar reads as a second border.
 */
export const FOCUS_RING =
  'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background'

/**
 * **Interactive controls that sit inside a clipping container** — list rows in
 * `ItemList`, which is `overflow-hidden`, so an offset ring on the first or last
 * row would be sliced off by the container's own rounded edge and the reader
 * would see three sides of a rectangle. Same ring, drawn inside the row's box.
 */
export const FOCUS_RING_INSET = 'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset'

/**
 * **Fields** — `Input`, `Textarea`, `Select` trigger, and anything else that is
 * a typing surface.
 *
 * THE DOCUMENTED EXCEPTION to {@link FOCUS_RING}, and deliberate: a field
 * already carries a visible border at rest, so focus is signalled by promoting
 * that border to `--ring` and backing it with a soft halo — the border moves,
 * rather than a second ring appearing outside it. An offset gap would detach the
 * halo from the border and make a focused field look like a focused *button*,
 * and fields are frequently packed one under another where a 2px outer gap
 * visibly reflows nothing but still crowds the neighbour. Hence `/20` (halo, not
 * outline) and `ring-offset-0`.
 */
export const FIELD_FOCUS_RING =
  'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:ring-offset-0'
