/**
 * Client helper: build an async `authToken` provider for WorkOS widgets.
 *
 * WorkOS widgets accept `authToken: () => Promise<string>` and call it to fetch
 * (and later refresh) their token. We back that with `/api/widgets/token`,
 * which mints a token scoped to the signed-in user + organization and only
 * grants the requested widget scopes the caller actually holds.
 */

/**
 * Returns a function that fetches a fresh widget token for the given scopes.
 * `org: 'platform'` mints against the GRID Platform organization instead of
 * the session's active org (platform owner only — the route enforces it).
 */
export function makeWidgetTokenFetcher(scopes: string[] = [], org?: 'platform'): () => Promise<string> {
  const params = scopes.map((s) => `scope=${encodeURIComponent(s)}`)
  if (org) params.push(`org=${org}`)
  const query = params.join('&')
  const url = query ? `/api/widgets/token?${query}` : '/api/widgets/token'

  return async () => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) {
      throw new Error(`Failed to load widget token (${res.status})`)
    }
    const data = (await res.json()) as { token?: string }
    if (!data.token) {
      throw new Error('Widget token missing from response')
    }
    return data.token
  }
}
