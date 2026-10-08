/**
 * A project's Papierkorb (ADR-0085): the deleted folders the reader may read,
 * who deleted each and when, when its purge runs, and what the reader may do
 * about it. Thin handler; `@/lib/projects/folder-bin` decides.
 */

import { apiRoute } from '@/lib/api/handler'
import { listFolderBin } from '@/lib/projects/folder-bin'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => listFolderBin(session, params.id), {
  authz: { enforcedBy: 'listFolderBin (project:view; each entry only when its folder is readable)' },
})
