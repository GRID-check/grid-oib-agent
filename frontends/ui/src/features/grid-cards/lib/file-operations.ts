/**
 * Executing a `file_operation_proposal` — in the reader's session, through the
 * routes that already exist.
 *
 * The agent proposes and never writes: the Python tier has no path into
 * `grid_app` (ADR-0003), so the card is the whole of what the backend does.
 * Accepting it runs here, as the signed-in user, against exactly the endpoints
 * the Files pane uses for the same five actions — `PATCH /api/documents/[id]`,
 * `PATCH /api/documents/[id]/folder`, `POST /api/projects/[id]/folders`,
 * `POST /api/assignments/document/[id]`. No route is added for the agent's
 * benefit and none is called that a person could not call themselves, so
 * `requireProjectAccess`, the audit trail and the feature gates are the same
 * ones as ever.
 *
 * ## Names, not ids
 *
 * The card carries FILE NAMES because the agent's inventory has no document
 * ids in it (`knowledge/inventory.py` keys documents by `(collection,
 * file_name)`). Resolution therefore happens here, against the reader's own
 * document lists — which is also the honest place for it: a name that no
 * longer resolves means the file moved or went away since the proposal was
 * written, and that has to fail visibly rather than act on a stale id.
 *
 * ## Partial failure is reported, never rounded off
 *
 * Operations are applied IN ORDER and each one's outcome is kept. Four moves
 * where the third fails is three moves and a problem — not "done" and not
 * "failed". {@link applyFileOperations} always resolves, with one result per
 * operation, and the card prints them.
 */

import type { GridCard } from '@/shared/cards/schemas'
import { folderMatchKey } from '@/lib/projects/folders'
import { resolveStoredDocument } from '@/features/documents/hooks/use-surfaced-documents'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'

type ProposalCard = Extract<GridCard, { type: 'file_operation_proposal' }>
export type FileOperationKind = ProposalCard['operation']
/**
 * One row of a proposal, as the card's consumers may hand it over.
 *
 * `Partial` because the WIRE shape is sparse: the backend drops nulls
 * (`model_dump(exclude_none=True)`), a row only ever carries the two or three
 * fields its verb needs, and the generated Zod fills the rest in with
 * `.default(null)`. Typing it as the parsed shape would make every fixture,
 * gallery entry and test spell out five fields that mean nothing for its
 * operation — while a card that came off the wire is assignable either way.
 */
export type FileOperationItem = Partial<ProposalCard['operations'][number]>

/** One operation's outcome, in the order the card listed them. */
export interface FileOperationResult {
  /** What was attempted, for the row the card prints. */
  label: string
  ok: boolean
  /** Untranslated detail for a failure — a status line or a resolution miss. */
  reason?: string
}

