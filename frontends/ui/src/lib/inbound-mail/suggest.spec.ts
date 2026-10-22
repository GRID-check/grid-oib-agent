/**
 * @vitest-environment node
 *
 * Piloti's suggestion for a held mail, the rules (`./suggest`): what is asked
 * about, what the model reads (names and labels, never the text), how the
 * answer is stored, and whether a person's decision followed it.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend.test' }))

import { mailFilingBody } from '@/lib/filing/judge'
import type { FilingFolderInput } from '@/lib/filing/types'
import { FILE_PART_ID, FOLDER_ID, TEXT_PART_ID, THREAD_ID, filePart, heldMail, textPart } from './__fixtures__/review'
import type { InboundMailDecision } from './inbound-mail-wire'
import {
  attachmentsToPlace,
  decidedPlacements,
  decidedSuggestions,
  inboundMailSuggestionSchema,
  mailFilingInput,
  readSuggestion,
  senderDomainOf,
  suggestionFollowed,
  suggestionOutcome,
  suggestionSkipReason,
  suggestionsFrom,
  textToPlace,
  type InboundMailSuggestion,
} from './suggest'

const FOLDERS: FilingFolderInput[] = [{ path: 'Tragwerk', description: 'Statik und Tragwerksplanung', docTypes: ['Gutachten'] }]
const CONTEXT = { maskedSubject: 'AW: Statik Einreichung', folders: FOLDERS, conventions: [], locale: 'de' }

/** The sender's own text: what `read.json` holds, and what must never reach the model. */
const OWN_TEXT = 'Sehr geehrte Frau Architektin, anbei die Statik. Das Honorar überweisen Sie bitte auf AT61 1904 3002 3457 3201.'

describe('who is asked about', () => {
  it('asks about a confirmed sender’s waiting mail', () => {
    expect(suggestionSkipReason(heldMail())).toBeNull()
    expect(suggestionSkipReason(heldMail({ senderTrust: 'external_verified' }))).toBeNull()
  })

  it('never about an unconfirmed sender, automatic mail, or a mail that no longer waits', () => {
    expect(suggestionSkipReason(heldMail({ senderTrust: 'external_unverified' }))).toBe('external_unverified')
    expect(suggestionSkipReason(heldMail({ automatic: true }))).toBe('automatic')
    expect(suggestionSkipReason(heldMail({ status: 'settled' }))).toBe('not_waiting')
    expect(suggestionSkipReason(heldMail({ senderTrust: null }))).toBe('not_waiting')
  })
})

describe('what is placed', () => {
  it('places the waiting attachments whose names passed the check, in position order', () => {
    const parts = [
      filePart({ id: 'p3', position: 3, filename: 'Honorar.pdf', nameStopTerms: ['Honorar'], riskFlags: ['name_stop'] }),
      filePart({ id: 'p2', position: 2, filename: 'Makro.xlsm', riskFlags: ['type_not_accepted'] }),
      filePart({ id: 'p4', position: 4, filename: 'Virus.pdf', scanStatus: 'infected' }),
      filePart({ id: 'p5', position: 5, state: 'dismissed' }),
      filePart({ id: 'p6', position: 6, filename: null }),
      filePart(),
      textPart(),
    ]
    expect(attachmentsToPlace(parts).map((part) => part.id)).toEqual([FILE_PART_ID])
  })

  it('places the text only when the mail matched no Verlauf: a match is its own suggestion', () => {
    expect(textToPlace(heldMail(), [textPart(), filePart()])).toBeNull()
    expect(textToPlace(heldMail({ threadMatch: [] }), [textPart(), filePart()])?.id).toBe(TEXT_PART_ID)
    expect(textToPlace(heldMail({ threadMatch: [] }), [textPart({ state: 'dismissed' })])).toBeNull()
  })

  it('has nothing to place when no attachment passed and the text matched', () => {
    expect(mailFilingInput(heldMail(), [textPart(), filePart({ nameStopTerms: ['Statik'] })], CONTEXT)).toBeNull()
  })

  it('names the sender’s domain, never the address', () => {
    expect(senderDomainOf(heldMail())).toBe('statik-weber.at')
    expect(senderDomainOf(heldMail({ senderAddress: null, signerDomain: 'Wien.GV.at' }))).toBe('wien.gv.at')
    expect(senderDomainOf(heldMail({ senderAddress: null, signerDomain: null }))).toBeNull()
  })
})

