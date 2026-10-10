/**
 * POST /api/projects/{id}/experience — the closing extraction
 * (docs/design/closed-project-experience.md): the project's own documents are
 * read once and what they say comes back as suggestions a person confirms. A
 * thin adapter; the service owns the access check, which refuses a closed
 * project.
 */

import { apiRoute } from '@/lib/api/handler'
import { extractProjectExperience } from '@/lib/project-experience/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => extractProjectExperience(session, params.id),
  { authz: { enforcedBy: 'extractProjectExperience (requireProjectAccess project:memory:write or project:edit)' } }
)
