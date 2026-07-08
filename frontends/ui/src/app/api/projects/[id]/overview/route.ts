import { apiRoute } from '@/lib/api/handler'
import { getProjectOverview } from '@/lib/projects/service'

export const GET = apiRoute<{ id: string }>(async ({ session, params }) =>
  getProjectOverview(session, params.id),
)
