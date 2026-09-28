/**
 * Counts mounted Radix `Popover` roots, for specs that pin WHEN a peek pays for
 * its popover.
 *
 * A closed Radix popover renders no DOM at all, so "no popover until engaged"
 * cannot be read off the document. Wire it in with
 *
 *   vi.mock('@/components/ui/popover', async (importOriginal) =>
 *     (await import('@/test-utils/popover-mounts')).countPopoverMounts(await importOriginal())
 *   )
 *
 * and read `popoverMounts.current` (mounted now) or `.total` (ever mounted).
 */

import { useEffect, type ComponentProps } from 'react'
import type * as PopoverModule from '@/components/ui/popover'

export const popoverMounts = { current: 0, total: 0 }

export const resetPopoverMounts = (): void => {
  popoverMounts.current = 0
  popoverMounts.total = 0
}

export const countPopoverMounts = (actual: typeof PopoverModule): typeof PopoverModule => {
  const Popover = (props: ComponentProps<typeof actual.Popover>) => {
    useEffect(() => {
      popoverMounts.current += 1
      popoverMounts.total += 1
      return () => {
        popoverMounts.current -= 1
      }
    }, [])
    return <actual.Popover {...props} />
  }
  return { ...actual, Popover }
}
