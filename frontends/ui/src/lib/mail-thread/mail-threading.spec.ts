/**
 * @vitest-environment node
 */
/**
 * The threading ladder and the pre-selection matrix (DECISION D11, RT-S1).
 * The fixtures are taken from the rules they test: RFC 5322 §3.6.4 for ids,
 * RFC 5256 §2.1 for the base subject, RFC 8621 §3 for membership, MS-OXOMSG
 * for the Thread-Index, and the hostile corpus of DECISION §10 for what a
 * stranger may write.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendNeedsAcknowledgement,
  baseSubject,
  clampSentAt,
  domainOf,
  matchThread,
  normalizeMessageId,
  parseInReplyTo,
  parseMessageIdList,
  parseReferences,
  PRESELECTION_BLOCKS,
  senderPreselectionBlocks,
  SENDER_TRUSTS,
  SENT_AT_CLOCK_SKEW_MINUTES,
  threadIndexGuid,
  threadIndexGuidFromBytes,
  threadPreselection,
  type SenderEvidence,
  type SenderTrust,
  type ThreadCandidate,
  type ThreadingMessage,
  type ThreadMatch,
  type ThreadMatchStrength,
} from './mail-threading'

const DAY = 86_400_000

describe('normalizeMessageId', () => {
  it('strips the brackets and lower-cases only the domain part', () => {
    expect(normalizeMessageId(' <AbC.123@Mail.Example.AT> ')).toBe('AbC.123@mail.example.at')
  })

  it('keeps an id without a domain part as sent', () => {
    expect(normalizeMessageId('<Lotus-0815>')).toBe('Lotus-0815')
  })

  it('refuses what is not a token', () => {
    for (const raw of [null, '', '<>', '<a b@c>', 'x', `<${'a'.repeat(999)}@b>`, '<a\u0000b@c>']) {
      expect(normalizeMessageId(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('parseMessageIdList', () => {
  it('reads every bracketed id once, in order, across folds and comments', () => {
    const field = '<a@x.at> (Kommentar)\r\n <B@X.AT>\t<a@x.at> junk <c@y.at>'
    expect(parseMessageIdList(field)).toEqual(['a@x.at', 'B@x.at', 'c@y.at'])
  })

  it('accepts a bare id only as the whole field', () => {
    expect(parseMessageIdList('  bare@erp.at ')).toEqual(['bare@erp.at'])
    expect(parseMessageIdList('two bare@ids.at')).toEqual([])
  })

  it('caps In-Reply-To at five', () => {
    const field = Array.from({ length: 9 }, (_, i) => `<id${i}@x.at>`).join(' ')
    expect(parseInReplyTo(field)).toHaveLength(5)
  })

  it('keeps the root and the last forty-nine of a long References', () => {
    const ids = Array.from({ length: 80 }, (_, i) => `<id${i}@x.at>`)
    const parsed = parseReferences(ids.join(' '))
    expect(parsed).toHaveLength(50)
    expect(parsed[0]).toBe('id0@x.at')
    expect(parsed[1]).toBe('id31@x.at')
    expect(parsed.at(-1)).toBe('id79@x.at')
  })
})

describe('baseSubject', () => {
  it.each([
    ['AW: Stellplatznachweis', 'stellplatznachweis'],
    ['Re: AW: WG: Stellplatznachweis', 'stellplatznachweis'],
    ['AW[2]: Stellplatznachweis', 'stellplatznachweis'],
    ['Antw: Stellplatznachweis', 'stellplatznachweis'],
    ['RE : Stellplatznachweis', 'stellplatznachweis'],
    ['SV: VS: Stellplatznachweis', 'stellplatznachweis'],
    ['[EXTERN] AW: Stellplatznachweis', 'stellplatznachweis'],
    ['EXTERN: AW: Stellplatznachweis', 'stellplatznachweis'],
    ['AW: [Projekt 12] Stellplatznachweis', 'stellplatznachweis'],
    ['Stellplatznachweis (fwd)', 'stellplatznachweis'],
    ['[Fwd: Stellplatznachweis]', 'stellplatznachweis'],
    ['  Stellplatz\tnachweis   Bauplatz  12 ', 'stellplatz nachweis bauplatz 12'],
    ['Straße', 'strasse'],
    ['STRASSE', 'strasse'],
    ['[nur ein Tag]', '[nur ein tag]'],
    ['', ''],
  ])('%j → %j', (subject, expected) => {
    expect(baseSubject(subject)).toBe(expected)
  })

  it('equals across NFC and NFD', () => {
    expect(baseSubject('AW: Prüfung'.normalize('NFD'))).toBe(baseSubject('Prüfung'))
  })

  it('does not strip a word that only starts like a leader', () => {
    expect(baseSubject('Rechnung Statik')).toBe('rechnung statik')
    expect(baseSubject('Wgs84 Koordinaten')).toBe('wgs84 koordinaten')
  })
})

/** A Thread-Index header: reserved byte, FILETIME, GUID, child blocks. */
function threadIndex(guid: number[], children = 0): string {
  const bytes = [1, 0x01, 0xd9, 0x3a, 0x11, 0x22, ...guid, ...Array.from({ length: children * 5 }, () => 7)]
  return btoa(String.fromCharCode(...bytes))
}
const GUID = Array.from({ length: 16 }, (_, i) => i + 0xa0)

