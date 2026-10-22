import 'server-only'

/**
 * What the E-Mail-Eingang's two pages read on the server, so the first paint
 * is the list (and the open mail), not a skeleton waiting for the bundle.
 *
 * The gate is the feature's own (`requireMailReviewer`): the office's
 * `inbound-mail` entitlement, then `project:documents:write`. Every refusal is
 * the page's 404 (`notFound()`), never a 403, as the routes answer it: nobody
 * learns that a project has an E-Mail-Eingang they may not open. A failed read
 * after the gate is not a 404; the workspace shows its own error for it.
 */

import { notFound } from 'next/navigation'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireMailReviewer } from '@/lib/inbound-mail/access'
import {
  INBOUND_MAIL_LIST_LIMIT,
  INBOUND_MAIL_LIST_STATUSES,
  INBOUND_MAIL_OUTCOMES,
  type InboundMailListStatus,
  type InboundMailListView,
  type InboundMailOutcome,
  type InboundMailView,
} from '@/lib/inbound-mail/inbound-mail-wire'
import { getInboundMail, listInboundMails } from '@/lib/inbound-mail/service'
import { listProjectFolders } from '@/lib/projects/folder-service'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { FolderOption } from '@/features/inbound-mail/lib/draft'

export interface InboundMailPageData {
  projectName: string
  projectClosed: boolean
  folders: FolderOption[]
  status: InboundMailListStatus
  outcome: InboundMailOutcome | null
  list: InboundMailListView | null
  mail: InboundMailView | null
}

type SearchParams = Record<string, string | string[] | undefined>

/** The filter as the URL carries it; anything else is the default list. */
export function filterOf(searchParams: SearchParams): { status: InboundMailListStatus; outcome: InboundMailOutcome | null } {
  const status = (INBOUND_MAIL_LIST_STATUSES as readonly string[]).includes(String(searchParams.status))
    ? (searchParams.status as InboundMailListStatus)
    : 'waiting'
  const outcome =
    status === 'handled' && (INBOUND_MAIL_OUTCOMES as readonly string[]).includes(String(searchParams.outcome))
      ? (searchParams.outcome as InboundMailOutcome)
      : null
  return { status, outcome }
}

async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
}

export async function loadInboundMailPage(
  session: AuthorizedSession,
  projectId: string,
  searchParams: SearchParams,
  mailId: string | null,
): Promise<InboundMailPageData> {
  const { closed } = await orNotFound(requireMailReviewer(session, projectId))
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) notFound()
  const { status, outcome } = filterOf(searchParams)
  const [list, mail, folders] = await Promise.all([
    listInboundMails(session, projectId, { status, outcome: outcome ?? undefined, limit: INBOUND_MAIL_LIST_LIMIT }).catch((error: unknown) => {
      console.error('[inbound-mail] the list could not be read:', error)
      return null
    }),
    // A mail that is not this project's (or not the reader's to see) is the page's 404.
    mailId ? orNotFound(getInboundMail(session, projectId, mailId)) : Promise.resolve(null),
    listProjectFolders(projectId, session).catch((error: unknown) => {
      console.error('[inbound-mail] the folders could not be read:', error)
      return []
    }),
  ])
  return {
    projectName: project.name,
    projectClosed: closed,
    folders: folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      path: folder.path,
      writable: folder.access === 'write',
    })),
    status,
    outcome,
    list,
    mail,
  }
}
