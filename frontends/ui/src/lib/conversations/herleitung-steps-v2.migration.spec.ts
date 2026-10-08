/**
 * Migration 0097 against a real Postgres: stored Herleitung steps in the
 * pre-v2 shape become the chat wire v2 shape, the dropped kinds are gone, the
 * result is exactly what `sanitizeProvenance` accepts, a re-run changes
 * nothing, and the down migration gives the old readers their shape back.
 *
 * Opt-in. It needs a database migrated up to, and not including, 0097, as its
 * owner, because the rows under test cannot be written by the v2 build:
 *
 *   GRID_TEST_MIGRATION_DATABASE_URL=postgres://grid_app_owner@host:port/grid_steps \
 *     npx vitest run src/lib/conversations/herleitung-steps-v2.migration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The rows are the shape the pre-v2 browser wrote: `stripThinkingStepsForStorage`
 * (prune-message-for-storage.ts) built each step from what
 * `use-websocket-chat.ts` put in the store (`parseFunctionName`,
 * `mapFunctionToCategory`, `getDisplayName`, uuid ids), and `sanitizeProvenance`
 * bounded it to `{id, userMessageId, functionName, displayName, category,
 * timestamp, isComplete, isTopLevel?, traceLanes?, turnEvent?}`. The names are
 * the ones the agent emitted: NAT function names, `status:<slot>` and
 * `skill:<name>` custom steps, `clarifier_agent`, model ids from the LangChain
 * profiler, and the `Tool:`-prefixed sub-calls.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sanitizeProvenance } from './message-provenance'

const url = process.env.GRID_TEST_MIGRATION_DATABASE_URL

const ORG = 'org_steps_v2'
const CONVERSATION = 's_steps_v2'
const USER_MESSAGE = 'msg_1759000000000_3'
const AT = '2026-09-20T08:15:02.114Z'

const migration = (name: string): string =>
  readFileSync(path.join(process.cwd(), 'drizzle', name), 'utf-8')

const lanes = [
  {
    key: 'baurecht_oib',
    label: 'OIB-Richtlinie',
    kind: 'baurecht',
    hitCount: 2,
    signal: 'law',
    sources: [
      {
        name: 'oib-rl_2_ausgabe_mai_2023.pdf',
        title: 'OIB-Richtlinie 2',
        detail: 'Pkt. 5.1.1 p.12',
        shelf: 'base',
        round: 0,
      },
    ],
  },
]
const webLanes = [
  {
    key: 'web',
    label: 'Web',
    kind: 'web',
    hitCount: 1,
    signal: 'web',
    sources: [{ name: 'https://www.ris.bka.gv.at/x' }],
  },
]

/** One pre-v2 step, as the old browser stored it. */
const old = (id: string, functionName: string, extra: Record<string, unknown> = {}) => ({
  id,
  userMessageId: USER_MESSAGE,
  functionName,
  displayName: '',
  category: 'agents',
  timestamp: AT,
  isComplete: true,
  ...extra,
})

/** One v2 step, as the fold writes it. */
const v2 = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  userMessageId: USER_MESSAGE,
  timestamp: AT,
  isComplete: true,
  kind,
  ...extra,
})

const retrievalEvent = {
  key: 'status.retrieval.withQuery',
  values: { corpus: 'knowledge', query: 'Fluchtweglänge GK 4' },
  reason: 'Die Fluchtweglänge hängt an der Gebäudeklasse.',
  tools: ['knowledge_search'],
}

