/**
 * The scrim that lets the transcript pass under the floating composer
 * instead of stopping at an edge. One component, so the product's chat column
 * (`MainLayout`) and the /dev routes that rebuild it draw the same edge: the
 * stream harness had neither, and recordings of it showed an edge the product
 * only half had.
 *
 * The floor scrim, behind the composer: without it the last message stopped
 * at a hard edge exactly where the composer's own surface began, two opaque,
 * same-width, same-radius panels stacked flush, reading as one collided block
 * rather than a transcript with an input floating over it. It dissolves the
 * column into the composer's glass. Taller than the top scrim (h-40 vs h-24):
 * the composer is a multi-line card, not a slim pill row.
 *
 * There is no second fade above the composer. One was tried (2026-10): solid
 * `background` across the whole column just above the card, it cut the answer
 * card flat in a hard horizontal line, and below that line the transcript
 * showed again beside the narrower composer, so a callout's red rule surfaced
 * next to the input as a stray mark. The floor scrim alone is the edge.
 */
export function ComposerScrim() {
  return (
    <div
      aria-hidden="true"
      data-testid="composer-floor-scrim"
      className="from-background pointer-events-none absolute inset-x-0 bottom-0 z-10 h-40 bg-gradient-to-t from-[2.5rem] to-transparent"
    />
  )
}