describe('what the model reads (D21): names and labels, never the text or the bytes', () => {
  // The mail as the receive job left it: its text staged in `read.json`, its subject on the row.
  const mail = heldMail({ threadMatch: [], senderName: 'DI Petra Weber' })
  const parts = [textPart({ sha256: 'd'.repeat(64) }), filePart()]

  it('sends the attachment names, the masked subject, the sender’s domain and the folders, nothing else', () => {
    const input = mailFilingInput(mail, parts, { ...CONTEXT, maskedSubject: 'AW: Statik ███' })
    expect(input).toEqual({
      locale: 'de',
      folders: FOLDERS,
      conventions: [],
      attachments: [{ id: FILE_PART_ID, file: 'S-101_C.pdf' }],
      mail: { subject: 'AW: Statik ███', senderDomain: 'statik-weber.at', textId: TEXT_PART_ID },
      trace: { mailId: mail.id, projectId: mail.projectId },
    })
  })

  it('carries no body, no sender name or address, no storage key and no digest in the request', () => {
    const input = mailFilingInput(mail, parts, CONTEXT)
    expect(input).not.toBeNull()
    const body = JSON.stringify(mailFilingBody(input as NonNullable<typeof input>))
    for (const word of OWN_TEXT.split(/\s+/).filter((word) => word.length > 6)) expect(body).not.toContain(word)
    expect(body).not.toContain('DI Petra Weber')
    expect(body).not.toContain('p.weber@')
    expect(body).not.toContain('_inbound-mail')
    expect(body).not.toContain('read.json')
    expect(body).not.toContain('d'.repeat(64))
    expect(body).not.toMatch(/"(body|text|own_text|ownText|summary|bytes|content)"\s*:/)
  })
})

describe('the stored suggestion', () => {
  const placements = [
    { partId: FILE_PART_ID, folder: 'tragwerk', newFolder: null, documentType: 'Gutachten' as const, reason: 'Die Statik.' },
    { partId: TEXT_PART_ID, folder: 'Korrespondenz', newFolder: { description: null }, documentType: null, reason: 'Schriftverkehr.' },
    { partId: 'ghost', folder: 'Gelöscht', newFolder: null, documentType: null, reason: 'Ein Ordner, den es nicht mehr gibt.' },
  ]

  it('names an existing folder by id and path, a convention as a new folder, and drops a folder that is gone', () => {
    const stored = suggestionsFrom(placements, [{ id: FOLDER_ID, path: 'Tragwerk' }])
    expect(Object.fromEntries(stored)).toEqual({
      [FILE_PART_ID]: { folderId: FOLDER_ID, folderPath: 'Tragwerk', newFolder: false, documentType: 'Gutachten', reason: 'Die Statik.' },
      [TEXT_PART_ID]: { folderId: null, folderPath: 'Korrespondenz', newFolder: true, documentType: null, reason: 'Schriftverkehr.' },
    })
    for (const suggestion of stored.values()) expect(inboundMailSuggestionSchema.safeParse(suggestion).success).toBe(true)
  })

  it('reads back only the shape it writes', () => {
    expect(readSuggestion(null)).toBeNull()
    expect(readSuggestion({ folder: 'Tragwerk' })).toBeNull()
    expect(readSuggestion({ folderId: null, folderPath: 'A', newFolder: true, documentType: 'Plan', reason: 'x' })).toBeNull()
  })
})

