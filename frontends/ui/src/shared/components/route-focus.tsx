'use client'

import { useRouteFocus } from '@/shared/hooks/use-route-focus'

/**
 * Client boundary that runs {@link useRouteFocus}. Rendered inside the project
 * layout's `<main id="main-content">` so it can move focus to that landmark on
 * client-side navigation between project sections. Renders nothing.
 */
export function RouteFocus(): null {
  useRouteFocus()
  return null
}
