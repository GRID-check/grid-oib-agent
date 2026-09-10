/**
 * INTERNAL service endpoint — the agent's half of the one mounts endpoint
 * (ADR-0054, spec MT-2, MT-3, MT-12).
 *
 * `open_project` calls this over the compose network with the shared service
 * token. It is a TWIN of `POST /api/conversations/:id/mounts`, not a second
 * implementation: the same service, the same permission, the same cap, the same
 * body — MT-2 exists so that there is exactly one place a mount is authorized,
 * and two adapters with two rules would be that place twice.
 *
 * ## It authorizes as the USER, never as the service
 *
 * The token proves the caller is the backend; it says nothing about the person
 * whose turn is running. So the identity comes from the request — the same
 * `organizationId` / `userId` / `organizationMembershipId` the turn's signed
 * context envelope carries — and every check runs against that reconstructed
 * caller (`sessionForInternalMount`). Mounting on the service's own authority
 * would make "open project X" a read for anyone who can get that sentence into
 * a prompt (spec MT-3, MT-4).
 *
 * The membership id is the load-bearing field: WorkOS FGA keys on it, so
 * without it there is no per-project decision to make and the request is
 * refused rather than widened.
 *
 * It accepts a **Sammlung** on the same terms as the session route (spec GR-2):
 * `projectSetId` instead of `projectId`, expanded to the same mount rows
 * through the same service, so the agent opening "Bezirk 3" and a person
 * clicking it cannot diverge either.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import {
  mountProject,
  mountProjectSet,
  sessionForInternalMount,
  WorkspaceMountCapError,
  WorkspaceMountExclusionError,
} from '@/lib/workspace/mounts-service'
import {
  exactlyOneMountTarget,
  mountCapResponse,
  mountExclusionResponse,
  mountResponse,
  mountSetResponse,
  MOUNT_TARGET_MESSAGE,
  MOUNT_TARGET_SHAPE,
} from '@/lib/workspace/mount-wire'

type Params = { id: string }

const internalMountSchema = z
  .object({
    ...MOUNT_TARGET_SHAPE,
    organizationId: z.string().min(1),
    userId: z.string().min(1),
    /** The (user, organization) pair WorkOS FGA keys on. Required, see above. */
    organizationMembershipId: z.string().min(1),
    /**
     * Only the agent reaches this route, and the column it writes is what tells a
     * reader who widened the conversation's scope (MT-5, MT-12). A literal rather
     * than the actor enum: a caller that could claim `user` here would be able to
     * attribute its own mount to a person.
     */
    mountedBy: z.literal('agent'),
  })
  .refine(exactlyOneMountTarget, { message: MOUNT_TARGET_MESSAGE })

export const POST = internalApiRoute<Params>(
  'Internal Conversation Mounts',
  async ({ request, params }) => {
    const body = await parseJsonBody(request, internalMountSchema)

    return withTenant({ organizationId: body.organizationId, userId: body.userId }, async () => {
      const session = await sessionForInternalMount({
        organizationId: body.organizationId,
        userId: body.userId,
        organizationMembershipId: body.organizationMembershipId,
      })
      try {
        if (body.projectSetId) {
          return mountSetResponse(
            await mountProjectSet({
              session,
              conversationId: params.id,
              projectSetId: body.projectSetId,
              mountedBy: body.mountedBy,
            })
          )
        }
        return mountResponse(
          await mountProject({
            session,
            conversationId: params.id,
            projectId: body.projectId as string,
            mountedBy: body.mountedBy,
          })
        )
      } catch (error) {
        if (error instanceof WorkspaceMountCapError) return mountCapResponse(error)
        if (error instanceof WorkspaceMountExclusionError) return mountExclusionResponse(error)
        throw error
      }
    })
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
