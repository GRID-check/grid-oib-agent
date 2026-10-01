/**
 * The folder one delivery is filed into: `E-Mail-Eingang/<leaf>`, and when a
 * folder of that name is already there (another mail from the same sender in
 * the same minute, or one a person made), `<leaf> (2)`, `<leaf> (3)` …
 *
 * Called once per delivery, by its first filing attempt; the drain records the
 * id on the row and every later attempt reuses it (`./drain`). So the numbering
 * is decided once and a retry never opens a second folder for the same mail.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  createProjectFolder,
  getOrCreateProjectFolderByName,
  listProjectFolders,
} from '@/lib/projects/folder-service'
import { INBOUND_MAIL_ROOT_FOLDER } from './folder-name'

/** Rounds of "read the taken names, create the first free one" before giving up on a race. */
const CREATE_ROUNDS = 3

/** The first of `leaf`, `leaf (2)`, `leaf (3)` … that no sibling has. */
export function firstFreeFolderName(leaf: string, taken: ReadonlySet<string>): string {
  if (!taken.has(leaf)) return leaf
  for (let n = 2; ; n += 1) {
    const candidate = `${leaf} (${n})`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Create the delivery's folder and return its id. Authorizes the sender first
 * (the same any-of `uploadDocument` asks for): the root folder is created by a
 * resolver that trusts its caller to have done so. Throws without the folder's
 * name in the message: the name carries the sender's.
 */
export async function createMailFolder(
  session: AuthorizedSession,
  projectId: string,
  leaf: string
): Promise<string> {
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'], { onError: 'throw' })
  const root = await getOrCreateProjectFolderByName(projectId, INBOUND_MAIL_ROOT_FOLDER)
  for (let round = 0; round < CREATE_ROUNDS; round += 1) {
    const siblings = (await listProjectFolders(projectId, session)).filter((folder) => folder.parentId === root.id)
    const name = firstFreeFolderName(leaf, new Set(siblings.map((folder) => folder.name)))
    const created = await createProjectFolder({ projectId, parentId: root.id, name }, session)
    if (created.ok) return created.folder.id
  }
  throw new Error('[inbound-mail] the mail folder could not be created')
}
