/**
 * What the site plan and the dimension diagram took over from two retired
 * cards: the Bebauungsgrad / GFZ readout (`density_check`) and the lift cabin
 * plan (`elevator_requirement`). The ratios are computed here from areas; the
 * model supplies areas and limits only.
 */
import { describe, expect, it } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { DimensionDiagramCard } from './DimensionDiagramCard'
import { densityReadout, SetbackPlanCard } from './SetbackPlanCard'

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const REF = { document: 'Bebauungsplan', section: '§ 3' }

describe('densityReadout', () => {
  it('derives Bebauungsgrad and GFZ from the areas and holds them to their limits', () => {
    const [coverage, density] = densityReadout({
      parcelArea: 1000,
      footprintArea: 420,
      grossFloorArea: 1350,
      coverage: { label: 'Bebauungsgrad', value: null, required: 40, unit: '%', comparator: '<=', status: 'needs_input' },
      density: { label: 'GFZ', value: null, required: 1.2, unit: '', comparator: '<=', status: 'needs_input' },
    })
    expect(coverage).toMatchObject({ value: 42, status: 'fail' })
    expect(density).toMatchObject({ value: 1.35, status: 'fail' })
  })

  it('keeps a ratio the model stated, and asks for a BGF it did not give', () => {
    const [coverage, density] = densityReadout({
      parcelArea: 1000,
      footprintArea: 300,
      grossFloorArea: null,
      coverage: { label: 'Bebauungsgrad', value: 0.3, required: 0.4, unit: '', comparator: '<=', status: 'pass' },
      density: { label: 'GFZ', value: null, required: 1.2, unit: '', comparator: '<=', status: 'pass' },
    })
    expect(coverage).toMatchObject({ value: 0.3, status: 'pass' })
    expect(density).toMatchObject({ value: null, status: 'needs_input' })
  })
})

describe('SetbackPlanCard readout', () => {
  it('lists the derived ratios under the plan', () => {
    render(
      <SetbackPlanCard
        title="Lageplan"
        parcel_width_m={20}
        parcel_depth_m={50}
        building_width_m={12}
        building_depth_m={30}
        sides={[]}
        reference={REF}
        coverage={{ label: 'Bebauungsgrad', value: null, required: 40, unit: '%', comparator: '<=', status: 'needs_input' }}
      />
    )
    expect(screen.getByText('Bebauungsgrad')).toBeInTheDocument()
    // 12 × 30 on 20 × 50: 36 %.
    expect(screen.getByText(/36/)).toBeInTheDocument()
  })
})

describe('SetbackPlanCard: the computation wins', () => {
  it('computes the ratio over a stated one that disagrees, and names the stated one', () => {
    const [coverage] = densityReadout({
      parcelArea: 1000,
      footprintArea: 420,
      grossFloorArea: null,
      coverage: { label: 'Bebauungsgrad', value: 30, required: 40, unit: '%', comparator: '<=', status: 'pass' },
      stated: (value) => `angegeben: ${value}`,
    })
    expect(coverage).toMatchObject({ value: 42, status: 'fail', label: 'Bebauungsgrad (angegeben: 30)' })
  })

  it('draws no plan for a pure density question, and its verdict is the readout', () => {
    const { container } = render(
      <SetbackPlanCard
        title="Dichte"
        sides={[]}
        reference={REF}
        parcel_area_m2={800}
        gross_floor_area_m2={1450}
        density={{ label: 'GFZ', value: null, required: 1.5, unit: '', comparator: '<=', status: 'needs_input' }}
      />
    )
    expect(container.querySelector('svg[role="img"], svg rect')).toBeNull()
    expect(screen.getByText('GFZ')).toBeInTheDocument()
    expect(screen.getByText(/1,81/)).toBeInTheDocument()
  })
})

describe('DimensionDiagramCard lift_cabin', () => {
  it('draws the cabin and keeps the door apart from the cabin width', () => {
    const { container } = render(
      <DimensionDiagramCard
        title="Aufzug – Kabine"
        shape="lift_cabin"
        dimensions={[
          { label: 'lichte Türbreite', value: 90, required: 90, unit: 'cm', comparator: '>=', status: 'pass' },
          { label: 'Kabinenbreite', value: 110, required: 110, unit: 'cm', comparator: '>=', status: 'pass' },
          { label: 'Kabinentiefe', value: 130, required: 140, unit: 'cm', comparator: '>=', status: 'fail' },
        ]}
        reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.6' }}
      />
    )
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getAllByText('130 cm').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('90 cm').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('110 cm').length).toBeGreaterThanOrEqual(1)
  })
})
