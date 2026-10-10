/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
  insertSpans: vi.fn(),
  listProfiledConversations: vi.fn(),
  findProfiledConversation: vi.fn(),
  getSpansForConversation: vi.fn(),
}))

vi.mock('@/lib/organizations/display-names', () => ({
  getOrganizationDisplayNames: vi.fn(async (ids: Iterable<string | null>) => {
    const known: Record<string, string> = { org_1: 'Bauwerk GmbH' }
    return new Map(
      [...ids].flatMap((id) => (id && known[id] ? [[id, known[id]] as [string, string]] : []))
    )
  }),
}))

import * as repository from './repository'
import { getConversationTimeline, listProfiledConversations, recordProfilerSpans } from './service'
import type { AgentProfilerSpan } from '@/lib/db/schema'
import type { QualityScope } from '@/lib/quality/scope'

const mockInsertSpans = vi.mocked(repository.insertSpans)
const mockListProfiledConversations = vi.mocked(repository.listProfiledConversations)
const mockFindProfiledConversation = vi.mocked(repository.findProfiledConversation)
const mockGetSpansForConversation = vi.mocked(repository.getSpansForConversation)

const SEPTEMBER: QualityScope = {
  from: '2026-09-01',
  to: '2026-09-30',
  organizationIds: [],
  projectIds: [],
}
/** The repository filter `SEPTEMBER` stands for. */
const SEPTEMBER_FILTER = {
  start: new Date('2026-09-01T00:00:00.000Z'),
  endExclusive: new Date('2026-10-01T00:00:00.000Z'),
  organizationIds: [],
  projectIds: [],
}

const row = (conversationId: string, organizationId: string | null = 'org_1') => ({
  conversationId,
  organizationId,
  title: null,
  titleWithheld: false,
  turnCount: 1,
  totalDurationMs: 10,
  lastActiveAt: new Date('2026-09-02T00:00:00.000Z'),
})

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
          titleWithheld: false,
          turnCount: 2,
          totalDurationMs: 4200,
          lastActiveAt: new Date('2026-01-01T00:00:02.000Z'),
        },
      ],
    })

    const result = await listProfiledConversations(SEPTEMBER, { query: 'bauantrag' })

    expect(mockListProfiledConversations).toHaveBeenCalledWith(SEPTEMBER_FILTER, 'bauantrag')
    // Nothing was asked about one conversation, so nothing is answered.
    expect(mockFindProfiledConversation).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('selected')
    expect(result.capped).toBe(true)
    expect(result.conversations).toEqual([
      {
        conversationId: 'conv_1',
        organizationId: 'org_1',
        organizationName: 'Bauwerk GmbH',
        title: 'Bauantrag Wien',
        titleWithheld: false,
        turnCount: 2,
        totalDurationMs: 4200,
        lastActiveAt: '2026-01-01T00:00:02.000Z',
      },
    ])
  })

  it('leaves the name null for an unattributed or unresolvable organization', async () => {
    mockListProfiledConversations.mockResolvedValue({
      capped: false,
      rows: [
        {
          conversationId: 'conv_2',
          organizationId: null,
          title: null,
          titleWithheld: false,
          turnCount: 1,
          totalDurationMs: 10,
          lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          conversationId: 'conv_3',
          organizationId: 'org_gone',
          title: null,
          titleWithheld: false,
          turnCount: 1,
          totalDurationMs: 10,
          lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    })

    const result = await listProfiledConversations(SEPTEMBER)
    expect(result.conversations.map((entry) => entry.organizationName)).toEqual([null, null])
  })

  it('turns the scope into UTC day bounds plus the id lists', async () => {
    mockListProfiledConversations.mockResolvedValue({ capped: false, rows: [] })
    await listProfiledConversations({
      ...SEPTEMBER,
      organizationIds: ['org_1'],
      projectIds: ['p_1'],
    })
    expect(mockListProfiledConversations).toHaveBeenCalledWith(
      { ...SEPTEMBER_FILTER, organizationIds: ['org_1'], projectIds: ['p_1'] },
      undefined
    )
  })

  it('answers whether the asked-about conversation is in the scope, named like the list', async () => {
    mockListProfiledConversations.mockResolvedValue({ capped: true, rows: [row('conv_1')] })
    mockFindProfiledConversation.mockResolvedValue(row('conv_far'))
    const inScope = await listProfiledConversations(SEPTEMBER, {
      query: 'x',
      conversationId: 'conv_far',
    })
    // Asked of the scope alone: the search narrows the list, not membership.
    expect(mockFindProfiledConversation).toHaveBeenCalledWith(SEPTEMBER_FILTER, 'conv_far')
    expect(inScope.selected).toMatchObject({
      conversationId: 'conv_far',
      organizationName: 'Bauwerk GmbH',
    })

    mockFindProfiledConversation.mockResolvedValue(null)
    const outOfScope = await listProfiledConversations(SEPTEMBER, { conversationId: 'conv_old' })
    expect(outOfScope.selected).toBeNull()
  })
})

/** The repository result for a conversation whose whole history was loaded. */
const loaded = (spans: AgentProfilerSpan[]) => ({
  spans,
  totalTurns: new Set(spans.map((entry) => entry.turnId)).size,
  capped: false,
})

