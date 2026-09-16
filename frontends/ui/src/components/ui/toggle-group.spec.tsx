/**
 * The segmented group's travelling pill, and the one thing about it that is
 * not local: its shared-layout IDENTITY.
 *
 * `layoutId` names one travelling element across the entire React tree, not
 * one per component. A constant therefore made every segmented group on screen
 * the same element — and the Tasks tab mounts two of them at once, the
 * Liste/Zeitplan view switcher above the status filter row, so clicking a
 * filter chip made the pill fly up into the view switcher and back.
 *
 * `layoutId` is motion state and never reaches the DOM, so the animation is
 * not observable from jsdom — which is exactly why the id is mirrored onto
 * `data-pill-id`. That attribute is the defect made visible, and these tests
 * are about it rather than about the glide.
 */

import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

function pills(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="toggle-pill"]'))
}

function View({ initial = 'list' }: { initial?: string }): JSX.Element {
  const [view, setView] = useState(initial)
  return (
    <ToggleGroup type="single" value={view} onValueChange={setView} segmented aria-label="View">
      <ToggleGroupItem value="list">Liste</ToggleGroupItem>
      <ToggleGroupItem value="timetable">Zeitplan</ToggleGroupItem>
    </ToggleGroup>
  )
}

describe('segmented ToggleGroup', () => {
  it('draws exactly one pill, on the selected segment', () => {
    const { container } = render(<View />)
    const found = pills(container)
    expect(found).toHaveLength(1)
    expect(found[0]!.closest('button')).toHaveTextContent('Liste')
  })

  it('moves the pill to whichever segment is chosen', async () => {
    const user = userEvent.setup()
    const { container } = render(<View />)

    await user.click(screen.getByRole('radio', { name: 'Zeitplan' }))

    const found = pills(container)
    expect(found).toHaveLength(1)
    expect(found[0]!.closest('button')).toHaveTextContent('Zeitplan')
  })

  it('gives two groups on one screen DIFFERENT pill identities', () => {
    // The regression this exists for. Same id in both groups means framer
    // treats them as one element, and the pill travels between two unrelated
    // controls instead of gliding inside the one that was clicked.
    const { container } = render(
      <>
        <View />
        <ToggleGroup type="single" value="all" segmented aria-label="Filter">
          <ToggleGroupItem value="all">Alle</ToggleGroupItem>
          <ToggleGroupItem value="unreviewed">Ungeprüft</ToggleGroupItem>
        </ToggleGroup>
      </>
    )

    const ids = pills(container).map((pill) => pill.getAttribute('data-pill-id'))
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('keeps ONE identity within a group, which is what makes the glide a glide', async () => {
    const user = userEvent.setup()
    const { container } = render(<View />)
    const before = pills(container)[0]!.getAttribute('data-pill-id')

    await user.click(screen.getByRole('radio', { name: 'Zeitplan' }))

    // Same id on the other segment: the pill is the same element arriving
    // somewhere new. A fresh id per segment would cross-fade two chips.
    expect(pills(container)[0]!.getAttribute('data-pill-id')).toBe(before)
  })

  it('draws no pill at all when the group is not segmented', () => {
    const { container } = render(
      <ToggleGroup type="single" value="list" aria-label="View">
        <ToggleGroupItem value="list">Liste</ToggleGroupItem>
      </ToggleGroup>
    )
    expect(pills(container)).toHaveLength(0)
  })
})
