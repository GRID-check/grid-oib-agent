/**
 * The inbox badge's one read (`GET /api/inbox/summary`), answered in the
 * browser, for the shell previews (`/dev/app-rail`, `/dev/app-shell-scopes`):
 * without it the rail, the header and the tab bar draw their inbox entry with
 * no count, which is the one state the badge exists not to be in.
 *
 * Call it at MODULE scope (React runs a child's effects before its parent's,
 * so a component effect would install it after the badge has already asked).
 * Development and browser only, and installed once however often it is called.
 */
export function installInboxBadgeFake(pending: number): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as { __inboxBadgeFake?: boolean }
  if (w.__inboxBadgeFake) return
  w.__inboxBadgeFake = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (new URL(url, window.location.origin).pathname === '/api/inbox/summary') return Response.json({ pending })
    return real(input, init)
  }
}