const jsonRequest = async (url: string, method: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The folder path a folder row sits at, keyed for comparison segment by segment. */
const pathKey = (path: string): string =>
  path
    .split('/')
    .map(folderMatchKey)
    .filter((segment) => segment.length > 0)
    .join('/')

interface FolderRow {
  id: string
  name: string
  path: string
  parentId: string | null
}

/** Every folder of the project, once per accept, shared by the operations in it. */
async function loadFolders(projectId: string): Promise<FolderRow[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`)
  if (!res.ok) throw new Error(`folders ${res.status}`)
  const body = (await res.json()) as { folders?: FolderRow[] }
  return body.folders ?? []
}

/** `null` for the project root (an empty path), the folder id, or a throw. */
function folderIdForPath(folders: FolderRow[], path: string | null | undefined): string | null {
  const wanted = pathKey(path ?? '')
  if (!wanted) return null
  const hit = folders.find((folder) => pathKey(folder.path) === wanted)
  if (!hit) throw new Error(`Ordner „${path}“ existiert nicht (mehr)`)
  return hit.id
}

async function documentId(
  projectId: string,
  item: FileOperationItem,
): Promise<string> {
  const name = item.document ?? ''
  const source = item.source === 'buero' ? 'buero' : 'projekt'
  const file = await resolveStoredDocument(projectId, name, source)
  if (!file) throw new Error(`„${name}“ wurde nicht gefunden`)
  return file.id
}

interface ExecutionContext {
  projectId: string
  /** Loaded lazily and at most once — only the folder verbs need it. */
  folders: () => Promise<FolderRow[]>
}

type Executor = (item: FileOperationItem, context: ExecutionContext) => Promise<void>

const EXECUTORS: Record<FileOperationKind, Executor> = {
  move: async (item, { projectId, folders }) => {
    const [id, folderId] = await Promise.all([
      documentId(projectId, item),
      folders().then((rows) => folderIdForPath(rows, item.target_folder)),
    ])
    const res = await jsonRequest(`/api/documents/${encodeURIComponent(id)}/folder`, 'PATCH', {
      folderId,
    })
    if (!res.ok) throw new Error(`move ${res.status}`)
  },

  rename: async (item, { projectId }) => {
    const id = await documentId(projectId, item)
    const res = await jsonRequest(`/api/documents/${encodeURIComponent(id)}`, 'PATCH', {
      displayName: item.new_display_name,
    })
    if (!res.ok) throw new Error(`rename ${res.status}`)
  },

  create_folder: async (item, { projectId, folders }) => {
    const parentId = folderIdForPath(await folders(), item.parent_folder)
    const res = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/folders`, 'POST', {
      name: item.folder_name,
      parentId,
    })
    if (!res.ok) throw new Error(`create folder ${res.status}`)
  },

  assign: async (item, { projectId }) => {
    const id = await documentId(projectId, item)
    const path = `/api/assignments/document/${encodeURIComponent(id)}`
    const candidatesRes = await fetch(`${path}/candidates`)
    if (!candidatesRes.ok) throw new Error(`candidates ${candidatesRes.status}`)
    const body = (await candidatesRes.json()) as {
      candidates?: Array<{ userId: string; name?: string | null; email?: string | null }>
    }
    const wanted = (item.member ?? '').trim().toLowerCase()
    const matches = (body.candidates ?? []).filter(
      (person) =>
        (person.name ?? '').trim().toLowerCase() === wanted ||
        (person.email ?? '').trim().toLowerCase() === wanted,
    )
    // Nobody, or two people with the same name: the proposal named a person
    // this project cannot identify, and picking one would assign work to the
    // wrong colleague. The row fails and says so.
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `„${item.member}“ ist kein Mitglied dieses Projekts`
          : `„${item.member}“ ist im Projekt mehrfach vergeben`,
      )
    }
    const res = await jsonRequest(path, 'POST', { userId: matches[0].userId })
    if (!res.ok) throw new Error(`assign ${res.status}`)
  },
}

/** What one row of the card says it will do, for the outcome list. */
export function operationLabel(operation: FileOperationKind, item: FileOperationItem): string {
  if (operation === 'create_folder') {
    return item.parent_folder ? `${item.parent_folder}/${item.folder_name}` : (item.folder_name ?? '')
  }
  return item.document ?? ''
}

/**
 * Apply every operation on one card, in order, and report each one.
 *
 * Never throws: a failure that reached the caller as an exception would take
 * the successes with it, and the reader would be told nothing happened when
 * three of four files had already moved. A first failure does NOT stop the
 * rest — the operations on one card are independent (four files into one
 * folder), and stopping would leave a partial result the card could not
 * explain either.
 */
export async function applyFileOperations(
  operation: FileOperationKind,
  operations: readonly FileOperationItem[],
  projectId: string,
): Promise<FileOperationResult[]> {
  let cached: Promise<FolderRow[]> | null = null
  const context: ExecutionContext = {
    projectId,
    folders: () => (cached ??= loadFolders(projectId)),
  }
  const execute = EXECUTORS[operation]
  const results: FileOperationResult[] = []
  for (const item of operations) {
    const label = operationLabel(operation, item)
    try {
      await execute(item, context)
      results.push({ label, ok: true })
    } catch (error) {
      results.push({ label, ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  // A listing that still shows the old folder, or the old name, is the reader's
  // proof that nothing happened. Fired once, and only when something did.
  if (results.some((result) => result.ok)) notifyDocumentsChanged()
  return results
}
