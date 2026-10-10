/**
 * @vitest-environment node
 */
/**
 * What may leave a conversation that drew on a restricted folder (ADR-0087).
 *
 * The decision is driven here with the conversation's record and the folder
 * tree mocked: a run, task or profile patch from a conversation that recorded a
 * source folder not every member may read is refused outright, a filing from
 * one goes only where every reader may read every folder it recorded, and a
 * conversation that recorded nothing (however much it could have searched) is
 * not confined.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./restricted-use', () => ({ recordedRestrictedFolders: vi.fn(), recordedSourceProjects: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findProjectDocumentsByFilenames: vi.fn() }))

import { ConversationConfinedError } from '@/lib/api/errors'
import type { AccessFolder } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { findProjectDocumentsByFilenames, type DocumentListRow } from '@/lib/documents/repository'
import { recordedRestrictedFolders, recordedSourceProjects } from './restricted-use'
import {
  confinementRefusal,
  folderRestrictsReading,
  requireMayFileFrom,
  requireMayLeaveConversation,
  requirePlanDocumentsOpen,
} from './restricted-egress'

const ORG = 'org_1'
const PROJECT = '3f8b0d2e-0000-4000-8000-000000000001'
const COLLECTION = 'proj_3f8b0d2e'
/** Source folders, by id (ADR-0088): the record names folders, not collections. */
const VERTRAEGE = 'vertraege'
const HONORARE = 'honorare'
const CONV = 's_conv_1'

/** Verträge (own list) › Honorare (own list); Offen inherits; Alt is a deleted folder's tombstone. */
const TREE: AccessFolder[] = [
  { id: VERTRAEGE, parentId: null, accessMode: 'custom', everyoneReads: false },
  { id: HONORARE, parentId: VERTRAEGE, accessMode: 'custom', everyoneReads: false },
  { id: 'open', parentId: null, accessMode: 'inherit', everyoneReads: false },
  { id: 'alt', parentId: null, accessMode: 'custom', everyoneReads: false, deleted: true },
]

const destination = (folderId: string | null) => ({
  organizationId: ORG,
  projectId: PROJECT,
  projectCollection: COLLECTION,
  folderId,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(recordedRestrictedFolders).mockResolvedValue([])
  vi.mocked(recordedSourceProjects).mockResolvedValue([])
  vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
})

async function refusal(promise: Promise<unknown>): Promise<ConversationConfinedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ConversationConfinedError)
  return error as ConversationConfinedError
}

describe('requireMayLeaveConversation — runs, tasks and the profile', () => {
  it.each(['deepResearch', 'task', 'profilePatch'] as const)(
    'refuses %s from a conversation that recorded a restricted folder',
    async (action) => {
      vi.mocked(recordedRestrictedFolders).mockResolvedValue([VERTRAEGE])
      const error = await refusal(requireMayLeaveConversation({ conversationId: CONV, locale: 'de' }, ORG, action))
      expect(error.status).toBe(403)
      expect(error.code).toBe('CONVERSATION_CONFINED')
      expect(error.details).toEqual({ action })
      expect(error.message).toContain('Ordner mit eingeschränktem Zugriff')
      expect(recordedRestrictedFolders).toHaveBeenCalledWith(CONV, ORG)
    }
  )

  it('speaks the reader’s language', async () => {
    vi.mocked(recordedRestrictedFolders).mockResolvedValue([VERTRAEGE])
    const error = await refusal(
      requireMayLeaveConversation({ conversationId: CONV, locale: 'en' }, ORG, 'deepResearch')
    )
    expect(error.message).toContain('folder with restricted access')
    expect(error.message).toContain('deep research')
  })

  it('lets a conversation through that recorded nothing, whatever its socket could search', async () => {
    await expect(
      requireMayLeaveConversation({ conversationId: CONV, locale: 'de' }, ORG, 'deepResearch')
    ).resolves.toBeUndefined()
  })

  it('lets a call with no conversation through without reading a record', async () => {
    await expect(requireMayLeaveConversation({ conversationId: null, locale: 'de' }, ORG, 'task')).resolves.toBeUndefined()
    expect(recordedRestrictedFolders).not.toHaveBeenCalled()
  })
})

describe('requireMayFileFrom — only where every reader is cleared for what the conversation drew on', () => {
  beforeEach(() => vi.mocked(recordedRestrictedFolders).mockResolvedValue([VERTRAEGE]))

  it('refuses an open folder', async () => {
    const error = await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('open')))
    expect(error.details).toEqual({ action: 'filing' })
  })

  it('refuses a folder that would be created open at the root', async () => {
    await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination(null)))
  })

  it('allows the recorded folder itself, and a folder below it: nesting only narrows', async () => {
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination(VERTRAEGE))
    ).resolves.toBeUndefined()
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination(HONORARE))
    ).resolves.toBeUndefined()
  })

  it('refuses the parent of a recorded folder: its readers need not be able to read the narrower one', async () => {
    vi.mocked(recordedRestrictedFolders).mockResolvedValue([VERTRAEGE, HONORARE])
    await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination(VERTRAEGE)))
  })

  it('refuses every living folder for content drawn from a deleted folder', async () => {
    vi.mocked(recordedRestrictedFolders).mockResolvedValue(['alt'])
    await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination(VERTRAEGE)))
    await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('alt')))
  })

  it('refuses a destination outside every project (the Archiv)', async () => {
    await refusal(
      requireMayFileFrom(
        { conversationId: CONV, locale: 'de' },
        { ...destination('archiv'), projectId: null, projectCollection: 'archiv_org_1' }
      )
    )
  })

  it('lets a conversation that recorded nothing file anywhere, without reading the folder tree', async () => {
    vi.mocked(recordedRestrictedFolders).mockResolvedValue([])
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('open'))
    ).resolves.toBeUndefined()
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })
})

