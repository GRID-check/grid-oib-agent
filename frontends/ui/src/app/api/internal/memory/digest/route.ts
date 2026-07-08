import { NextResponse } from 'next/server'
import { requireInternalToken } from '@/lib/internal-auth'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'

/**
 * INTERNAL service endpoint — the per-turn READ path for the agent's core
 * memory digest. The digest is normally injected as the `x-grid-project-memory`
 * header on the WebSocket upgrade, but that header is frozen for the life of the
 * connection: memory written mid-session (the `remember` tool and the async
 * reflection stage) would not reach the agent until a reconnect. The backend
 * calls this route at the start of each turn to serve the CURRENT digest.
 *
 * Server-authoritative (the client never supplies memory text) and token-guarded
 * exactly like `POST /api/internal/memory`. Tenancy is derived the same way as
 * the WS-scope route: `buildProjectMemoryDigest` pins the project branch to the
 * organization when both are known, so a foreign projectId cannot surface
 * another tenant's memory.
 */

export async function GET(request: Request): Promise<Response> {
  const denied = requireInternalToken(request, 'Internal Memory Digest API')
  if (denied) return denied

  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId') || undefined
    const organizationId = searchParams.get('organizationId') || undefined

    if (!projectId && !organizationId) {
      return NextResponse.json({ error: 'projectId or organizationId is required' }, { status: 400 })
    }

    const digest = await buildProjectMemoryDigest(projectId, organizationId)
    // `digest` is null when there is no active memory — a valid empty result,
    // not an error. The backend treats null as "no memory this turn".
    return NextResponse.json({ digest }, { status: 200 })
  } catch (error) {
    console.error('[Internal Memory Digest API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
