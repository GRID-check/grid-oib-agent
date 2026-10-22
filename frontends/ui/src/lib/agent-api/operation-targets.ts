/**
 * What an operation call names: the projects, documents, folders and
 * conversations its input points at (ADR-0122, ADR-0093, ADR-0094).
 *
 * Two gates ask it, each about a different person:
 *
 *  - The read gate (`read-gate.ts`, `conversation-audience.ts`): a read in a
 *    conversation of Piloti's may reach only what the conversation's audience
 *    may read (ADR-0094). What it names is resolved to where it lives
 *    (`placesOf`), judged against the audience's reach, and recorded on the
 *    conversation before it runs; a proposal in a shared conversation is held
 *    to the same reach.
 *  - The proposal (`operation-proposals.ts`): a write Piloti proposes may only
 *    name what the person whose turn it is may read, so a member's Piloti cannot
 *    put a card in front of an admin that changes a project the member cannot
 *    see (`requireTargetsReadable`). The card then names each target for its
 *    reader (`describeTargets`), not only by id.
 *
 * Read from the operation's own path (`/api/projects/[id]/…` names a project)
 * and from its query and body, by key (`projectId`, `documentId`, `folderId`,
 * `conversationId`, `modelId`, a held mail's `mailId`, a `mailThreadId`, and a `resourceType`/`resourceId` or
 * `entityType`/`entityId` pair), at any depth up to {@link MAX_DEPTH}. A key
 * this file does not know names nothing: the route's own check still applies,
 * as it does to every call.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isFolderVisibleTo } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getAccessibleDocument } from '@/lib/documents/access'
import { documentDisplayName } from '@/lib/documents/display-name'
import { requireResourceAccess } from '@/lib/sharing/access'
import type { OperationTargetType, OperationTargetView } from '@/lib/proposals/types'
import type { AgentOperation } from './operation'
import { type TargetPlace, findTargetPlace, findProjectName } from './operation-targets-repository'

export type TargetType = OperationTargetType

export interface OperationTarget {
  type: TargetType
  id: string
}

/** What a call's input looks like here: the dispatcher's `{ params, query, body }`. */
export interface TargetInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

/** A path segment, and what the `[param]` after it names. */
const PATH_SEGMENT_TARGETS: Readonly<Record<string, TargetType>> = {
  projects: 'project',
  documents: 'document',
  folders: 'folder',
  conversations: 'conversation',
  models: 'bim_model',
  'upload-batches': 'upload_batch',
  proposals: 'proposal',
  // A held mail and a mail thread live in their project (ADR-0134); the path names the project too.
  'inbound-mails': 'inbound_mail',
  'mail-threads': 'mail_thread',
}

/** An input key, and what its value (a string or a list of strings) names. */
export const KEY_TARGETS: Readonly<Record<string, TargetType>> = {
  projectId: 'project',
  projectIds: 'project',
  documentId: 'document',
  documentIds: 'document',
  folderId: 'folder',
  folderIds: 'folder',
  conversationId: 'conversation',
  modelId: 'bim_model',
  // The model a comparison or a compliance diff reads beside the one in the path (`lib/bim/query.ts`).
  baseModelId: 'bim_model',
  // What a decision about held mail names (`inbound-mail-file`, `inbound-mail-dismiss`, ADR-0134).
  mailId: 'inbound_mail',
  mailIds: 'inbound_mail',
  mailThreadId: 'mail_thread',
  // The document an attachment is filed as the next Fassung of.
  revisionOf: 'document',
}

/** The values a `resourceType` / `entityType` takes that name something here. */
const TYPED_TARGETS: Readonly<Record<string, TargetType>> = {
  project: 'project',
  document: 'document',
  folder: 'folder',
  conversation: 'conversation',
}

/** How deep the body is searched. The schemas this catalog holds nest two levels at most. */
const MAX_DEPTH = 4
/** Most targets one call may name; beyond it the call is refused, never half-checked. */
export const MAX_TARGETS = 50

