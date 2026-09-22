import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/features/chat/types'
import type { Findings } from '@/lib/conversations/message-findings'
import { continuationBrief, findingBrief, previousRunFindings } from './carry-forward'

const findings: Findings = {
  v: 1,
  items: [
    {
      requirement: 'Zweiter Fluchtweg',
      status: 'offen',
      grounding: 'offen',
      citations: [],
      comment: 'Fluchtniveau unbekannt.',
    },
    {
      requirement: 'Feuerwiderstand',
      value: 'REI 60',
      status: 'erfuellt',
      grounding: 'belegt',
      citations: [1],
      reference: { document: 'OIB-RL 2', section: 'Tabelle 1b' },
    },
  ],
}

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm',
  role: 'assistant',
  content: '',
  timestamp: new Date('2026-09-22T10:00:00Z'),
  messageType: 'agent_response',
  ...overrides,
})

describe('findingBrief', () => {
  it('asks to clear the one finding, in its own words', () => {
    const brief = findingBrief(findings.items[0]!)
    expect(brief.question).toBe('Klären: Zweiter Fluchtweg')
    expect(brief.context).toContain('- Zweiter Fluchtweg — offen (Fluchtniveau unbekannt.)')
  })
})

describe('continuationBrief', () => {
  it('carries every finding of the report forward under the run title', () => {
    const brief = continuationBrief(message({ runTitle: 'Brandschutz GK 4', findings }))
    expect(brief.question).toBe('Fortschreibung: Brandschutz GK 4')
    expect(brief.context).toContain('- Feuerwiderstand — REI 60 — erfüllt — OIB-RL 2 Tabelle 1b')
    expect(brief.context).toContain('- Zweiter Fluchtweg — offen')
  })

  it('says so when the report carried no findings', () => {
    expect(continuationBrief(message({})).context).toContain('(keine Befundliste vorhanden)')
    expect(continuationBrief(message({})).documents).toBeUndefined()
  })

  it('names the office documents the last report drew on as the next run’s Grundlage', () => {
    const brief = continuationBrief(
      message({
        citations: [
          { id: '1', content: '', timestamp: new Date(), shelf: 'project', fileName: 'Einreichplan.pdf', title: 'Einreichplan EG' },
          { id: '2', content: '', timestamp: new Date(), shelf: 'archiv', fileName: 'Muster.pdf' },
          { id: '3', content: '', timestamp: new Date(), shelf: 'project', fileName: 'einreichplan.pdf' },
          { id: '4', content: '', timestamp: new Date(), shelf: 'base', fileName: 'OIB-RL 2.pdf' },
          { id: '5', content: '', timestamp: new Date(), url: 'https://ris.bka.gv.at/x' },
        ],
      })
    )
    expect(brief.documents).toEqual({
      grundlage: [
        { name: 'Einreichplan.pdf', title: 'Einreichplan EG', shelf: 'project' },
        { name: 'Muster.pdf', shelf: 'archiv' },
      ],
      ausgeschlossen: [],
    })
  })

  it('writes a row without a verdict without a status word', () => {
    const brief = continuationBrief(
      message({
        findings: {
          v: 1,
          items: [{ requirement: 'Kriterium A', value: '12 m', grounding: 'belegt', citations: [] }],
        },
      })
    )
    expect(brief.context).toContain('- Kriterium A — 12 m')
    expect(brief.context).not.toContain('Kriterium A — 12 m —')
  })
})

describe('previousRunFindings', () => {
  const ledger = {
    runId: 'r',
    status: 'fertig',
    phases: [],
    steps: [],
    startedAt: 'x',
    updatedAt: 'x',
  } as never
  it('finds the most recent earlier run with findings, skipping chat answers', () => {
    const thread = [
      message({ id: 'a', runLedger: ledger, findings }),
      message({ id: 'b', content: 'Eine Antwort ohne Lauf.' }),
      message({ id: 'c', runLedger: ledger }),
    ]
    expect(previousRunFindings(thread, 'c')).toBe(findings)
    expect(previousRunFindings(thread, 'a')).toBeUndefined()
  })
})
