/**
 * Deactivate the overlay on any navigation that is not an overlay route.
 *
 * Without this, a slot that became active (the reader opened the Archiv sheet)
 * would keep its last content when they then NAVIGATE somewhere instead of
 * closing — Next keeps a parallel slot's state across soft navigations unless
 * a more specific match takes over. The catch-all is that match: any
 * non-overlay URL renders the overlay as nothing.
 */
export default function OverlayCatchAll(): null {
  return null
}