/** A whole shallow turn, every name family the old wire produced. */
const OLD_TURN = [
  old('a1', '<workflow>', {
    category: 'tasks',
    displayName: 'Workflow: Chat Researcher',
    isTopLevel: true,
  }),
  old('a2', 'status:documents', {
    category: 'tasks',
    turnEvent: { key: 'status.documents.project' },
  }),
  old('a3', 'skill_selection', { category: 'tools' }),
  old('a4', 'skill:oib-brandschutznachweis', { category: 'tools' }),
  old('a5', 'status:retrieval:0', { category: 'tasks', turnEvent: retrievalEvent }),
  old('a6', 'knowledge_search', { category: 'agents', isTopLevel: true, traceLanes: lanes }),
  old('a7', 'Tool: tavily_search', { category: 'agents', traceLanes: webLanes }),
  old('a8', 'openai/gpt-5.1', { isComplete: false }),
  old('a9', 'ifc_measure', { isTopLevel: true }),
  old('a10', 'status:checkpoint:0', { category: 'tasks' }),
  old('a11', 'clarifier_agent', { isTopLevel: true }),
  old('a12', 'shallow_research_agent', { isTopLevel: true }),
  old('a13', 'Status:Synthesis', { category: 'tasks', turnEvent: { key: 'status.synthesis' } }),
  old('a14', 'unknown', { displayName: 'Processing', isComplete: false }),
  old('a15', 'deep_research_agent', { isDeepResearch: true }),
  old('a16', 'web_search_tool', { isDeepResearch: true, isComplete: false }),
  old('a17', 'skill:', { category: 'tools' }),
  old('a18', 'chat_deepresearcher_agent', { isTopLevel: true }),
]

const V2_TURN = [
  v2('a2', 'status', { slot: 'documents', turnEvent: { key: 'status.documents.project' } }),
  v2('a4', 'skill', { skill: 'oib-brandschutznachweis' }),
  v2('a5', 'retrieval', { round: 0, turnEvent: retrievalEvent }),
  v2('a6', 'sources', { tool: 'knowledge_search', traceLanes: lanes }),
  v2('a7', 'sources', { tool: 'tavily_search', traceLanes: webLanes }),
  v2('a9', 'tool', { tool: 'ifc_measure' }),
  v2('a10', 'status', { slot: 'checkpoint:0' }),
  v2('a11', 'clarification'),
  v2('a13', 'status', { slot: 'Synthesis', turnEvent: { key: 'status.synthesis' } }),
  v2('a16', 'tool', { tool: 'web_search_tool', isComplete: false, scope: 'deep' }),
]

/** Message ids (uuid), one per case. */
const ID = {
  turn: 'a0000000-0000-4000-8000-000000000001',
  onlyDropped: 'a0000000-0000-4000-8000-000000000002',
  onlyStepsDropped: 'a0000000-0000-4000-8000-000000000003',
  alreadyV2: 'a0000000-0000-4000-8000-000000000004',
  noProvenance: 'a0000000-0000-4000-8000-000000000005',
  user: 'a0000000-0000-4000-8000-000000000006',
}

const ROWS: Array<{ id: string; role: string; metadata: Record<string, unknown> }> = [
  {
    id: ID.turn,
    role: 'assistant',
    metadata: {
      messageType: 'agent_response',
      cards: [{ type: 'memory_proposal' }],
      provenance: { thinkingSteps: OLD_TURN, answerConfidence: 'high', routingDecision: 'shallow' },
    },
  },
  {
    id: ID.onlyDropped,
    role: 'assistant',
    metadata: {
      provenance: {
        thinkingSteps: [
          old('b1', '<workflow>'),
          old('b2', 'nvidia/nvidia/Nemotron-3-Nano-30B-A3B'),
        ],
        answerConfidence: 'medium',
      },
    },
  },
  {
    id: ID.onlyStepsDropped,
    role: 'assistant',
    metadata: {
      messageType: 'agent_response',
      provenance: { thinkingSteps: [old('c1', 'skill_selection')] },
    },
  },
  {
    id: ID.alreadyV2,
    role: 'assistant',
    metadata: { provenance: { thinkingSteps: [v2('d1', 'tool', { tool: 'knowledge_search' })] } },
  },
  { id: ID.noProvenance, role: 'assistant', metadata: { messageType: 'agent_response' } },
  { id: ID.user, role: 'user', metadata: { messageType: 'user' } },
]

