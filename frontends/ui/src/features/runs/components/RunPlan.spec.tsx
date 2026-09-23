/**
 * The plan on the run block (ADR-0065). What is pinned: doing nothing is a
 * complete answer (the countdown says the run starts on its own), „Anpassen"
 * holds and opens the controls, every edit sends only what changed, and a
 * started plan is a brief to read, not a form.
 */

import { fireEvent, render, screen, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchPlan } from '@/lib/plans/plan-types'
import { RunPlan, planEdit } from './RunPlan'
import { planShapeOf } from './PlanChecklist'

const T0 = new Date('2026-09-22T08:00:00.000Z')

const plan = (overrides: Partial<ResearchPlan> = {}): ResearchPlan => ({
  id: 'plan-1',
  projectId: 'proj',
  conversationId: 's_conv',
  runId: 'run-1',
  author: 'agent',
  status: 'proposed',
  question: 'Fluchtwege prüfen',
  title: 'Fluchtwege',
  sections: ['Bestand', 'Anforderungen', 'Befund'],
  genre: 'pruefbericht',
  depth: 'gutachten',
  grundlage: [],
  ausgeschlossen: [],
  nurGrundlage: false,
  dataSources: null,
  unterlagen: [{ name: 'Einreichplan.pdf', shelf: 'project' }],
  startsAt: new Date(T0.getTime() + 30_000).toISOString(),
  heldAt: null,
  approvedAt: null,
  startedAt: null,
  createdAt: T0.toISOString(),
  updatedAt: T0.toISOString(),
  ...overrides,
})

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RunPlan', () => {
  it('a proposed plan counts down and asks nothing of the reader', () => {
    render(<RunPlan plan={plan()} onHold={vi.fn()} onStart={vi.fn()} onEdit={vi.fn()} />)
    expect(screen.getByTestId('run-plan')).toHaveAttribute('data-status', 'proposed')
    expect(screen.getByTestId('run-plan-line')).toHaveTextContent('Starts on its own in 30 s')
    expect(screen.getByTestId('run-plan-toggle')).toHaveTextContent('3 sections')
    // Folded: no form in front of a reader who has nothing to change.
    expect(screen.queryByTestId('plan-checklist')).not.toBeInTheDocument()
  })

  it('„Anpassen" holds the plan and opens it as controls', () => {
    const onHold = vi.fn()
    render(<RunPlan plan={plan()} onHold={onHold} onStart={vi.fn()} onEdit={vi.fn()} />)
    fireEvent.click(screen.getByTestId('run-plan-hold'))
    expect(onHold).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('plan-checklist')).toBeInTheDocument()
  })

  it('a held plan is open, waits for the reader, and offers Start', () => {
    const onStart = vi.fn()
    render(<RunPlan plan={plan({ status: 'held', startsAt: null })} onStart={onStart} onEdit={vi.fn()} />)
    expect(screen.getByTestId('run-plan-line')).toHaveTextContent('Waiting for you')
    expect(screen.getByTestId('plan-checklist')).toBeInTheDocument()
    expect(screen.queryByTestId('run-plan-hold')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('run-plan-start'))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('a struck section is sent as the one change', () => {
    const onEdit = vi.fn()
    render(<RunPlan plan={plan({ status: 'held', startsAt: null })} onEdit={onEdit} />)
    const points = screen.getAllByTestId('plan-point')
    fireEvent.click(within(points[1]).getByRole('button'))
    expect(onEdit).toHaveBeenCalledWith({ sections: ['Bestand', 'Befund'] })
  })

  it('a started plan is a brief to read', () => {
    render(<RunPlan plan={plan({ status: 'started', startsAt: null })} />)
    expect(screen.getByTestId('run-plan-line')).toHaveTextContent('The research runs on this plan.')
    expect(screen.queryByTestId('run-plan-start')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('run-plan-toggle'))
    expect(screen.getByTestId('run-plan-sections')).toHaveTextContent('Anforderungen')
    expect(screen.queryByTestId('plan-checklist')).not.toBeInTheDocument()
  })

  it('places the plan on its lifecycle once the clock has stopped, and says edits are saved', () => {
    render(<RunPlan plan={plan({ status: 'held', startsAt: null })} onEdit={vi.fn()} onStart={vi.fn()} />)
    expect(screen.getByTestId('run-plan-lifecycle')).toHaveAttribute('data-stage', 'held')
    expect(screen.getByTestId('run-plan-saved')).toHaveTextContent('Every change is saved at once.')
    expect(screen.queryByTestId('run-plan-countdown')).not.toBeInTheDocument()
  })

  it('shows a plan confined to its documents as such', () => {
    render(
      <RunPlan
        plan={plan({
          status: 'started',
          startsAt: null,
          nurGrundlage: true,
          grundlage: [{ name: 'Einreichplan.pdf', shelf: 'project' }],
        })}
      />
    )
    expect(screen.getByTestId('run-plan-toggle')).toHaveTextContent('only 1 document')
    expect(screen.getByTestId('run-plan-grundlage')).toHaveTextContent('Only these:')
  })

  it('names a plan the reader wrote as theirs', () => {
    render(<RunPlan plan={plan({ author: 'user', status: 'approved', startsAt: null })} />)
    expect(screen.getByTestId('run-plan-toggle')).toHaveTextContent('Your research plan')
  })
})

describe('planEdit', () => {
  it('sends a document picked from the project listing with the names, and the scope when it changes', () => {
    const before = planShapeOf(plan())
    const statik = { name: 'Statik.pdf', shelf: 'project' }
    expect(
      planEdit(before, {
        ...before,
        grundlage: ['Statik.pdf'],
        nurGrundlage: true,
        unterlagen: [...before.unterlagen, statik],
      })
    ).toEqual({ grundlage: ['Statik.pdf'], nurGrundlage: true, unterlagen: [statik] })
  })

  it('is empty for an untouched plan and names only the changed fields', () => {
    const before = planShapeOf(plan())
    expect(planEdit(before, before)).toEqual({})
    expect(planEdit(before, { ...before, depth: 'kurzpruefung', grundlage: ['Einreichplan.pdf'] })).toEqual({
      depth: 'kurzpruefung',
      grundlage: ['Einreichplan.pdf'],
    })
  })
})
