/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend.test' }))

import { filingFitBody, judgeFiling, judgeMailFiling, keepKnownMoves, keepMailPlacements, mailFilingBody } from './judge'
import type { FilingJudgementInput, MailFilingInput } from './types'

const INPUT: FilingJudgementInput = {
  basis: 'name',
  locale: 'de',
  folders: [
    { path: 'Bescheide', description: 'Bescheide der Behörden', docTypes: ['Bescheid'] },
    { path: 'Pläne/Einreichung', description: null, docTypes: [] },
  ],
  conventions: [{ path: 'Korrespondenz', description: 'Briefe und Mails', projects: 3, docTypes: [] }],
  documents: [
    { id: 'd1', file: 'MA37_Bescheid.pdf', folder: '', type: null, tags: [], summary: null },
    { id: 'd2', file: 'EG.pdf', folder: 'Pläne/Einreichung', type: null, tags: [], summary: null },
  ],
  trace: { batchId: 'b1', projectId: 'p1', shelf: 'project' },
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('keepKnownMoves', () => {
  it('keeps a move into a folder of the input, in the input’s spelling', () => {
    expect(keepKnownMoves([{ id: 'd1', folder: ' bescheide ', reason: 'Ein Bescheid.' }], INPUT)).toEqual([
      { documentId: 'd1', folder: 'Bescheide', reason: 'Ein Bescheid.', newFolder: null, confidence: null },
    ])
  })

  it('drops a document the input did not name and a folder it did not name', () => {
    expect(
      keepKnownMoves(
        [
          { id: 'invented', folder: 'Bescheide', reason: 'x' },
          { id: 'd1', folder: 'Erfunden', reason: 'x' },
        ],
        INPUT
      )
    ).toEqual([])
  })

  it('drops a move into the folder the document is in, a second move for it, and an empty reason', () => {
    expect(
      keepKnownMoves(
        [
          { id: 'd2', folder: 'pläne/einreichung', reason: 'liegt schon dort' },
          { id: 'd1', folder: 'Bescheide', reason: '  ' },
          { id: 'd1', folder: 'Korrespondenz', reason: 'Ein Brief.' },
          { id: 'd1', folder: 'Bescheide', reason: 'doch nicht' },
        ],
        INPUT
      )
    ).toEqual([{ documentId: 'd1', folder: 'Korrespondenz', reason: 'Ein Brief.', newFolder: { description: 'Briefe und Mails' }, confidence: null }])
  })
})

describe('judgeFiling', () => {
  it('asks once for the batch, with the metadata and nothing else, and checks the answer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        moves: [
          { id: 'd1', folder: 'Bescheide', reason: 'Ein Bescheid.' },
          { id: 'ghost', folder: 'Bescheide', reason: 'x' },
        ],
        model: 'm',
        error: null,
        trace_id: 'abcdef0123456789abcdef0123456789',
      })
    )
    const judgement = await judgeFiling('org_1', INPUT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://backend.test/v1/filing-fit')
    expect(init?.headers).toMatchObject({ 'x-grid-organization-id': 'org_1' })
    expect(JSON.parse(String(init?.body))).toEqual(filingFitBody(INPUT))
    expect(judgement).toEqual({
      moves: [{ documentId: 'd1', folder: 'Bescheide', reason: 'Ein Bescheid.', newFolder: null, confidence: null }],
      traceId: 'abcdef0123456789abcdef0123456789',
      error: null,
    })
  })

  it('is no judgement when the backend fails, answers an error, or answers a shape it did not promise', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('down', { status: 502 }))
    expect(await judgeFiling('org_1', INPUT)).toEqual({ moves: [], traceId: null, error: 'backend_502' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ moves: [], error: 'llm_not_configured' }))
    expect((await judgeFiling('org_1', INPUT)).error).toBe('llm_not_configured')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ moves: 'all of them' }))
    expect((await judgeFiling('org_1', INPUT)).error).toBe('response_malformed')
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect((await judgeFiling('org_1', INPUT)).error).toBe('backend_unreachable')
  })

  it('makes no call with nothing to judge or nowhere to file', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await judgeFiling('org_1', { ...INPUT, documents: [] })
    await judgeFiling('org_1', { ...INPUT, folders: [], conventions: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

const MAIL: MailFilingInput = {
  locale: 'de',
  folders: INPUT.folders,
  conventions: INPUT.conventions,
  attachments: [
    { id: 'p1', file: 'Bescheid_MA37.pdf' },
    { id: 'p2', file: 'Lageplan.dwg' },
  ],
  mail: { subject: 'AW: Einreichung ███', senderDomain: 'wien.gv.at', textId: 't1' },
  trace: { mailId: 'mail-1', projectId: 'project-1' },
}

describe('a held mail (basis mail)', () => {
  it('sends names and labels only: each attachment is an id and a name, in no folder, with nothing read', () => {
    const body = mailFilingBody(MAIL) as Record<string, unknown>
    expect(body).toMatchObject({
      basis: 'mail',
      purpose: 'upload',
      documents: [
        { id: 'p1', file: 'Bescheid_MA37.pdf' },
        { id: 'p2', file: 'Lageplan.dwg' },
      ],
      mail: { subject: 'AW: Einreichung ███', sender_domain: 'wien.gv.at', text_id: 't1' },
      trace: { batch_id: 'mail-1', project_id: 'project-1', shelf: 'project' },
    })
    for (const document of body.documents as Array<Record<string, unknown>>) {
      expect(Object.keys(document).sort()).toEqual(['file', 'id'])
    }
    expect(Object.keys(body.mail as object).sort()).toEqual(['sender_domain', 'subject', 'text_id'])
  })

  it('keeps a placement the input grounds, with a Dokumentart of the vocabulary, and the text without one', () => {
    expect(
      keepMailPlacements(
        [
          { id: 'p1', folder: 'bescheide', type: 'Bescheid', reason: ' Ein  Bescheid. ' },
          { id: 'p2', folder: 'Korrespondenz', type: 'Lieblingsplan', reason: 'Ein Lageplan.' },
          { id: 't1', folder: 'Bescheide', type: 'Bescheid', reason: 'Schriftverkehr.' },
          { id: 'p1', folder: 'Pläne/Einreichung', reason: 'doch' },
          { id: 'ghost', folder: 'Bescheide', reason: 'x' },
          { id: 'p2', folder: 'Erfunden', reason: 'x' },
        ],
        MAIL,
      ),
    ).toEqual([
      { partId: 'p1', folder: 'Bescheide', newFolder: null, documentType: 'Bescheid', reason: 'Ein Bescheid.' },
      { partId: 'p2', folder: 'Korrespondenz', newFolder: { description: 'Briefe und Mails' }, documentType: null, reason: 'Ein Lageplan.' },
      { partId: 't1', folder: 'Bescheide', newFolder: null, documentType: null, reason: 'Schriftverkehr.' },
    ])
  })

  it('asks once, as a mail, and answers the checked placements with the trace', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        moves: [{ id: 'p1', folder: 'Bescheide', type: 'Bescheid', reason: 'Ein Bescheid.' }],
        trace_id: 'abcdef0123456789abcdef0123456789',
      }),
    )
    const judgement = await judgeMailFiling('org_1', MAIL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(mailFilingBody(MAIL))
    expect(judgement).toEqual({
      placements: [{ partId: 'p1', folder: 'Bescheide', newFolder: null, documentType: 'Bescheid', reason: 'Ein Bescheid.' }],
      traceId: 'abcdef0123456789abcdef0123456789',
      error: null,
    })
  })

  it('fails open, and makes no call with nothing to place or nowhere to place it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('down', { status: 503 }))
    expect(await judgeMailFiling('org_1', MAIL)).toEqual({ placements: [], traceId: null, error: 'backend_503' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockClear()
    await judgeMailFiling('org_1', { ...MAIL, attachments: [], mail: { ...MAIL.mail, textId: null } })
    await judgeMailFiling('org_1', { ...MAIL, folders: [], conventions: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