describe('getConversationTimeline', () => {
  it('builds a nested span tree per turn, root = span with no parent', async () => {
    mockGetSpansForConversation.mockResolvedValue(
      loaded([
        span({
          spanId: 'root',
          parentSpanId: null,
          kind: 'turn',
          name: 'chat_researcher',
          durationMs: 500,
        }),
        span({
          spanId: 'node_1',
          parentSpanId: 'root',
          kind: 'node',
          name: 'shallow_research_agent',
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
    )

    const timeline = await getConversationTimeline('conv_1')

    expect(mockGetSpansForConversation).toHaveBeenCalledWith('conv_1')
    expect(timeline.conversationId).toBe('conv_1')
    expect(timeline.turns).toHaveLength(1)

    const turn = timeline.turns[0]
    expect(turn.turnId).toBe('turn_1')
    expect(turn.durationMs).toBe(500)
    expect(turn.status).toBe('ok')
    expect(turn.spanCount).toBe(3)
    expect(turn.root.spanId).toBe('root')
    expect(turn.root.children).toHaveLength(1)
    expect(turn.root.children[0].spanId).toBe('node_1')
    expect(turn.root.children[0].children).toHaveLength(1)
    expect(turn.root.children[0].children[0].spanId).toBe('llm_1')
  })

  it('groups spans into separate turns and orders turns by start time', async () => {
    mockGetSpansForConversation.mockResolvedValue(
      loaded([
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
    )

    const timeline = await getConversationTimeline('conv_1')

    expect(timeline.turns.map((t) => t.turnId)).toEqual(['turn_a', 'turn_b'])
  })

  it('passes the bound through: total turns and whether older ones were left out', async () => {
    mockGetSpansForConversation.mockResolvedValue({
      spans: [span({})],
      totalTurns: 80,
      capped: true,
    })

    const timeline = await getConversationTimeline('conv_1')
    expect(timeline.totalTurns).toBe(80)
    expect(timeline.capped).toBe(true)
  })

  it('picks the earliest turn span as root when several spans have no parent, and keeps the rest', async () => {
    // Regression: the LAST parentless span in row order became the root, and
    // every other parentless span vanished from the tree.
    const spans = [
      span({
        spanId: 'late_tool',
        parentSpanId: null,
        kind: 'tool',
        startedAt: new Date('2026-01-01T00:00:00.500Z'),
      }),
      span({
        spanId: 'turn_root',
        parentSpanId: null,
        kind: 'turn',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      span({
        spanId: 'retry_root',
        parentSpanId: null,
        kind: 'turn',
        startedAt: new Date('2026-01-01T00:00:00.200Z'),
      }),
    ]
    for (const order of [spans, [...spans].reverse()]) {
      mockGetSpansForConversation.mockResolvedValue(loaded(order))
      const turn = (await getConversationTimeline('conv_1')).turns[0]
      expect(turn.root.spanId).toBe('turn_root')
      expect(turn.root.children.map((child) => child.spanId)).toEqual(['retry_root', 'late_tool'])
    }
  })

  it('keeps a span whose parent is missing from the ledger, under the root', async () => {
    mockGetSpansForConversation.mockResolvedValue(
      loaded([
        span({ spanId: 'root', parentSpanId: null }),
        span({
          spanId: 'orphan',
          parentSpanId: 'lost',
          kind: 'tool',
          startedAt: new Date('2026-01-01T00:00:00.300Z'),
        }),
      ])
    )

    const turn = (await getConversationTimeline('conv_1')).turns[0]
    expect(turn.root.children.map((child) => child.spanId)).toEqual(['orphan'])
  })

  it('never builds an infinite tree from a parent cycle', async () => {
    mockGetSpansForConversation.mockResolvedValue(
      loaded([
        span({ spanId: 'root', parentSpanId: null }),
        span({
          spanId: 'a',
          parentSpanId: 'b',
          kind: 'node',
          startedAt: new Date('2026-01-01T00:00:00.100Z'),
        }),
        span({
          spanId: 'b',
          parentSpanId: 'a',
          kind: 'node',
          startedAt: new Date('2026-01-01T00:00:00.200Z'),
        }),
        span({
          spanId: 'self',
          parentSpanId: 'self',
          kind: 'node',
          startedAt: new Date('2026-01-01T00:00:00.300Z'),
        }),
      ])
    )

    const timeline = await getConversationTimeline('conv_1')
    // Serializable at all is the point: a cycle used to make the response throw.
    expect(() => JSON.stringify(timeline)).not.toThrow()
    expect(timeline.turns[0].root.children.map((child) => child.spanId)).toEqual(['a', 'b', 'self'])
  })

  it('marks a turn errored when any of its spans failed, even without a root', async () => {
    mockGetSpansForConversation.mockResolvedValue(
      loaded([
        span({
          spanId: 'orphan',
          parentSpanId: 'missing-parent',
          kind: 'tool',
          status: 'error',
          durationMs: 50,
        }),
      ])
    )

    const timeline = await getConversationTimeline('conv_1')

    const turn = timeline.turns[0]
    expect(turn.status).toBe('error')
    expect(turn.spanCount).toBe(1)
  })

  it('gives a turn whose root span was lost a synthetic root spanning its spans', async () => {
    // Regression: root was null while spanCount > 0, so the timeline showed a
    // turn with spans and no tree to show them in.
    mockGetSpansForConversation.mockResolvedValue(
      loaded([
        span({
          spanId: 'tool_1',
          parentSpanId: 'lost-root',
          kind: 'tool',
          startedAt: new Date('2026-01-01T00:00:01.000Z'),
          endedAt: new Date('2026-01-01T00:00:02.000Z'),
        }),
        span({
          spanId: 'llm_1',
          parentSpanId: 'lost-root',
          kind: 'llm',
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          endedAt: new Date('2026-01-01T00:00:01.500Z'),
        }),
      ])
    )

    const turn = (await getConversationTimeline('conv_1')).turns[0]
    expect(turn.root).toMatchObject({
      spanId: 'turn_1:root',
      kind: 'turn',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 2000,
      metadata: { synthetic: true },
    })
    expect(turn.root.children.map((child) => child.spanId)).toEqual(['llm_1', 'tool_1'])
    expect(turn.durationMs).toBe(2000)
  })
})
