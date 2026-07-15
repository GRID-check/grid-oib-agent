/**
 * Singleton WorkOS Node SDK client.
 *
 * The runtime API key is required for server-side calls to WorkOS (organizations,
 * user management, FGA, etc.).
 */

import { WorkOS } from '@workos-inc/node'

let workos: WorkOS | null = null

export function getWorkOS(): WorkOS {
  if (workos) {
    return workos
  }

  const apiKey = process.env.WORKOS_API_KEY

  if (!apiKey) {
    throw new Error('WORKOS_API_KEY is required')
  }

  // Bound every WorkOS API call so an unreachable WorkOS can't hang a request
  // past Cloudflare's ~100s origin timeout (→ 504). The SDK applies this as a
  // per-request fetch timeout in ms (its own default is 60s); tighten it so a
  // stalled auth/organization call fails fast into the caller's error path.
  workos = new WorkOS(apiKey, { timeout: 30_000 })

  return workos
}
