/**
 * The mounted projects of a Büro conversation — the session-authenticated half
 * of the one mounts endpoint (ADR-0054, spec MT-2, MT-5, MT-11).
 *
 * `GET` is what the "Im Blick" chip row and the scope tree read; `POST` is what
 * a person's "Projekt einblenden" does, and what the `?mount=` deep link from a
 * project chat runs once (MT-16 — a link is not a way to widen scope, so it
 * takes exactly this path).
 *
 * `POST` takes EITHER a project or a **Sammlung** (spec GR-2). A set is not a
 * second mechanism: it expands to the same mount rows, through the same
 * service, against the same cap — so this stayed one endpoint rather than
 * becoming two, and MT-2's "one place a mount is authorized" keeps meaning what
 * it meant.
 *
 * Thin adapters. Every decision — the conversation role, `project:chat`, the
 * cap, idempotence, the grant — belongs to `lib/workspace/mounts-service`,
 * which the internal twin at `api/internal/conversations/[id]/mounts` also
 * calls, so the agent's mount and the person's mount cannot diverge.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import {
  listMounts,
  mountProject,
  mountProjectSet,
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

const mountSchema = z
  .object(MOUNT_TARGET_SHAPE)
  .refine(exactlyOneMountTarget, { message: MOUNT_TARGET_MESSAGE })

export const GET = apiRoute<Params>(async ({ session, params }) => listMounts(session, params.id), {
  authz: {
    enforcedBy:
      'listMounts (requireResourceAccess conversation viewer — the mounted set is a ' +
      'property of the conversation, spec MT-14)',
  },
})

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { projectId, projectSetId } = await parseJsonBody(request, mountSchema)
    try {
      if (projectSetId) {
        return mountSetResponse(
          await mountProjectSet({
            session,
            conversationId: params.id,
            projectSetId,
            mountedBy: 'user',
          })
        )
      }
      return mountResponse(
        await mountProject({
          session,
          conversationId: params.id,
          projectId: projectId as string,
          mountedBy: 'user',
        })
      )
    } catch (error) {
      // The two refusals with a body of their own: the UI disables its add row
      // with the reason visible, and the same facts reach the agent through the
      // internal twin. Everything else takes the shared error envelope.
      if (error instanceof WorkspaceMountCapError) return mountCapResponse(error)
      if (error instanceof WorkspaceMountExclusionError) return mountExclusionResponse(error)
      throw error
    }
  },
  {
    authz: {
      enforcedBy:
        'mountProject / mountProjectSet (requireResourceAccess conversation collaborator + ' +
        'requireProjectAccess project:chat per project; createConversation checks org:chat ' +
        'when the conversation does not exist yet; a Sammlung additionally goes through ' +
        'projectSetForMount, which checks org:chat and resolves the set inside the org)',
    },
  }
)