describe.skipIf(!url)('migration 0097: Herleitung steps v2, against live Postgres', () => {
  let db: postgres.Sql
  const metadataOf = async (id: string): Promise<Record<string, unknown>> => {
    const [row] = await db<
      { metadata: Record<string, unknown> }[]
    >`select metadata from messages where id = ${id}`
    return row.metadata
  }
  const stepsOf = async (id: string): Promise<unknown> =>
    ((await metadataOf(id)).provenance as { thinkingSteps?: unknown } | undefined)?.thinkingSteps
  const snapshot = async (): Promise<unknown[]> =>
    Array.from(await db`select id, metadata, xmin::text as version from messages order by id`)

  beforeAll(async () => {
    db = postgres(url as string, { prepare: false, max: 1, onnotice: () => {} })
    await db`insert into conversations (id, organization_id, created_by) values (${CONVERSATION}, ${ORG}, 'user_1')`
    for (const row of ROWS) {
      await db`
        insert into messages (id, conversation_id, organization_id, role, content, metadata)
        values (${row.id}, ${CONVERSATION}, ${ORG}, ${row.role}, 'Antwort', ${db.json(row.metadata as postgres.JSONValue)})`
    }
    await db.unsafe(migration('0097_herleitung_steps_v2.sql'))
  })

  afterAll(async () => {
    await db?.end()
  })

  it('rewrites a whole turn by the old readers’ rules, in order, dropping what v2 never produces', async () => {
    expect(await stepsOf(ID.turn)).toEqual(V2_TURN)
  })

  it('leaves every other metadata key alone', async () => {
    const metadata = await metadataOf(ID.turn)
    expect(metadata.messageType).toBe('agent_response')
    expect(metadata.cards).toEqual([{ type: 'memory_proposal' }])
    expect(metadata.provenance).toMatchObject({
      answerConfidence: 'high',
      routingDecision: 'shallow',
    })
  })

  it('writes exactly the shape sanitizeProvenance accepts, so nothing is lost on the next read', async () => {
    const provenance = (await metadataOf(ID.turn)).provenance
    expect(sanitizeProvenance(provenance)).toEqual(provenance)
  })

  it('stores no empty list: a provenance with only dropped steps loses the key, an empty one goes', async () => {
    expect(await metadataOf(ID.onlyDropped)).toEqual({ provenance: { answerConfidence: 'medium' } })
    expect(await metadataOf(ID.onlyStepsDropped)).toEqual({ messageType: 'agent_response' })
  })

  it('leaves a v2 row, a row without steps and a user message untouched', async () => {
    expect(await stepsOf(ID.alreadyV2)).toEqual([v2('d1', 'tool', { tool: 'knowledge_search' })])
    expect(await metadataOf(ID.noProvenance)).toEqual({ messageType: 'agent_response' })
    expect(await metadataOf(ID.user)).toEqual({ messageType: 'user' })
  })

  it('changes nothing when run again, and writes no row (xmin unchanged)', async () => {
    const before = await snapshot()
    await db.unsafe(migration('0097_herleitung_steps_v2.sql'))
    expect(await snapshot()).toEqual(before)
  })

  it('leaves no helper function behind', async () => {
    const [{ count }] = await db<{ count: number }[]>`
      select count(*)::int as count from pg_proc where proname like 'grid\\_0097\\_%'`
    expect(count).toBe(0)
  })

  it('down: gives the old readers their names back, and restores nothing that was dropped', async () => {
    await db.unsafe(migration('0097_herleitung_steps_v2.down.sql'))
    const steps = (await stepsOf(ID.turn)) as Array<Record<string, unknown>>
    expect(steps.map((step) => step.functionName)).toEqual([
      'status:documents',
      'skill:oib-brandschutznachweis',
      'status:retrieval:0',
      'knowledge_search',
      'tavily_search',
      'ifc_measure',
      'status:checkpoint:0',
      'clarifier_agent',
      'status:Synthesis',
      'web_search_tool',
    ])
    expect(steps.every((step) => !('kind' in step) && step.displayName === '')).toBe(true)
    expect(steps[2]).toMatchObject({ category: 'tasks', turnEvent: retrievalEvent })
    expect(steps[3]).toMatchObject({ category: 'agents', traceLanes: lanes })
    expect(steps[9]).toMatchObject({ isDeepResearch: true, isComplete: false })
    expect(await stepsOf(ID.alreadyV2)).toEqual([
      {
        id: 'd1',
        userMessageId: USER_MESSAGE,
        functionName: 'knowledge_search',
        displayName: '',
        category: 'agents',
        timestamp: AT,
        isComplete: true,
      },
    ])
  })

  it('up after down converges on the same v2 rows', async () => {
    await db.unsafe(migration('0097_herleitung_steps_v2.sql'))
    expect(await stepsOf(ID.turn)).toEqual(V2_TURN)
    expect(await stepsOf(ID.alreadyV2)).toEqual([v2('d1', 'tool', { tool: 'knowledge_search' })])
  })
})