interface ThreadIndexVector {
  bytesHex: string
  conversationIndexBase64: string
  childOfBase64: string
  guid: string
}

/**
 * The vector the mail archive reader's test reads too (`test_mail_archive_reader.py`). Read at runtime, because
 * `shared/` is outside the UI image's build context.
 */
function loadThreadIndexVector(): ThreadIndexVector {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'shared', 'thread-index.json')
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')) as ThreadIndexVector
    if (dirname(dir) === dir) throw new Error(`shared/thread-index.json not found above ${process.cwd()}`)
  }
}

describe('threadIndexGuid', () => {
  it('reads the conversation GUID in byte order', () => {
    expect(threadIndexGuid(threadIndex(GUID))).toBe('a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf')
  })

  it('gives every reply of the conversation the same GUID', () => {
    expect(threadIndexGuid(threadIndex(GUID, 3))).toBe(threadIndexGuid(threadIndex(GUID)))
  })

  it('agrees with the archive bytes of PR_CONVERSATION_INDEX', () => {
    const bytes = Uint8Array.from(atob(threadIndex(GUID, 1)), (c) => c.charCodeAt(0))
    expect(threadIndexGuidFromBytes(bytes)).toBe(threadIndexGuid(threadIndex(GUID, 1)))
  })

  it('gives the archive and the header of one conversation the same GUID (shared/thread-index.json)', () => {
    const vector = loadThreadIndexVector()
    const archived = Uint8Array.from(vector.bytesHex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
    expect(threadIndexGuid(vector.conversationIndexBase64)).toBe(vector.guid)
    expect(threadIndexGuid(vector.childOfBase64)).toBe(vector.guid)
    expect(threadIndexGuidFromBytes(archived)).toBe(vector.guid)
  })

  it('is null for anything malformed, never an error', () => {
    for (const value of [null, '', 'not base64!', btoa('short'), threadIndex(Array(16).fill(0)), '====']) {
      expect(threadIndexGuid(value), String(value)).toBeNull()
    }
  })
})

const NOW = new Date('2026-10-14T07:12:00Z')

function message(overrides: Partial<ThreadingMessage> = {}): ThreadingMessage {
  return {
    messageId: 'new@statik-weber.at',
    inReplyTo: [],
    references: [],
    threadIndexGuid: null,
    baseSubject: 'stellplatznachweis',
    participants: ['weber@statik-weber.at', 'berger@berger-architektur.at'],
    sentAt: NOW,
    ...overrides,
  }
}

function thread(overrides: Partial<ThreadCandidate> = {}): ThreadCandidate {
  return {
    threadId: '00000000-0000-4000-8000-000000000001',
    baseSubject: 'stellplatznachweis',
    threadIndexGuid: 'a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf',
    receivedIds: ['root@berger-architektur.at'],
    referencedIds: ['ancestor@ma37.wien.gv.at'],
    participants: ['berger@berger-architektur.at'],
    lastEntryAt: new Date(NOW.getTime() - 3 * DAY),
    ...overrides,
  }
}

describe('matchThread', () => {
  it('matches by a reference to a received id with an equal subject', () => {
    expect(matchThread(message({ inReplyTo: ['root@berger-architektur.at'] }), [thread()])).toEqual([
      { threadId: thread().threadId, strength: 'reference', headers: ['in-reply-to'] },
    ])
  })

  it('records every header the reference rests on', () => {
    const match = matchThread(
      message({ inReplyTo: ['root@berger-architektur.at'], references: ['x@y.at', 'root@berger-architektur.at'] }),
      [thread()]
    )
    expect(match[0].headers).toEqual(['in-reply-to', 'references'])
  })

  it('calls a reference under a new subject reference_subject_changed', () => {
    const [match] = matchThread(
      message({ references: ['root@berger-architektur.at'], baseSubject: 'neues thema' }),
      [thread()]
    )
    expect(match.strength).toBe('reference_subject_changed')
  })

  it('falls back to the Thread-Index GUID only with an equal subject', () => {
    const guid = thread().threadIndexGuid
    expect(matchThread(message({ threadIndexGuid: guid }), [thread()])[0]).toMatchObject({
      strength: 'thread_index',
      headers: ['thread-index'],
    })
    // The hostile corpus: a forged Thread-Index with another subject is no candidate.
    expect(matchThread(message({ threadIndexGuid: guid, baseSubject: 'zahlung' }), [thread()])).toEqual([])
  })

  it('matches by subject only with a shared participant within sixty days', () => {
    expect(matchThread(message(), [thread()])[0].strength).toBe('subject')
    expect(matchThread(message({ participants: ['x@other.at'] }), [thread()])).toEqual([])
    expect(matchThread(message(), [thread({ lastEntryAt: new Date(NOW.getTime() - 61 * DAY) })])).toEqual([])
    expect(matchThread(message(), [thread({ lastEntryAt: null })])).toEqual([])
  })

  it('never matches an empty subject by subject', () => {
    expect(matchThread(message({ baseSubject: '' }), [thread({ baseSubject: '' })])).toEqual([])
  })

  it('offers a reply that cites only an ancestor known by quotation at subject strength', () => {
    const [match] = matchThread(message({ references: ['ancestor@ma37.wien.gv.at'], participants: [] }), [thread()])
    expect(match).toMatchObject({ strength: 'subject', headers: ['subject'] })
  })

  it('does not count the mail’s own Message-ID as a reference', () => {
    const own = 'root@berger-architektur.at'
    const matches = matchThread(message({ messageId: own, inReplyTo: [own], participants: [] }), [thread()])
    expect(matches).toEqual([])
  })

  it('orders strongest first, then most recently active', () => {
    const a = thread({ threadId: 'a', receivedIds: [], lastEntryAt: new Date(NOW.getTime() - 9 * DAY) })
    const b = thread({ threadId: 'b', receivedIds: [], lastEntryAt: new Date(NOW.getTime() - 1 * DAY) })
    const c = thread({ threadId: 'c', receivedIds: ['r@x.at'], threadIndexGuid: null })
    const ranked = matchThread(message({ inReplyTo: ['r@x.at'], threadIndexGuid: null }), [a, b, c])
    expect(ranked.map((m) => [m.threadId, m.strength])).toEqual([
      ['c', 'reference'],
      ['b', 'subject'],
      ['a', 'subject'],
    ])
  })
})

function sender(overrides: Partial<SenderEvidence> = {}): SenderEvidence {
  return {
    senderTrust: 'external_verified',
    senderFlags: [],
    signedHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'],
    ...overrides,
  }
}

const referenceMatch: ThreadMatch = { threadId: 't', strength: 'reference', headers: ['in-reply-to'] }

describe('threadPreselection: the matrix', () => {
  const strengths: ThreadMatchStrength[] = ['reference', 'thread_index', 'reference_subject_changed', 'subject']
  const headersOf: Record<ThreadMatchStrength, ThreadMatch['headers']> = {
    reference: ['references'],
    thread_index: ['thread-index'],
    reference_subject_changed: ['references'],
    subject: ['subject'],
  }

  /** The decision's matrix, written out: which (strength, trust, header signed) pre-select. */
  function expected(strength: ThreadMatchStrength, trust: SenderTrust, signed: boolean): boolean {
    if (strength !== 'reference' && strength !== 'thread_index') return false
    if (trust === 'member_verified') return true
    return trust === 'external_verified' && signed
  }

  for (const strength of strengths)
    for (const trust of SENDER_TRUSTS)
      for (const signed of [true, false]) {
        it(`${strength} · ${trust} · header ${signed ? 'signed' : 'unsigned'}`, () => {
          const match = { threadId: 't', strength, headers: headersOf[strength] }
          const signedHeaders = ['from', 'subject', 'date', 'message-id', ...(signed ? headersOf[strength] : [])]
          const result = threadPreselection(match, sender({ senderTrust: trust, signedHeaders }))
          expect(result.preselected).toBe(expected(strength, trust, signed))
          expect(result.blocks.length === 0).toBe(result.preselected)
        })
      }

  it('names its reasons from the closed list', () => {
    const { blocks } = threadPreselection(
      { threadId: 't', strength: 'subject', headers: ['subject'] },
      sender({ senderTrust: 'external_unverified', senderFlags: ['stale_date', 'date_out_of_range'] })
    )
    expect(blocks).toEqual(['weak_match', 'sender_not_verified', 'stale_date', 'date_out_of_range'])
    for (const block of blocks) expect(PRESELECTION_BLOCKS).toContain(block)
  })

  it('compares signed header names in any case', () => {
    expect(threadPreselection(referenceMatch, sender({ signedHeaders: ['IN-REPLY-TO'] })).preselected).toBe(true)
  })

  it.each(['not_addressed_to_project', 'stale_date', 'date_out_of_range'])(
    'never pre-selects a %s mail, even a member’s',
    (flag) => {
      const result = threadPreselection(referenceMatch, sender({ senderTrust: 'member_verified', senderFlags: [flag] }))
      expect(result).toEqual({ preselected: false, blocks: [flag] })
    }
  )

  it('pre-selects a member’s own Bcc copy like any member mail', () => {
    const bcc = sender({ senderTrust: 'member_verified', senderFlags: ['not_addressed_to_project', 'bcc_own'] })
    expect(threadPreselection(referenceMatch, bcc).preselected).toBe(true)
  })

  it('does not take a Bcc flag from anyone but a verified member', () => {
    const forged = sender({ senderTrust: 'member_unverified', senderFlags: ['not_addressed_to_project', 'bcc_own'] })
    expect(threadPreselection(referenceMatch, forged).blocks).toEqual(['sender_not_verified', 'not_addressed_to_project'])
  })

  it('does not pre-select a forged In-Reply-To from an unverified stranger', () => {
    expect(threadPreselection(referenceMatch, sender({ senderTrust: 'external_unverified' })).preselected).toBe(false)
  })

  it('does not pre-select References added outside h= by a verified stranger', () => {
    const outsideSignature = sender({ signedHeaders: ['from', 'subject', 'date', 'message-id', 'to'] })
    expect(threadPreselection(referenceMatch, outsideSignature)).toEqual({
      preselected: false,
      blocks: ['header_not_signed'],
    })
  })
})

describe('senderPreselectionBlocks', () => {
  it('is empty for a verified sender without flags', () => {
    expect(senderPreselectionBlocks(sender())).toEqual([])
    expect(senderPreselectionBlocks(sender({ senderTrust: 'member_verified' }))).toEqual([])
  })

  it('ignores flags it does not know', () => {
    expect(senderPreselectionBlocks(sender({ senderFlags: ['message_id_reused', 'something_new'] }))).toEqual([])
  })
})

describe('appendNeedsAcknowledgement (the unverified_thread rule)', () => {
  it('needs none for a pre-selectable append', () => {
    expect(appendNeedsAcknowledgement(sender(), referenceMatch)).toBe(false)
  })

  it('needs one for any sender that keeps candidates unchecked', () => {
    expect(appendNeedsAcknowledgement(sender({ senderTrust: 'external_unverified' }), undefined)).toBe(true)
    expect(appendNeedsAcknowledgement(sender({ senderFlags: ['stale_date'] }), referenceMatch)).toBe(true)
  })

  it('needs one when the append rests on a header the stranger’s domain did not sign', () => {
    expect(appendNeedsAcknowledgement(sender({ signedHeaders: ['from'] }), referenceMatch)).toBe(true)
  })

  it('needs none when a qualifying sender’s mail is put where the person chose', () => {
    expect(appendNeedsAcknowledgement(sender({ signedHeaders: ['from'] }), undefined)).toBe(false)
    const subject: ThreadMatch = { threadId: 't', strength: 'subject', headers: ['subject'] }
    expect(appendNeedsAcknowledgement(sender({ signedHeaders: ['from'] }), subject)).toBe(false)
  })
})

describe('clampSentAt', () => {
  const received = new Date('2026-10-14T07:14:00Z')

  it('believes a Date within thirty days before receipt', () => {
    const sent = new Date('2026-10-14T07:12:00Z')
    expect(clampSentAt(sent, received)).toEqual({ sentAt: sent, outOfRange: false })
    const early = new Date(received.getTime() - 30 * DAY)
    expect(clampSentAt(early, received)).toEqual({ sentAt: early, outOfRange: false })
  })

  it('puts a Date from a clock up to fifteen minutes fast at the receipt, without flagging it', () => {
    const minute = 60_000
    expect(SENT_AT_CLOCK_SKEW_MINUTES).toBe(15)
    expect(clampSentAt(new Date(received.getTime() + 1), received)).toEqual({ sentAt: received, outOfRange: false })
    expect(clampSentAt(new Date(received.getTime() + 15 * minute), received)).toEqual({
      sentAt: received,
      outOfRange: false,
    })
  })

  it('puts a Date further in the future at the receipt, flagged', () => {
    expect(clampSentAt(new Date('2027-01-01T00:00:00Z'), received)).toEqual({ sentAt: received, outOfRange: true })
    expect(clampSentAt(new Date(received.getTime() + 15 * 60_000 + 1), received)).toEqual({
      sentAt: received,
      outOfRange: true,
    })
  })

  it('puts a Date older than thirty days at the receipt', () => {
    expect(clampSentAt(new Date(received.getTime() - 30 * DAY - 1), received).outOfRange).toBe(true)
  })

  it('puts a missing or invalid Date at the receipt', () => {
    expect(clampSentAt(null, received)).toEqual({ sentAt: received, outOfRange: true })
    expect(clampSentAt(new Date('nonsense'), received)).toEqual({ sentAt: received, outOfRange: true })
  })
})

describe('domainOf', () => {
  it('lower-cases the part after the last @ and drops a trailing dot', () => {
    expect(domainOf('Weber@Statik-Weber.AT.')).toBe('statik-weber.at')
    expect(domainOf('"a@b"@ma37.wien.gv.at')).toBe('ma37.wien.gv.at')
    expect(domainOf('nobody')).toBeNull()
    expect(domainOf('x@')).toBeNull()
  })

  it('gives an internationalized domain one form, whichever spelling the mail used', () => {
    // RFC 6532 lets a header carry the U-label; DNS, DKIM `d=` and most clients write the A-label.
    expect(domainOf('mueller@müller.at')).toBe('xn--mller-kva.at')
    expect(domainOf('mueller@xn--mller-kva.at')).toBe('xn--mller-kva.at')
    expect(domainOf('Mueller@MÜLLER.AT')).toBe('xn--mller-kva.at')
    expect(domainOf('<mueller@XN--MLLER-KVA.AT.>')).toBe('xn--mller-kva.at')
    // UTS #46 folds width too: a full-width spelling is the same name, not a look-alike that passes.
    expect(domainOf('a@ｍüller.at')).toBe('xn--mller-kva.at')
    expect(domainOf('a@bücher.straße.de')).toBe(domainOf('a@xn--bcher-kva.xn--strae-oqa.de'))
  })

  it('keeps what is not a host name as it was, lower-cased, so it matches only itself', () => {
    expect(domainOf('a@[192.0.2.1]')).toBe('[192.0.2.1]')
    expect(domainOf('a@1.2.3')).toBe('1.2.3')
    expect(domainOf('a@exa mple.at')).toBe('exa mple.at')
    expect(domainOf('a@evil.at/x.example')).toBe('evil.at/x.example')
    expect(domainOf('a@xn--zz')).toBe('xn--zz')
  })
})