describe('whether a decision followed it', () => {
  const suggestion: InboundMailSuggestion = {
    folderId: FOLDER_ID,
    folderPath: 'Tragwerk',
    newFolder: false,
    documentType: 'Gutachten',
    reason: 'Die Statik.',
  }
  const pathOf = (folderId: string) => (folderId === FOLDER_ID ? 'Tragwerk' : folderId === 'other' ? 'Plaene' : null)
  const decision = (patch: Partial<Pick<InboundMailDecision, 'parts' | 'message'>> = {}) => ({
    parts: [{ partId: FILE_PART_ID, folderId: FOLDER_ID, newFolderPath: null, name: 'S-101_C.pdf', documentType: 'Gutachten' }],
    message: null,
    ...patch,
  })

  it('is accepted when filed in the suggested folder as the suggested Dokumentart', () => {
    const placed = decidedPlacements(decision(), pathOf).get(FILE_PART_ID) ?? null
    expect(suggestionOutcome(suggestion, placed)).toEqual({ decision: 'accepted', folder: 'same', type: 'same' })
  })

  it('is dismissed when another folder, another Dokumentart, or nothing was chosen, and says which', () => {
    const elsewhere = decidedPlacements(decision({ parts: [{ ...decision().parts[0], folderId: 'other' }] }), pathOf)
    expect(suggestionOutcome(suggestion, elsewhere.get(FILE_PART_ID) ?? null)).toEqual({ decision: 'dismissed', folder: 'other', type: 'same' })
    const retyped = decidedPlacements(decision({ parts: [{ ...decision().parts[0], documentType: 'Vertrag' }] }), pathOf)
    expect(suggestionOutcome(suggestion, retyped.get(FILE_PART_ID) ?? null)).toEqual({ decision: 'dismissed', folder: 'same', type: 'other' })
    expect(suggestionOutcome(suggestion, null)).toEqual({ decision: 'dismissed', folder: 'not_filed', type: 'other' })
  })

  it('matches a new folder by its path, whatever its spelling', () => {
    const convention: InboundMailSuggestion = { ...suggestion, folderId: null, folderPath: 'Behörde/Bescheide', newFolder: true, documentType: null }
    const placed = decidedPlacements(
      decision({ parts: [{ ...decision().parts[0], folderId: null, newFolderPath: ' behörde / bescheide ' }] }),
      pathOf,
    )
    expect(suggestionOutcome(convention, placed.get(FILE_PART_ID) ?? null)).toEqual({ decision: 'accepted', folder: 'same', type: 'none' })
  })

  it('reads the text as filed into a new Verlauf’s folder, and an append as another place', () => {
    const create = decidedPlacements(
      decision({ parts: [], message: { partId: TEXT_PART_ID, text: 'full', thread: { action: 'create', folderId: FOLDER_ID, newFolderPath: null, name: 'Statik' } } }),
      pathOf,
    )
    expect(create.get(TEXT_PART_ID)).toEqual({ folderPath: 'Tragwerk', documentType: 'correspondence' })
    const append = decidedPlacements(
      decision({ parts: [], message: { partId: TEXT_PART_ID, text: 'full', thread: { action: 'append', mailThreadId: THREAD_ID } } }),
      pathOf,
    )
    expect(append.get(TEXT_PART_ID)).toEqual({ folderPath: null, documentType: 'correspondence' })
    const text: InboundMailSuggestion = { ...suggestion, documentType: null }
    expect(suggestionOutcome(text, append.get(TEXT_PART_ID) ?? null).decision).toBe('dismissed')
  })

  it('scores only waiting parts with a suggestion, each on its own trace', () => {
    const parts = [
      filePart({ suggestion: suggestion, suggestionTraceId: 'a'.repeat(32) }),
      filePart({ id: 'p2', position: 2, suggestion: null }),
      filePart({ id: 'p3', position: 3, state: 'filed', suggestion: suggestion }),
      textPart(),
    ]
    expect(decidedSuggestions(parts, decision(), pathOf)).toEqual([
      { partId: FILE_PART_ID, traceId: 'a'.repeat(32), outcome: { decision: 'accepted', folder: 'same', type: 'same' } },
    ])
    expect(decidedSuggestions(parts, null, pathOf)[0].outcome.folder).toBe('not_filed')
  })

  it('says how much of a mail’s suggestion was taken', () => {
    const accepted = { decision: 'accepted', folder: 'same', type: 'same' } as const
    const dismissed = { decision: 'dismissed', folder: 'other', type: 'none' } as const
    expect(suggestionFollowed([])).toBe('no_suggestion')
    expect(suggestionFollowed([accepted, accepted])).toBe('all')
    expect(suggestionFollowed([accepted, dismissed])).toBe('partly')
    expect(suggestionFollowed([dismissed])).toBe('none')
  })
})
