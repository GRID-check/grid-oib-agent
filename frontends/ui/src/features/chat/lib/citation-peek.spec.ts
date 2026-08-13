import { describe, expect, it } from 'vitest'
import type { CitationSource } from '../types'
import type { ChatMessage } from '../types'
import { buildCitationModel } from './citations'
import {
  latestFinishedAssistantMessage,
  peekableCitedFile,
  peekableFileForMessage,
} from './citation-peek'

const cited = (overrides: Partial<CitationSource> = {}): CitationSource => ({
  id: overrides.id ?? 'c1',
  content: overrides.content ?? 'Plan.pdf, p.1',
  timestamp: new Date(0),
  isCited: true,
  kind: 'projekt',
  fileName: 'Plan.pdf',
  collection: 'proj_abc',
  page: 1,
  ...overrides,
})

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  messageType: 'agent_response',
  content: 'Die Fluchtweglänge beträgt 34 m.',
  timestamp: new Date(0),
  ...overrides,
})

describe('peekableCitedFile', () => {
  it('returns the one cited project file', () => {
    const docs = buildCitationModel({ citations: [cited()] })
    expect(peekableCitedFile(docs)).toEqual({
      fileName: 'Plan.pdf',
      source: 'projekt',
      title: 'Plan',
    })
  })

  it('returns the one cited Büro file', () => {
    const docs = buildCitationModel({
      citations: [cited({ kind: 'buero', collection: 'archiv_xyz', fileName: 'Referenz.pdf' })],
    })
    expect(peekableCitedFile(docs)?.source).toBe('buero')
    expect(peekableCitedFile(docs)?.fileName).toBe('Referenz.pdf')
  })

  it('does not peek law, RIS, or web citations', () => {
    const docs = buildCitationModel({
      citations: [
        cited({
          id: 'oib',
          kind: 'baurecht',
          collection: 'oib_knowledge',
          fileName: 'oib-rl_2.pdf',
          content: 'oib-rl_2.pdf, p.5',
        }),
        cited({
          id: 'web',
          kind: 'web',
          fileName: undefined,
          url: 'https://example.com',
          content: 'https://example.com',
        }),
      ],
    })
    expect(peekableCitedFile(docs)).toBeNull()
  })

  it('does not peek when two project/Büro files are cited', () => {
    const docs = buildCitationModel({
      citations: [
        cited({ id: 'a', fileName: 'A.pdf' }),
        cited({ id: 'b', kind: 'buero', collection: 'archiv_x', fileName: 'B.pdf' }),
      ],
    })
    expect(peekableCitedFile(docs)).toBeNull()
  })

  it('does not peek an uncited retrieved project file', () => {
    const docs = buildCitationModel({
      citations: [cited({ isCited: false })],
    })
    expect(peekableCitedFile(docs)).toBeNull()
  })

  it('still peeks when the same file is cited at several pages', () => {
    const docs = buildCitationModel({
      citations: [cited({ id: 'p1', page: 1 }), cited({ id: 'p2', page: 4, content: 'Plan.pdf, p.4' })],
    })
    expect(peekableCitedFile(docs)?.fileName).toBe('Plan.pdf')
  })

  it('ignores a cited law document sitting next to one project file', () => {
    const docs = buildCitationModel({
      citations: [
        cited(),
        cited({
          id: 'oib',
          kind: 'baurecht',
          collection: 'oib_knowledge',
          fileName: 'oib-rl_2.pdf',
          content: 'oib-rl_2.pdf, p.5',
        }),
      ],
    })
    expect(peekableCitedFile(docs)?.fileName).toBe('Plan.pdf')
  })

  it('does not peek a nameless cited project document (still counts as the one)', () => {
    const docs = buildCitationModel({
      citations: [cited({ fileName: undefined, content: 'Projektwissen', collection: undefined })],
    })
    expect(peekableCitedFile(docs)).toBeNull()
  })
})

describe('latestFinishedAssistantMessage', () => {
  it('returns the latest finished agent_response', () => {
    const finished = message({ id: 'done' })
    expect(latestFinishedAssistantMessage([message({ id: 'user', role: 'user', messageType: 'user' }), finished])).toBe(
      finished,
    )
  })

  it('returns null while the latest answer is still streaming', () => {
    expect(
      latestFinishedAssistantMessage([
        message({ id: 'old' }),
        message({ id: 'live', isStreaming: true, citations: [cited()] }),
      ]),
    ).toBeNull()
  })

  it('skips non-answer assistant messages', () => {
    const answer = message({ id: 'ans' })
    expect(
      latestFinishedAssistantMessage([
        answer,
        message({ id: 'status', messageType: 'status', content: 'thinking' }),
      ]),
    ).toBe(answer)
  })
})

describe('peekableFileForMessage', () => {
  it('reads structured citations on the message', () => {
    expect(peekableFileForMessage(message({ citations: [cited()] }))?.fileName).toBe('Plan.pdf')
  })

  it('does not peek a finished answer with no project/Büro citation', () => {
    expect(peekableFileForMessage(message())).toBeNull()
  })
})
