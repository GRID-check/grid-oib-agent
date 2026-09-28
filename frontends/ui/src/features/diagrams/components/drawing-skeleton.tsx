import { Skeleton } from '@/components/ui/skeleton'

/**
 * A drawing's space while mermaid lays the graph out — one component for the
 * fence and the `diagram` card, because the two surfaces that draw the same
 * mermaid must wait the same way (Jakob's law inside one product).
 *
 * Three bars and not a spinner, and not the source either. The shape the reader
 * is waiting for is a graph, so a single grey block reads as an image that
 * failed; and swapping a fifteen-line code block for a picture is a bigger jump
 * than growing a placeholder.
 *
 * The height is representative, not a reservation: a mermaid drawing's height
 * is unknown until the graph is laid out, so the figure does resize when the
 * SVG lands. What the fixed height buys is that it is not a thin sliver first —
 * a 20px placeholder growing to a 600px sequence diagram moves everything below
 * it much further than a 132px one does. Nothing animates it: the design
 * language forbids animating height, and this changes in one paint.
 */
export function DrawingSkeleton() {
  return (
    <div className="flex h-[132px] flex-col justify-center gap-3" aria-hidden="true">
      <Skeleton className="h-4 w-2/5 rounded-md" />
      <Skeleton className="h-4 w-3/5 rounded-md" />
      <Skeleton className="h-4 w-1/3 rounded-md" />
    </div>
  )
}
