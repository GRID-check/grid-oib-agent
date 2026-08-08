'use client'

/**
 * An element named inside an answer, rendered as something you can open.
 *
 * When the assistant writes "die Brandwand zwischen Stiegenhaus und Wohnung 03
 * trägt kein Feuerwiderstands-Pset", the reader's next move is always the same:
 * find that wall. A chip makes that one click instead of a search — and because
 * the destination is the addressable model view, the wall arrives selected,
 * highlighted and, if the link says so, with everything else ghosted.
 *
 * The chip shows the link's own text and nothing else. It could look up the
 * element and print its area, and that is exactly what it must not do: a chip
 * that quietly disagreed with the sentence above it would be worse than no chip.
 * The numbers stay in the cards, which read them from the model.
 */

import Link from 'next/link'
import { Box } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BimElementLink } from '../lib/element-question'
import { elementLinkHref } from '../lib/element-question'

export interface IfcElementChipProps {
  link: BimElementLink
  children: ReactNode
}

export function IfcElementChip({ link, children }: IfcElementChipProps): JSX.Element {
  const view = link.view
  // What the chip promises to do, spelled out for a screen reader — "Wand W-12"
  // alone does not say that following it opens the 3D model.
  const target = view.element
    ? `Bauteil ${view.element} im Modell öffnen`
    : view.storey
      ? `Geschoss ${view.storey} im Modell öffnen`
      : 'Modell öffnen'

  return (
    <Link
      href={elementLinkHref(link)}
      title={target}
      // The app's chip vocabulary (`components/ui/chip.tsx`), not a bespoke
      // tint: `border-brand` is a static utility with no `--modifier()`, so
      // `border-brand/30` compiles to nothing and the chip would silently lose
      // its outline (`scripts/check-static-utility-modifiers.mjs` catches it).
      className="mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-md border border-transparent bg-info-subtle px-1.5 py-0.5 align-baseline text-[0.9em] text-info no-underline transition-[filter] hover:brightness-95 dark:hover:brightness-125"
    >
      <Box className="size-3 shrink-0 self-center" aria-hidden="true" />
      <span className="truncate">{children}</span>
      <span className="sr-only"> — {target}</span>
    </Link>
  )
}
