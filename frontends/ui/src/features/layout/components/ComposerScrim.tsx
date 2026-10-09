/**
 * The two scrims that let the transcript pass under the floating composer
 * instead of stopping at an edge. One component, so the product's chat column
 * (`MainLayout`) and the /dev routes that rebuild it draw the same thing: the
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
 * The fade ABOVE the composer: the floor scrim resolves under the composer's
 * card (the stack is 140–190 px tall, the scrim 160), so an answer still
 * writing slid under the card's top edge with every line cut flat (recording
 * 2026-10). This one sits on the stack's top, read from `--composer-h`: solid
 * through the stack's top padding, where the text would otherwise show
 * unveiled above the card, then 2rem to transparent. Under the jump button and
 * the status dock (`ChatArea`'s `z-10`), which sit in that band and must stay
 * whole and clickable, and over the thread. Not drawn on the empty canvas,
 * where the composer is lifted off the floor and there is no transcript, nor
 * where the reader asked for contrast or the system's colours: a veil over
 * text is the one thing those settings exist to take away.
 */
export function ComposerScrim({ threadEmpty }: { threadEmpty: boolean }) {
  return (
    <>
      <div
        aria-hidden="true"
        className="from-background pointer-events-none absolute inset-x-0 bottom-0 z-10 h-40 bg-gradient-to-t from-[2.5rem] to-transparent"
      />
      {!threadEmpty && (
        <div
          aria-hidden="true"
          data-testid="composer-fade"
          className="from-background pointer-events-none absolute inset-x-0 z-[5] h-12 bg-gradient-to-t from-[1rem] to-transparent contrast-more:hidden forced-colors:hidden"
          style={{ bottom: 'calc(var(--composer-h, 11rem) - 1rem)' }}
        />
      )}
    </>
  )
}
