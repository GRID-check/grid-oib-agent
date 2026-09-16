/**
 * The Stundenplan, as a reader meets it.
 *
 * The geometry has its own spec (`lib/timetable.spec.ts`); what is asserted
 * here is that the grid makes the three claims only a laid-out week can make —
 * a collision is visible, the labels are on the blocks so colour is never the
 * only carrier, and a schedule the parser cannot place is NAMED rather than
 * quietly missing. Plus the one interaction the surface owes: a block is a way
 * into the schedule it belongs to.
 */

import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { Job } from '@/adapters/api/jobs-client'
import { ScheduleTimetable } from './schedule-timetable'

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'j1',
  projectId: 'p1',
  name: 'Täglicher Brandschutz-Scan',
  prompt: 'Prüfe die Brandschutzpunkte.',
  skillName: null,
  skillSnapshot: null,
  output: 'chat',
  dataSources: null,
  enabled: true,
  scheduleCron: '0 6 * * *',
  scheduleTimezone: 'Europe/Vienna',
  dueAt: null,
  nextRunAt: null,
  lastRunAt: null,
  createdBy: 'u',
  createdByEmail: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
})

/** The grid expands cron asynchronously; nothing is on screen until it lands. */
async function blocks(): Promise<HTMLElement[]> {
  await waitFor(() => expect(screen.getAllByTestId('timetable-block').length).toBeGreaterThan(0))
  return screen.getAllByTestId('timetable-block')
}

describe('what the grid shows', () => {
  test('a daily schedule lands on every one of the seven days', async () => {
    render(<ScheduleTimetable schedules={[job()]} />)
    expect(await blocks()).toHaveLength(7)
  })

  test('every block carries its schedule’s NAME — colour is never the only cue', async () => {
    render(<ScheduleTimetable schedules={[job()]} />)
    for (const block of await blocks()) {
      expect(block).toHaveTextContent('Täglicher Brandschutz-Scan')
    }
  })

  test('two schedules at the same minute render as two blocks, side by side', async () => {
    render(
      <ScheduleTimetable
        schedules={[
          job({ id: 'a', name: 'Scan A', scheduleCron: '0 6 * * 1' }),
          job({ id: 'b', name: 'Scan B', scheduleCron: '0 6 * * 1' }),
        ]}
      />,
    )
    const found = await blocks()
    expect(found).toHaveLength(2)
    // Half a column each, and offset — the collision is a shape, not a label.
    const widths = found.map((block) => block.style.width)
    expect(new Set(widths).size).toBe(1)
    expect(new Set(found.map((block) => block.style.left)).size).toBe(2)
  })

  test('a paused schedule is off the grid — it is not going to happen', async () => {
    render(
      <ScheduleTimetable
        schedules={[job({ id: 'on', name: 'Läuft' }), job({ id: 'off', name: 'Pausiert', enabled: false })]}
      />,
    )
    for (const block of await blocks()) {
      expect(block).not.toHaveTextContent('Pausiert')
    }
  })

  test('a manual-only schedule is off the grid too — it has no cadence to draw', async () => {
    render(
      <ScheduleTimetable
        schedules={[job(), job({ id: 'manual', name: 'Auf Zuruf', scheduleCron: null })]}
      />,
    )
    for (const block of await blocks()) {
      expect(block).not.toHaveTextContent('Auf Zuruf')
    }
  })

  test('a cron nobody can parse is NAMED, never silently left off', async () => {
    render(<ScheduleTimetable schedules={[job({ id: 'broken', name: 'Kaputt', scheduleCron: 'nope' })]} />)
    await waitFor(() =>
      expect(screen.getByText(/Not shown on the grid/i)).toHaveTextContent('Kaputt'),
    )
  })
})

describe('the legend', () => {
  test('pairs every placeable schedule with its swatch', async () => {
    render(<ScheduleTimetable schedules={[job({ name: 'Scan A' })]} />)
    const legend = await screen.findByRole('list', { name: /Tasks on this grid/i })
    expect(within(legend).getByText('Scan A')).toBeInTheDocument()
  })

  test('is a way into the schedule, like the blocks are', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ScheduleTimetable schedules={[job({ name: 'Scan A' })]} onSelect={onSelect} />)
    const legend = await screen.findByRole('list', { name: /Tasks on this grid/i })
    await user.click(within(legend).getByText('Scan A'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }))
  })
})

describe('navigating and cropping', () => {
  test('a block opens the schedule it belongs to', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ScheduleTimetable schedules={[job()]} onSelect={onSelect} />)
    await user.click((await blocks())[0])
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }))
  })

  test('the band crops, and offers to stop cropping', async () => {
    render(<ScheduleTimetable schedules={[job()]} />)
    await blocks()
    expect(screen.getByTestId('timetable-full-day')).toBeInTheDocument()
  })

  test('a week with no schedules says so rather than drawing an empty grid', async () => {
    render(<ScheduleTimetable schedules={[]} />)
    await waitFor(() => expect(screen.getByText(/Nothing scheduled yet/i)).toBeInTheDocument())
    expect(screen.queryByTestId('timetable-grid')).not.toBeInTheDocument()
  })

  test('stepping to another week re-expands, and offers the way back to today', async () => {
    const user = userEvent.setup()
    render(<ScheduleTimetable schedules={[job()]} />)
    await blocks()
    await user.click(screen.getByRole('button', { name: /Next week/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Today$/ })).toBeInTheDocument())
    expect(await blocks()).toHaveLength(7)
  })
})
