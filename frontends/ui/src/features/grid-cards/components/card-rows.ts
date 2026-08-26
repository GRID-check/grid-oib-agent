/**
 * The expandable row four cards are built out of.
 *
 * `ConditionTreeCard` (a branch), `ProcessMapCard` (a step),
 * `DocumentChecklistCard` (a document) and `ChangeImpactCard` (an impact) each
 * render a stack of full-width `CollapsibleTrigger`s, and each carried its own
 * byte-identical copy of the class list. That is fine until the row has to
 * change for a reason none of the four files is about — which is what a touch
 * floor is — and then it is the same edit four times with nothing holding the
 * copies together afterwards.
 */

/**
 * A row in a card's expandable list.
 *
 * ## Why the touch size is PADDING and not `touch-target`
 *
 * These rows stack directly on one another, ~33px apart before this. The
 * `touch-target` utility centres a 44px catchment on the control and lets it
 * overhang, which is exactly right for a control with space around it and
 * exactly wrong here: two neighbouring rows' catchments would overlap by ~11px,
 * and in the overlap the later row in the DOM takes the tap. A reader pressing
 * the bottom of "GK 4" would open "GK 5" — a small target replaced by a
 * confidently wrong one, which is the worse failure of the two.
 *
 * So the row GROWS. `py-3` on a coarse pointer takes it to ~45px, the rows stay
 * disjoint boxes, and whichever one you press is the one that opens. The list
 * gets taller on a phone, which is the honest trade: it is a list of things you
 * are meant to press.
 */
export const CARD_LIST_ROW =
  'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left pointer-coarse:py-3'

/**
 * The quiet "back to the case that applies" link inside an expanded row.
 *
 * Underlined caption-sized text on the card's own line, so real padding would
 * push the notice it sits in out of shape; `touch-target` is the right tool
 * because this one DOES have room around it — it is the only control on its
 * line, and the row above and below hold prose, not targets.
 */
export const CARD_ROW_BACK_LINK =
  'shrink-0 rounded font-medium text-primary underline underline-offset-2 touch-target'