/**
 * The same test for a DOCUMENT: a revision task quotes a draft's text into a
 * run whose goal and filename every project member sees (`openRevisionTask`).
 */
describe('folderRestrictsReading — whether a revision task may quote a draft', () => {
  it('is true for a folder with its own list, and for one below it', async () => {
    await expect(folderRestrictsReading(ORG, PROJECT, VERTRAEGE)).resolves.toBe(true)
    await expect(folderRestrictsReading(ORG, PROJECT, HONORARE)).resolves.toBe(true)
    expect(listProjectFolderTree).toHaveBeenCalledWith(ORG, PROJECT)
  })

  it('is false for an open folder and for the project root', async () => {
    await expect(folderRestrictsReading(ORG, PROJECT, 'open')).resolves.toBe(false)
    await expect(folderRestrictsReading(ORG, PROJECT, null)).resolves.toBe(false)
  })

  it('is false outside every project, without reading a tree', async () => {
    await expect(folderRestrictsReading(ORG, null, 'open')).resolves.toBe(false)
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })

  it('treats a folder the tree no longer holds as restricting: the safe direction', async () => {
    await expect(folderRestrictsReading(ORG, PROJECT, 'gone')).resolves.toBe(true)
  })

  it('says why, in the reader’s language', () => {
    expect(confinementRefusal('revision', 'de').message).toContain('kann Piloti es nicht überarbeiten')
    expect(confinementRefusal('revision', 'en').message).toContain('Piloti cannot revise it')
    expect(confinementRefusal('revision', 'en').details).toEqual({ action: 'revision' })
  })
})

describe('requirePlanDocumentsOpen — a run’s Unterlagen', () => {
  const row = (filename: string, folderId: string | null) =>
    ({ id: `doc-${filename}`, filename, folderId }) as DocumentListRow

  it('refuses a name any row of which sits below a folder not every member reads, a tombstone included', async () => {
    for (const folderId of [VERTRAEGE, HONORARE, 'alt', 'unknown-folder']) {
      vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([row('a.pdf', 'open'), row('a.pdf', folderId)])
      const error = await refusal(requirePlanDocumentsOpen(ORG, PROJECT, [{ name: 'a.pdf' }], 'de'))
      expect(error.details).toEqual({ action: 'planDocument' })
    }
  })

  it('passes names that sit in open folders, at the root, or nowhere in the project', async () => {
    vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([row('a.pdf', 'open'), row('b.pdf', null)])
    await expect(
      requirePlanDocumentsOpen(ORG, PROJECT, [{ name: 'a.pdf' }, { name: 'b.pdf' }, { name: 'c.pdf' }], 'de')
    ).resolves.toBeUndefined()
  })

  it('asks for no document when no folder of the project has its own list', async () => {
    vi.mocked(listProjectFolderTree).mockResolvedValue([{ id: 'open', parentId: null, accessMode: 'inherit', everyoneReads: false }])
    await requirePlanDocumentsOpen(ORG, PROJECT, [{ name: 'a.pdf', shelf: 'project' }], 'de')
    expect(findProjectDocumentsByFilenames).not.toHaveBeenCalled()
  })
})

describe('a conversation that drew on another project (ADR-0094)', () => {
  const origin = { conversationId: CONV, locale: 'de' as const }

  beforeEach(() => {
    vi.mocked(recordedSourceProjects).mockResolvedValue(['project_other'])
  })

  it('refuses every door a whole project reads, with no restricted folder recorded at all', async () => {
    for (const action of ['deepResearch', 'task', 'profilePatch'] as const) {
      const error = await refusal(requireMayLeaveConversation(origin, ORG, action))
      expect(error.action).toBe(action)
      expect(error.message).toContain('anderes Projekt')
    }
  })

  it('refuses filing anywhere, even into the narrowest folder of this project', async () => {
    expect((await refusal(requireMayFileFrom(origin, destination(HONORARE)))).action).toBe('filing')
    expect(vi.mocked(listProjectFolderTree)).not.toHaveBeenCalled()
  })

  it('lets a conversation without one through as before', async () => {
    vi.mocked(recordedSourceProjects).mockResolvedValue([])

    await expect(requireMayLeaveConversation(origin, ORG, 'task')).resolves.toBeUndefined()
    await expect(requireMayFileFrom(origin, destination('open'))).resolves.toBeUndefined()
  })
})
