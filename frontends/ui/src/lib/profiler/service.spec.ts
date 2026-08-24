/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
  insertSpans: vi.fn(),
  listProfiledConversations: vi.fn(),
  getSpansForConversation: vi.fn(),
}))

import * as repository from './repository'
import { getConversationTimeline, listProfiledConversations, recordProfilerSpans } from './service'
import type { AgentProfilerSpan } from '@/lib/db/schema'

const mockInsertSpans = vi.mocked(repository.insertSpans)
const mockListProfiledConversations = vi.mocked(repository.listProfiledConversations)
const mockGetSpansForConversation = vi.mocked(repository.getSpansForConversation)

beforeEach(() => {
  vi.clearAllMocks()
})

function span(overrides: Partial<AgentProfilerSpan>): AgentProfilerSpan {
  return {
    id: 'row_1',
    organizationId: 'org_1',
    conversationId: 'conv_1',
    turnId: 'turn_1',
    jobId: null,
    spanId: 'span_1',
    parentSpanId: null,
    kind: 'turn',
    name: 'chat_researcher',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    endedAt: new Date('2026-01-01T00:00:01.000Z'),
    durationMs: 1000,
    status: 'ok',
    errorMessage: null,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:01.000Z'),
    ...overrides,
  }
}

describe('recordProfilerSpans', () => {
  it('delegates straight to the repository', async () => {
    mockInsertSpans.mockResolvedValue(3)
    const spans = [span({})]
    const recorded = await recordProfilerSpans(spans)
    expect(mockInsertSpans).toHaveBeenCalledWith(spans)
    expect(recorded).toBe(3)
  })
})

describe('listProfiledConversations', () => {
  it('maps repository rows and passes through the search query + capped flag', async () => {
    mockListProfiledConversations.mockResolvedValue({
      capped: true,
      rows: [
        {
          conversationId: 'conv_1',
          organizationId: 'org_1',
          title: 'Bauantrag Wien',
          turnCount: 2,
          totalDurationMs: 4200,
          lastActiveAt: new Date('2026-01-01T00:00:02.000Z'),
        },
      ],
    })

    const result = await listProfiledConversations('bauantrag')

    expect(mockListProfiledConversations).toHaveBeenCalledWith('bauantrag')
    expect(result.capped).toBe(true)
    expect(result.conversations).toEqual([
      {
        conversationId: 'conv_1',
        organizationId: 'org_1',
        title: 'Bauantrag Wien',
        turnCount: 2,
        totalDurationMs: 4200,
        lastActiveAt: '2026-01-01T00:00:02.000Z',
      },
    ])
  })
})

describe('getConversationTimeline', () => {
  it('builds a nested span tree per turn, root = span with no parent', async () => {
    mockGetSpansForConversation.mockResolvedValue([
      span({ spanId: 'root', parentSpanId: null, kind: 'turn', name: 'chat_researcher', durationMs: 500 }),
      span({
        spanId: 'node_1',
        parentSpanId: 'root',
        kind: 'node',
        name: 'intent_classifier',
        durationMs: 120,
        startedAt: new Date('2026-01-01T00:00:00.100Z'),
      }),
      span({
        spanId: 'llm_1',
        parentSpanId: 'node_1',
        kind: 'llm',
        name: 'vendor/model',
        durationMs: 80,
        startedAt: new Date('2026-01-01T00:00:00.150Z'),
      }),
    ])

    const timeline = await getConversationTimeline('conv_1')

    expect(mockGetSpansForConversation).toHaveBeenCalledWith('conv_1')
    expect(timeline.conversationId).toBe('conv_1')
    expect(timeline.turns).toHaveLength(1)

    const turn = timeline.turns[0]
    expect(turn.turnId).toBe('turn_1')
    expect(turn.durationMs).toBe(500)
    expect(turn.status).toBe('ok')
    expect(turn.spanCount).toBe(3)
    expect(turn.root?.spanId).toBe('root')
    expect(turn.root?.children).toHaveLength(1)
    expect(turn.root?.children[0].spanId).toBe('node_1')
    expect(turn.root?.children[0].children).toHaveLength(1)
    expect(turn.root?.children[0].children[0].spanId).toBe('llm_1')
  })

  it('groups spans into separate turns and orders turns by start time', async () => {
    mockGetSpansForConversation.mockResolvedValue([
      span({
        spanId: 'root_b',
        turnId: 'turn_b',
        parentSpanId: null,
        startedAt: new Date('2026-01-01T00:05:00.000Z'),
      }),
      span({
        spanId: 'root_a',
        turnId: 'turn_a',
        parentSpanId: null,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ])

    const timeline = await getConversationTimeline('conv_1')

    expect(timeline.turns.map((t) => t.turnId)).toEqual(['turn_a', 'turn_b'])
  })

  it('marks a turn errored when any of its spans failed, even without a root', async () => {
    mockGetSpansForConversation.mockResolvedValue([
      span({ spanId: 'orphan', parentSpanId: 'missing-parent', kind: 'tool', status: 'error', durationMs: 50 }),
    ])

    const timeline = await getConversationTimeline('conv_1')

    const turn = timeline.turns[0]
    expect(turn.root).toBeNull()
    expect(turn.status).toBe('error')
    expect(turn.spanCount).toBe(1)
  })
})