export class TooManyTargetsError extends Error {
  constructor() {
    super(`The call names more than ${MAX_TARGETS} projects, documents, folders or conversations`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const idsOf = (value: unknown): string[] =>
  typeof value === 'string' && value.trim()
    ? [value.trim()]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : []

function pathTargets(op: Pick<AgentOperation, 'path'>, params: Record<string, unknown> | undefined): OperationTarget[] {
  const segments = op.path.split('/')
  const found: OperationTarget[] = []
  segments.forEach((segment, index) => {
    const name = /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(segment)?.[1]
    if (!name) return
    const value = params?.[name]
    if (typeof value !== 'string' || !value) return
    if (name === 'resourceId' || name === 'entityId') return // read with its type below
    const type = PATH_SEGMENT_TARGETS[segments[index - 1] ?? '']
    if (type) found.push({ type, id: value })
  })
  const typed = typeof params?.resourceType === 'string' ? TYPED_TARGETS[params.resourceType] : undefined
  if (typed && typeof params?.resourceId === 'string') found.push({ type: typed, id: params.resourceId })
  return found
}

function valueTargets(value: unknown, depth: number, into: OperationTarget[]): void {
  if (depth > MAX_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) valueTargets(item, depth + 1, into)
    return
  }
  if (!isRecord(value)) return
  for (const [key, inner] of Object.entries(value)) {
    const type = KEY_TARGETS[key]
    if (type) for (const id of idsOf(inner)) into.push({ type, id })
    else valueTargets(inner, depth + 1, into)
  }
  for (const [typeKey, idKey] of [
    ['resourceType', 'resourceId'],
    ['entityType', 'entityId'],
  ] as const) {
    const typed = typeof value[typeKey] === 'string' ? TYPED_TARGETS[value[typeKey] as string] : undefined
    if (typed) for (const id of idsOf(value[idKey])) into.push({ type: typed, id })
  }
}

/**
 * Everything `input` names for `op`, each once, path first. Throws
 * {@link TooManyTargetsError} past {@link MAX_TARGETS}.
 */
export function targetsOf(op: Pick<AgentOperation, 'path'>, input: TargetInput): OperationTarget[] {
  const found = pathTargets(op, input.params)
  valueTargets(input.query, 0, found)
  valueTargets(input.body, 0, found)
  const seen = new Set<string>()
  const unique = found.filter((target) => {
    const key = `${target.type}:${target.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length > MAX_TARGETS) throw new TooManyTargetsError()
  return unique
}

const TYPE_ID_PAIRS = [
  ['resourceType', 'resourceId'],
  ['entityType', 'entityId'],
] as const

function namesUntyped(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false
  if (Array.isArray(value)) return value.some((item) => namesUntyped(item, depth + 1))
  if (!isRecord(value)) return false
  const here = TYPE_ID_PAIRS.some(
    ([typeKey, idKey]) =>
      typeof value[typeKey] === 'string' && !TYPED_TARGETS[value[typeKey] as string] && idsOf(value[idKey]).length > 0,
  )
  return here || Object.values(value).some((inner) => namesUntyped(inner, depth + 1))
}

/**
 * Whether `input` names a resource by a type this file cannot place (a
 * `resourceType` of `project_folder`, an `entityType` of `annotation`): the
 * call reaches something {@link targetsOf} does not list. The read gate
 * refuses such a read, because it cannot tell which project's content the
 * answer carries.
 */
export function namesUntypedResource(input: TargetInput): boolean {
  return namesUntyped(input.params, 0) || namesUntyped(input.query, 0) || namesUntyped(input.body, 0)
}

/** Where each target lives, in the caller's tenant scope; a target that does not exist there is `null`. */
export async function placesOf(
  organizationId: string,
  userId: string,
  targets: readonly OperationTarget[],
): Promise<(TargetPlace | null)[]> {
  return Promise.all(targets.map((target) => findTargetPlace(organizationId, userId, target)))
}

/**
 * Refuse (404, as every route refuses what a reader may not see) unless
 * `session`'s person may read every target: the project, the document on its
 * shelf, the folder, the conversation. A target that does not exist is refused
 * too: there is nothing to propose against it. Call in the tenant scope.
 */
export async function requireTargetsReadable(
  session: AuthorizedSession,
  targets: readonly OperationTarget[],
): Promise<void> {
  for (const target of targets) {
    const place = await findTargetPlace(session.organizationId, session.userId, target)
    if (!place) throw new NotFoundError(`The ${label(target.type)} ${target.id} was not found`)
    if (target.type === 'document') {
      await getAccessibleDocument(session, target.id, 'read')
      continue
    }
    if (target.type === 'conversation') {
      await requireResourceAccess(session, 'conversation', target.id, 'viewer')
      continue
    }
    if (place.projectId) await requireProjectAccess(session, place.projectId, 'project:view')
    if (target.type === 'folder' && place.projectId && !(await isFolderVisibleTo(session, place.projectId, target.id))) {
      throw new NotFoundError(`The folder ${target.id} was not found`)
    }
    if (target.type === 'proposal' && place.conversationId) {
      await requireResourceAccess(session, 'conversation', place.conversationId, 'viewer')
    }
  }
}


async function readableName(session: AuthorizedSession, target: OperationTarget): Promise<string | null> {
  try {
    if (target.type === 'project') {
      await requireProjectAccess(session, target.id, 'project:view')
      return await findProjectName(session.organizationId, target.id)
    }
    if (target.type === 'document') return documentDisplayName(await getAccessibleDocument(session, target.id, 'read'))
    return null
  } catch {
    // Not readable for this reader, or gone: the card shows the id alone.
    return null
  }
}

/** The targets of a proposed call, named for `session`'s person where they may read them. Call in the tenant scope. */
export async function describeTargets(
  session: AuthorizedSession,
  op: Pick<AgentOperation, 'path'>,
  input: TargetInput,
): Promise<OperationTargetView[]> {
  let targets: OperationTarget[]
  try {
    targets = targetsOf(op, input)
  } catch {
    return []
  }
  return Promise.all(targets.map(async (target) => ({ ...target, name: await readableName(session, target) })))
}

function label(type: TargetType): string {
  return type.replace('_', ' ')
}
