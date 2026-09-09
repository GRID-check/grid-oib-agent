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
  assertAgentMayWriteOrgMemory,
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
  organizationExists,
} from '@/lib/projects/memory-service'
import { PROJECT_MEMORY_CONFIDENCES, PROJECT_MEMORY_KINDS } from '@/lib/db/schema'

// The DEPLOYMENT half of the org-memory gate, kept as an off-switch BELOW the
// permission (audit finding S1): an org item lands in every project's digest
// across the tenant, so an operator who wants no agent-authored org memory at
// all in this deployment has a lever that does not depend on how WorkOS roles
// are provisioned.
//
// The AUTHORIZATION half is `assertAgentMayWriteOrgMemory`, which resolves the
// ACTING user from the envelope and asks whether they hold `org:memory:write`
// (spec AG-8). Both refuse with the same `ORG_MEMORY_DISABLED` code, because to
// the agent both are "policy says no" and both degrade into the proposal card
// the user can accept (spec AG-9).
function agentOrgMemoryAllowed(): boolean {
  return (process.env.GRID_ALLOW_AGENT_ORG_MEMORY ?? '').toLowerCase() === 'true'
}

const internalMemorySchema = z
  .object({
    scope: z.enum(['project', 'organization']).default('project'),
    projectId: z.string().uuid().optional(),
    organizationId: z.string().min(1).optional(),
    /**
     * WHO the turn runs for, straight from its signed context envelope. Read
     * only on the organization-scoped branch, where the write is authorized as
     * that person rather than as the service token (spec AG-8).
     *
     * Optional because a project-scoped write is addressed by a project row and
     * needs no acting user, and because an envelope that carries no membership
     * id must REFUSE the org write rather than fail to parse — a 400 would make
     * the agent report a malformed request where the honest outcome is "you may
     * not do that here", which it degrades into a proposal card (spec AG-9).
     */
    userId: z.string().min(1).optional(),
    organizationMembershipId: z.string().min(1).optional(),
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
    /**
     * Write-time importance in [0,1], elicited by the reflection stage
     * (Generative-Agents-style poignancy, mapped from 1-10). Optional: the
     * column's 0.5 default is the neutral midpoint for callers that do not
     * rate. Read by the recall scorer (`lib/knowledge/recall-scoring.ts`).
     */
    salience: z.number().min(0).max(1).optional(),
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
      organizationMembershipId,
      kind,
      content,
      confidence,
      provenanceType,
      sourceConversationId,
      supersedesContent,
      salience,
    } = await parseJsonBody(request, internalMemorySchema)

    // An organization-scoped write always names its tenant. A project-scoped
    // one may not: the project row is what names it, and
    // `createProjectMemoryItemForProject` resolves the branch from it.
    return withOptionalTenant(
      organizationId,
      'project-scoped agent memory addressed by project id; the project row names the tenant',
      async () => {
        if (scope === 'organization') {
          // THE PERMISSION IS ASKED FIRST, and it is asked ALWAYS (ADR-0055).
          //
          // It used to be asked second, behind the deployment off-switch, which
          // defaults to off — so in every ordinary deployment the refusal that
          // actually reached a person said the feature was switched off, when
          // the truth about them was that their role does not hold
          // `org:memory:write`. A permission denial reported as a service state
          // is the wrong sentence in both directions: it tells someone who
          // could be granted the right that there is nothing to grant, and it
          // tells an administrator who did switch the feature on nothing about
          // why it still refuses. The message below is a statement about the
          // acting user, and it is the one a holder of the permission never
          // sees.
          //
          // The code stays ORG_MEMORY_DISABLED for both refusals: the Python
          // side's proposal-card branch keys on it, and the agent's one honest
          // answer to either is the same card (spec AG-8, AG-9).
          await assertAgentMayWriteOrgMemory({
            organizationId: organizationId as string,
            organizationMembershipId,
          })
          // Then the deployment off-switch, which is an operator's statement
          // about this deployment and says so. Second because it can only be
          // reached by someone the permission already allowed, which is exactly
          // when "the administrator turned this off here" is the true and
          // complete answer.
          if (!agentOrgMemoryAllowed()) {
            console.warn(
              '[Internal Memory API] Rejected agent org-scoped write (GRID_ALLOW_AGENT_ORG_MEMORY not set)'
            )
            // Distinct ORG_MEMORY_DISABLED code (not a bare FORBIDDEN) so the backend
            // reports the accurate cause instead of mislabeling it a token mismatch.
            throw new OrgMemoryDisabledError(
              'Agent organization-scoped memory is switched off in this deployment'
            )
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
        //
        // The retired entry's own words travel back beside its id, because the
        // caller renders them (ADR-0055: a supersession is a STATED event in the
        // transcript, and "Piloti replaced a note" without the two sentences is a
        // report nobody can check). This is the one moment they cost nothing —
        // the service has the row loaded — and the one moment they are certainly
        // right: the caller's `supersedesContent` is a QUOTE that was resolved
        // fuzzily, and in the polarity case there is no quote at all.
        const outcome: { supersededId: string | null; supersededContent: string | null } = {
          supersededId: null,
          supersededContent: null,
        }
        const writeOptions = {
          supersedesContent,
          onSuperseded: (superseded: { id: string; content: string }) => {
            outcome.supersededId = superseded.id
            outcome.supersededContent = superseded.content
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
                  ...(salience !== undefined ? { salience } : {}),
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
                  ...(salience !== undefined ? { salience } : {}),
                },
                writeOptions
              )

        if (!item) {
          throw new NotFoundError('Unknown project')
        }

        // `supersededId` is null when the quote resolved to nothing, or to an entry
        // the agent may not retire — the caller can then be honest about what it did.
        // `supersededContent` is null in exactly the same cases and never in any
        // other: the two are set together or not at all, so a caller may treat a
        // present id with an absent content as a version skew rather than a fact.
        return { item, supersededId: outcome.supersededId, supersededContent: outcome.supersededContent }
      }
    )
  },
  { status: 201, tenancy: { fromPayload: 'body.organizationId, else the project row' } }
)
