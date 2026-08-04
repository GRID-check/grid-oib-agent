/**
 * INTERNAL service endpoint — the write path for the backend agent's
 * `remember` tool. Keeps grid_app single-writer: the Python backend never
 * touches the database; it calls this route over the compose network,
 * authenticated by a shared service token (GRID_INTERNAL_API_TOKEN on both
 * services). Not user-facing; requests without the token are rejected, and
 * the route fails closed when the token is unconfigured (both enforced by
 * `internalApiRoute` via `@/lib/internal-auth`).
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withOptionalTenant } from '@/lib/db/tenant-context'
import { NotFoundError, OrgMemoryDisabledError } from '@/lib/api/errors'
import {
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
  organizationExists,
} from '@/lib/projects/memory-service'
import { PROJECT_MEMORY_CONFIDENCES, PROJECT_MEMORY_KINDS } from '@/lib/db/schema'

// Agent-authored org-wide memory is DENIED by default: an org item lands in
// every project's digest across the tenant, and this service-token endpoint
// cannot verify the human's org role, so an autonomous or prompt-injected write
// would be a cross-project poisoning primitive (audit finding S1). Org-wide
// findings are a deliberate, human-driven action via the org-memory panel.
// Set GRID_ALLOW_AGENT_ORG_MEMORY=true only if you accept that risk.
function agentOrgMemoryAllowed(): boolean {
  return (process.env.GRID_ALLOW_AGENT_ORG_MEMORY ?? '').toLowerCase() === 'true'
}

const internalMemorySchema = z
  .object({
    scope: z.enum(['project', 'organization']).default('project'),
    projectId: z.string().uuid().optional(),
    organizationId: z.string().min(1).optional(),
    kind: z.enum(PROJECT_MEMORY_KINDS),
    content: z.string().trim().min(1).max(2000),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).default('medium'),
    // Only agent-side provenances are accepted here; user items come via the
    // authenticated panel routes. 'distillation' = the async reflection stage.
    provenanceType: z.enum(['agent', 'distillation']).default('agent'),
    sourceConversationId: z.string().max(255).optional(),
    // Verbatim content of the entry this finding makes obsolete, quoted back
    // from the digest the agent was shown. Lets the agent CORRECT memory, not
    // just append to it — the resolved entry is marked 'superseded' and linked
    // via supersedes_id. Unresolvable quotes are ignored, and human-curated
    // entries (pinned / user-confirmed / user-authored) are never retired this
    // way (design §3.2).
    supersedesContent: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((v) => (v.scope === 'project' ? !!v.projectId : !!v.organizationId), {
    message: 'project scope requires projectId; organization scope requires organizationId',
  })

export const POST = internalApiRoute(
  'Internal Memory',
  async ({ request }) => {
    const {
      scope,
      projectId,
      organizationId,
      kind,
      content,
      confidence,
      provenanceType,
      sourceConversationId,
      supersedesContent,
    } = await parseJsonBody(request, internalMemorySchema)

    // An organization-scoped write always names its tenant. A project-scoped
    // one may not: the project row is what names it, and
    // `createProjectMemoryItemForProject` resolves the branch from it.
    return withOptionalTenant(
      organizationId,
      'project-scoped agent memory addressed by project id; the project row names the tenant',
      async () => {
        if (scope === 'organization') {
          // Default-deny agent-authored org-wide writes (audit finding S1).
          if (!agentOrgMemoryAllowed()) {
            console.warn(
              '[Internal Memory API] Rejected agent org-scoped write (GRID_ALLOW_AGENT_ORG_MEMORY not set)'
            )
            // Distinct ORG_MEMORY_DISABLED code (not a bare FORBIDDEN) so the backend
            // reports the accurate cause instead of mislabeling it a token mismatch.
            throw new OrgMemoryDisabledError('Agent organization-scoped memory is disabled')
          }
          // Validate the org id against known tenants. There is no organizations
          // table, so "known" means: at least one project belongs to it. This
          // blocks arbitrary-org writes from a compromised backend, though an
          // org with zero projects is also rejected (acceptable limitation).
          const known = await organizationExists(organizationId as string)
          if (!known) {
            throw new NotFoundError('Unknown organization')
          }
        }

        // Reported by the service, never derived from the returned row: a duplicate
        // or paraphrase refresh returns an EXISTING item whose `supersedesId` may
        // record a retirement performed by an earlier request.
        const outcome: { supersededId: string | null } = { supersededId: null }
        const writeOptions = {
          supersedesContent,
          onSuperseded: (id: string) => {
            outcome.supersededId = id
          },
        }

        const item =
          scope === 'project'
            ? await createProjectMemoryItemForProject(
                projectId as string,
                {
                  kind,
                  content,
                  confidence,
                  sourceConversationId: sourceConversationId ?? null,
                  provenanceType,
                },
                writeOptions
              )
            : await createProjectMemoryItem(
                {
                  scope: 'organization',
                  projectId: null,
                  organizationId: organizationId as string,
                  kind,
                  content,
                  confidence,
                  sourceConversationId: sourceConversationId ?? null,
                  provenanceType,
                },
                writeOptions
              )

        if (!item) {
          throw new NotFoundError('Unknown project')
        }

        // `supersededId` is null when the quote resolved to nothing, or to an entry
        // the agent may not retire — the caller can then be honest about what it did.
        return { item, supersededId: outcome.supersededId }
      }
    )
  },
  { status: 201, tenancy: { fromPayload: 'body.organizationId, else the project row' } }
)
