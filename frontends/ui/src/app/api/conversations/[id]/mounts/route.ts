/**
 * The mounted projects of a Büro conversation — the session-authenticated half
 * of the one mounts endpoint (ADR-0054, spec MT-2, MT-5, MT-11).
 *
 * `GET` is what the "Im Blick" chip row and the scope tree read; `POST` is what
 * a person's "Projekt einblenden" does, and what the `?mount=` deep link from a
 * project chat runs once (MT-16 — a link is not a way to widen scope, so it
 * takes exactly this path).
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
  WorkspaceMountCapError,
  WorkspaceMountExclusionError,
} from '@/lib/workspace/mounts-service'
import {
  mountCapResponse,
  mountExclusionResponse,
  mountResponse,
} from '@/lib/workspace/mount-wire'

type Params = { id: string }

const mountSchema = z.object({
  projectId: z.string().uuid(),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => listMounts(session, params.id),
  {
    authz: {
      enforcedBy:
        'listMounts (requireResourceAccess conversation viewer — the mounted set is a ' +
        'property of the conversation, spec MT-14)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { projectId } = await parseJsonBody(request, mountSchema)
    try {
      return mountResponse(
        await mountProject({
          session,
          conversationId: params.id,
          projectId,
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
        'mountProject (requireResourceAccess conversation collaborator + ' +
        'requireProjectAccess project:chat; createConversation checks org:chat when the ' +
        'conversation does not exist yet)',
    },
  }
)
