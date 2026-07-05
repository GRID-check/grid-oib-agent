import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
  organizationExists,
} from '@/lib/projects/memory-service'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
} from '@/lib/db/schema'

/**
 * INTERNAL service endpoint — the write path for the backend agent's
 * `remember` tool. Keeps grid_app single-writer: the Python backend never
 * touches the database; it calls this route over the compose network,
 * authenticated by a shared service token (GRID_INTERNAL_API_TOKEN on both
 * services). Not user-facing; requests without the token are rejected, and
 * the route fails closed when the token is unconfigured.
 */

const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

// Well-known default shipped in docker-compose for local development. It must
// never authenticate anything outside a dev environment.
const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const DEV_APP_ENVS = new Set(['development', 'dev', 'local'])

/** Constant-time token comparison; length mismatch short-circuits safely. */
function tokensMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isDevEnvironment(): boolean {
  // The frontend container does not receive APP_ENV; fall back to NODE_ENV
  // (Next.js sets it to 'production' in the built image, 'development' for
  // `next dev`). Unset means production — fail closed.
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production').toLowerCase()
  return DEV_APP_ENVS.has(env)
}

const internalMemorySchema = z
  .object({
    scope: z.enum(['project', 'organization']).default('project'),
    projectId: z.string().uuid().optional(),
    organizationId: z.string().min(1).optional(),
    kind: z.enum(PROJECT_MEMORY_KINDS),
    content: z.string().trim().min(1).max(2000),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).default('medium'),
    sourceConversationId: z.string().max(255).optional(),
  })
  .refine((v) => (v.scope === 'project' ? !!v.projectId : !!v.organizationId), {
    message: 'project scope requires projectId; organization scope requires organizationId',
  })

export async function POST(request: Request): Promise<Response> {
  const expectedToken = process.env.GRID_INTERNAL_API_TOKEN
  if (!expectedToken) {
    console.error('[Internal Memory API] GRID_INTERNAL_API_TOKEN is not configured — rejecting')
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (expectedToken === DEV_DEFAULT_TOKEN && !isDevEnvironment()) {
    console.error(
      `[Internal Memory API] GRID_INTERNAL_API_TOKEN is the well-known dev default ('${DEV_DEFAULT_TOKEN}') in a non-dev environment — refusing to serve. Set a real token in the deployment environment.`,
    )
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (!tokensMatch(request.headers.get(INTERNAL_TOKEN_HEADER), expectedToken)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = await request.json().catch(() => null)
    const parsed = internalMemorySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid memory payload.' }, { status: 400 })
    }

    const { scope, projectId, organizationId, kind, content, confidence, sourceConversationId } = parsed.data

    if (scope === 'organization') {
      // Validate the org id against known tenants. There is no organizations
      // table, so "known" means: at least one project belongs to it. This
      // blocks arbitrary-org writes from a compromised backend, though an
      // org with zero projects is also rejected (acceptable limitation).
      const known = await organizationExists(organizationId as string)
      if (!known) {
        return NextResponse.json({ error: 'Unknown organization' }, { status: 404 })
      }
    }

    const item =
      scope === 'project'
        ? await createProjectMemoryItemForProject(projectId as string, {
            kind,
            content,
            confidence,
            sourceConversationId: sourceConversationId ?? null,
            provenanceType: 'agent',
          })
        : await createProjectMemoryItem({
            scope: 'organization',
            projectId: null,
            organizationId: organizationId as string,
            kind,
            content,
            confidence,
            sourceConversationId: sourceConversationId ?? null,
            provenanceType: 'agent',
          })

    if (!item) {
      return NextResponse.json({ error: 'Unknown project' }, { status: 404 })
    }

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    console.error('[Internal Memory API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
