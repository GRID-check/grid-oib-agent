/**
 * The Raumbuch, the Massenermittlung and the derived project facts.
 *
 * These three tables go into a submission, a cost estimate and the project
 * brief, so every assertion here is about the same thing: the screen must never
 * show a total without also showing what the total could not see. A missing area
 * rendered as `0` is the failure this whole subsystem exists to prevent, and it
 * is invisible unless a test looks for it.
 *
 * Rendered in English — the default test locale.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IfcProfileSuggestions, IfcQuantityTakeoff, IfcRoomSchedule } from './ifc-model-tables'
import type { BimQuantityRow, BimRoomSchedule } from '@/lib/bim/schedule'

const SCHEDULE: BimRoomSchedule = {
  storeys: [
    {
      storeyName: 'Erdgeschoss',
      elevation: 0,
      rooms: [
        {
          globalId: 'g-wohnen',
          name: 'Wohnzimmer',
          storeyName: 'Erdgeschoss',
          category: 'INTERNAL',
          netFloorArea: 32,
          grossFloorArea: 34.5,
          netVolume: 80,
          height: 2.5,
        },
        {
          globalId: 'g-bad',
          name: 'Bad',
          storeyName: 'Erdgeschoss',
          category: 'INTERNAL',
          netFloorArea: null,
          grossFloorArea: null,
          netVolume: null,
          height: null,
        },
      ],
      netFloorArea: 32,
      grossFloorArea: 34.5,
      netVolume: 80,
      roomsWithoutArea: 1,
    },
  ],
  totals: {
    rooms: 2,
    roomsWithoutArea: 1,
    netFloorArea: 32,
    grossFloorArea: 34.5,
    netVolume: 80,
  },
  units: { area: 'm²', volume: 'm³', length: 'm' },
}

const EMPTY_SCHEDULE: BimRoomSchedule = {
  storeys: [],
  totals: { rooms: 0, roomsWithoutArea: 0, netFloorArea: null, grossFloorArea: null, netVolume: null },
  units: { area: 'm²', volume: 'm³', length: 'm' },
}

describe('IfcRoomSchedule', () => {
  it('groups rooms under their storey and totals each one', () => {
    render(
      <IfcRoomSchedule schedule={SCHEDULE} isLoading={false} error={null} filename="haus-a.ifc" />
    )
    expect(screen.getByRole('columnheader', { name: /Net area \(m²\)/ })).toBeInTheDocument()
    expect(screen.getByText('Wohnzimmer')).toBeInTheDocument()
    const storeyTotal = screen.getByText('Storey total').closest('tr')
    expect(within(storeyTotal!).getByText('32')).toBeInTheDocument()
  })

  it('states how many rooms the total leaves out, at the top and per storey', () => {
    render(
      <IfcRoomSchedule schedule={SCHEDULE} isLoading={false} error={null} filename="haus-a.ifc" />
    )
    expect(
      screen.getByText('Rooms with no published area: 1 — not included in these totals.')
    ).toBeInTheDocument()
    expect(screen.getByText('1 without area')).toBeInTheDocument()
  })

  it('shows a missing area as missing, never as zero', () => {
    render(
      <IfcRoomSchedule schedule={SCHEDULE} isLoading={false} error={null} filename="haus-a.ifc" />
    )
    const bad = screen.getByText('Bad').closest('tr')
    // Two em-dashes: no area and no volume. A zero here would be a room the
    // Einreichung silently counts as having no floor.
    expect(within(bad!).getAllByText('—')).toHaveLength(2)
    expect(within(bad!).queryByText('0')).not.toBeInTheDocument()
  })

  it('selects the room a row is clicked on', async () => {
    const onSelect = vi.fn()
    render(
      <IfcRoomSchedule
        schedule={SCHEDULE}
        isLoading={false}
        error={null}
        filename="haus-a.ifc"
        onSelect={onSelect}
      />
    )
    await userEvent.click(screen.getByText('Wohnzimmer'))
    expect(onSelect).toHaveBeenCalledWith('g-wohnen')
  })

  it('lets a keyboard select a room, not just a pointer', async () => {
    // The row carried the click handler and nothing else did: no Tab stop, no
    // Enter, nothing announced as actionable. The Raumbuch was the one table
    // on this page a keyboard could not select from — and selecting is how
    // every other surface here is reached.
    const onSelect = vi.fn()
    render(
      <IfcRoomSchedule
        schedule={SCHEDULE}
        isLoading={false}
        error={null}
        filename="haus-a.ifc"
        onSelect={onSelect}
      />
    )
    const room = screen.getByRole('button', { name: 'Wohnzimmer' })
    room.focus()
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('g-wohnen')
  })

  it('says which room is selected, rather than only tinting its row', async () => {
    // `aria-selected` on a `<tr>` inside a `role="table"` is dropped from the
    // accessibility tree, so the selection was a background colour and
    // nothing else.
    render(
      <IfcRoomSchedule
        schedule={SCHEDULE}
        isLoading={false}
        error={null}
        filename="haus-a.ifc"
        onSelect={vi.fn()}
        selectedGlobalId="g-wohnen"
      />
    )
    expect(screen.getByRole('button', { name: 'Wohnzimmer' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('heads each block of rooms with the storey they are on', () => {
    // `scope="colgroup"` claims to head the rest of a COLUMN, so reading the
    // Raumbuch cell by cell never said which floor a room was on — which is
    // the first thing the table is sorted by.
    render(
      <IfcRoomSchedule schedule={SCHEDULE} isLoading={false} error={null} filename="haus-a.ifc" />
    )
    // Queried as a DOM node rather than by role: `scope` is the whole point
    // and it is exactly what changes which role the cell reports.
    const heading = screen.getByText('Erdgeschoss').closest('th')
    expect(heading).toHaveAttribute('scope', 'rowgroup')
  })

  it('offers no CSV for a model with no rooms, and says why', () => {
    render(
      <IfcRoomSchedule
        schedule={EMPTY_SCHEDULE}
        isLoading={false}
        error={null}
        filename="haus-a.ifc"
      />
    )
    expect(screen.getByText('This model contains no rooms (IfcSpace).')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'CSV' })).not.toBeInTheDocument()
  })

  it('reports a failed load instead of an empty table', () => {
    render(
      <IfcRoomSchedule
        schedule={null}
        isLoading={false}
        error="load-failed"
        filename="haus-a.ifc"
      />
    )
    expect(screen.getByText('The room schedule could not be loaded.')).toBeInTheDocument()
  })
})

const TAKEOFF: BimQuantityRow[] = [
  { group: 'IfcWall · Stahlbeton', elements: 2, value: 46.5, missing: 0 },
  { group: 'IfcWall · (ohne Material)', elements: 1, value: null, missing: 1 },
]

describe('IfcQuantityTakeoff', () => {
  const noop = (): void => {}

  it('shows the sum and, beside it, how many elements published nothing', () => {
    render(
      <IfcQuantityTakeoff
        units={{ area: 'm²', volume: 'm³', length: 'm' }}
        rows={TAKEOFF}
        isLoading={false}
        error={null}
        quantity="NetSideArea"
        onQuantityChange={noop}
        byMaterial
        onByMaterialChange={noop}
      />
    )
    expect(screen.getByText('46.5')).toBeInTheDocument()
    // The banner is the point: "56.5 m² of wall" over an incomplete set is a
    // different number from the same figure over a complete one.
    expect(
      screen.getByText('Elements with no published value for this quantity: 1.')
    ).toBeInTheDocument()
    expect(screen.getByText('(1 without value)')).toBeInTheDocument()
  })

  it('changes the quantity being summed', async () => {
    const onQuantityChange = vi.fn()
    render(
      <IfcQuantityTakeoff
        units={{ area: 'm²', volume: 'm³', length: 'm' }}
        rows={TAKEOFF}
        isLoading={false}
        error={null}
        quantity="NetSideArea"
        onQuantityChange={onQuantityChange}
        byMaterial={false}
        onByMaterialChange={noop}
      />
    )
    await userEvent.selectOptions(screen.getByLabelText('Quantity'), 'NetVolume')
    expect(onQuantityChange).toHaveBeenCalledWith('NetVolume')
  })

  it('splits by material on request', async () => {
    const onByMaterialChange = vi.fn()
    render(
      <IfcQuantityTakeoff
        units={{ area: 'm²', volume: 'm³', length: 'm' }}
        rows={TAKEOFF}
        isLoading={false}
        error={null}
        quantity="NetSideArea"
        onQuantityChange={noop}
        byMaterial={false}
        onByMaterialChange={onByMaterialChange}
      />
    )
    await userEvent.click(screen.getByLabelText('Split by material'))
    expect(onByMaterialChange).toHaveBeenCalledWith(true)
  })
})

describe('IfcProfileSuggestions', () => {
  const SUGGESTIONS = [
    {
      key: 'geschosse_oberirdisch',
      value: 3,
      confidence: 'high' as const,
      evidence: '3 Geschosse mit Höhenlage ≥ 0 im Modell: EG, OG1, OG2',
    },
    {
      key: 'fluchtniveau',
      value: '<=7m',
      confidence: 'medium' as const,
      evidence: 'Oberstes belegtes Geschoss liegt bei 6 m (OG2)',
    },
  ]

  it('shows every suggestion with its confidence and its evidence', () => {
    render(
      <IfcProfileSuggestions
        suggestions={SUGGESTIONS}
        isLoading={false}
        error={null}
        askHref="/app/projects/p1/chat?ask=x"
      />
    )
    expect(screen.getByText('Storeys above ground')).toBeInTheDocument()
    expect(screen.getByText('High confidence')).toBeInTheDocument()
    // Evidence is not a tooltip: a derived Gebäudeklasse input has to show its
    // working on the same screen.
    expect(screen.getByText(/3 Geschosse mit Höhenlage/)).toBeInTheDocument()
    expect(screen.getByText('Medium confidence')).toBeInTheDocument()
  })

  it('routes the change through the assistant rather than writing it here', () => {
    render(
      <IfcProfileSuggestions
        suggestions={SUGGESTIONS}
        isLoading={false}
        error={null}
        askHref="/app/projects/p1/chat?ask=x"
      />
    )
    const action = screen.getByRole('link', { name: 'Apply via the assistant' })
    expect(action).toHaveAttribute('href', '/app/projects/p1/chat?ask=x')
    // No Apply button: a brief change goes through the confirm-the-patch card.
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument()
  })

  it('says the model supports nothing rather than showing an empty list', () => {
    render(
      <IfcProfileSuggestions suggestions={[]} isLoading={false} error={null} askHref="/x" />
    )
    expect(screen.getByText('No project data can be derived from this model.')).toBeInTheDocument()
  })
})
