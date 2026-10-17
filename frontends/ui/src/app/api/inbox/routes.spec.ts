/**
 * @vitest-environment node
 */
/**
 * The inbox API (ADR-0035), driven through its TYPED CLIENT (ADR-0055): the
 * client and the routes cannot disagree about a path, a verb or a body. The
 * service is stubbed; what these cases hold is that every shape the client
 * sends reaches the one service function that owns it, and that a shape it
 * does not send is refused.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_1',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'anna@grid.test',
  name: 'Anna',
  role: 'member',
  permissions: [] as string[],
  accessToken: '',
  featureFlags: null,
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))

const RESULT = { affected: 1, pending: 2 }
vi.mock('@/lib/inbox/service', () => ({
  INBOX_LIST_LIMIT: 50,
  listInbox: vi.fn(async () => ({ items: [], pending: 2, counts: { requests: 1, unread: 2 }, hasMore: true, nextCursor: 'next' })),
  markRead: vi.fn(async () => RESULT),
  markAllRead: vi.fn(async () => RESULT),
  markAnchorItemsReadFor: vi.fn(async () => RESULT),
  markUnread: vi.fn(async () => RESULT),
  archiveItem: vi.fn(async () => RESULT),
  unarchiveItem: vi.fn(async () => RESULT),
  getInboxSummary: vi.fn(async () => ({ pending: 2 })),
}))

import {
  archiveItem,
  listInbox,
  markAllRead,
  markAnchorItemsReadFor,
  markRead,
  markUnread,
  unarchiveItem,
} from '@/lib/inbox/service'
import { createInboxClient, INBOX_READ_PATH, InboxRequestError } from '@/lib/inbox/client'
import { GET as list } from './route'
import { POST as read } from './read/route'
import { POST as unread } from './unread/route'
import { GET as summary } from './summary/route'
import { DELETE as unarchive, POST as archive } from './[id]/archive/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>
const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler }> = [
  { pattern: /^\/api\/inbox$/, method: 'GET', handler: list },
  { pattern: /^\/api\/inbox\/summary$/, method: 'GET', handler: summary },
  { pattern: /^\/api\/inbox\/read$/, method: 'POST', handler: read },
  { pattern: /^\/api\/inbox\/unread$/, method: 'POST', handler: unread },
  { pattern: /^\/api\/inbox\/([^/]+)\/archive$/, method: 'POST', handler: archive },
  { pattern: /^\/api\/inbox\/([^/]+)\/archive$/, method: 'DELETE', handler: unarchive },
]

async function serve(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  return route.handler(new Request(url, init), { params: Promise.resolve({ id: decodeURIComponent(matched[1] ?? '') }) })
}

const client = createInboxClient(serve)
const ITEM = '00000000-0000-4000-8000-000000000001'

beforeEach(() => vi.clearAllMocks())

describe('GET /api/inbox', () => {
  it('reads the slice and the page the client names, and hands back the next cursor', async () => {
    const page = await client.list({ filter: 'requests', cursor: 'abc' })
    expect(listInbox).toHaveBeenCalledWith(SESSION, { filter: 'requests', cursor: 'abc' })
    expect(page).toMatchObject({ pending: 2, counts: { requests: 1, unread: 2 }, hasMore: true, nextCursor: 'next' })
  })

  it('reads everything unarchived by default', async () => {
    await client.list()
    expect(listInbox).toHaveBeenLastCalledWith(SESSION, { filter: 'all', cursor: undefined })
  })

  it('refuses a slice it does not know', async () => {
    expect((await serve('/api/inbox?filter=everything')).status).toBe(400)
    expect(listInbox).not.toHaveBeenCalled()
  })
})

describe('POST /api/inbox/read', () => {
  it('reads items, everything, or the news about one mark', async () => {
    await client.markRead([ITEM])
    expect(markRead).toHaveBeenCalledWith(SESSION, [ITEM])
    await client.markAllRead()
    expect(markAllRead).toHaveBeenCalledWith(SESSION)
    expect(await client.markMarkRead({ documentId: 'doc-1', annotationId: 'mark-4' })).toEqual(RESULT)
    expect(markAnchorItemsReadFor).toHaveBeenCalledWith(SESSION, 'document', 'doc-1', 'mark-4')
  })

  it('refuses an anchor on anything but a document, and a body that is two shapes at once', async () => {
    const send = (body: unknown) =>
      serve(INBOX_READ_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await send({ resourceType: 'conversation', resourceId: 'c1', anchorId: 'm1' })).status).toBe(400)
    expect((await send({ all: true, itemIds: [ITEM] })).status).toBe(400)
    expect(markAnchorItemsReadFor).not.toHaveBeenCalled()
    expect(markAllRead).not.toHaveBeenCalled()
  })

  it('is the path the service worker posts a tapped notification to', () => {
    const worker = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8')
    expect(worker).toContain(`var READ_PATH = '${INBOX_READ_PATH}'`)
  })
})

describe('POST /api/inbox/unread', () => {
  it('marks items unread again', async () => {
    expect(await client.markUnread([ITEM])).toEqual(RESULT)
    expect(markUnread).toHaveBeenCalledWith(SESSION, [ITEM])
  })

  it('refuses an id that is not an item id', async () => {
    await expect(client.markUnread(['not-an-id'])).rejects.toBeInstanceOf(InboxRequestError)
    expect(markUnread).not.toHaveBeenCalled()
  })
})

describe('/api/inbox/{id}/archive', () => {
  it('archives with POST and restores with DELETE', async () => {
    await client.archive(ITEM)
    expect(archiveItem).toHaveBeenCalledWith(SESSION, ITEM)
    await client.unarchive(ITEM)
    expect(unarchiveItem).toHaveBeenCalledWith(SESSION, ITEM)
  })
})
