/**
 * The tab strip's travelling pill, and its shared-layout IDENTITY.
 *
 * Same defect as `ToggleGroup`, same reason: `layoutId` names one travelling
 * element across the whole tree, so the constant this used to be made every
 * strip on screen the same element. Two strips mounted together — a dialog
 * over a page, two panels side by side — and the pill flew between them.
 *
 * `layoutId` is motion state and never reaches the DOM, so it is mirrored onto
 * `data-pill-id`; that attribute is what makes the collision observable here
 * rather than only in the animation.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

function pills(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="tabs-pill"]'))
}

function Strip({ label }: { label: string }): JSX.Element {
  const [tab, setTab] = useState('one')
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList aria-label={label}>
        <TabsTrigger value="one">{`${label} one`}</TabsTrigger>
        <TabsTrigger value="two">{`${label} two`}</TabsTrigger>
      </TabsList>
      <TabsContent value="one">first</TabsContent>
      <TabsContent value="two">second</TabsContent>
    </Tabs>
  )
}

describe('Tabs', () => {
  it('draws exactly one pill, on the active trigger', () => {
    const { container } = render(<Strip label="A" />)
    const found = pills(container)
    expect(found).toHaveLength(1)
    expect(found[0]!.closest('button')).toHaveTextContent('A one')
  })

  it('moves the pill to the trigger that was chosen', async () => {
    const user = userEvent.setup()
    const { container } = render(<Strip label="A" />)

    await user.click(screen.getByRole('tab', { name: 'A two' }))

    expect(pills(container)[0]!.closest('button')).toHaveTextContent('A two')
  })

  it('gives two strips on one screen DIFFERENT pill identities', () => {
    const { container } = render(
      <>
        <Strip label="A" />
        <Strip label="B" />
      </>
    )

    const ids = pills(container).map((pill) => pill.getAttribute('data-pill-id'))
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('moves the pill when the strip is UNCONTROLLED too', async () => {
    // Same contract as ToggleGroup: with no `value`, the wrapper tracks
    // `onValueChange` itself so the pill still follows clicks.
    const user = userEvent.setup()
    const { container } = render(
      <Tabs defaultValue="one">
        <TabsList aria-label="A">
          <TabsTrigger value="one">A one</TabsTrigger>
          <TabsTrigger value="two">A two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">first</TabsContent>
        <TabsContent value="two">second</TabsContent>
      </Tabs>
    )
    expect(pills(container)[0]!.closest('button')).toHaveTextContent('A one')

    await user.click(screen.getByRole('tab', { name: 'A two' }))

    expect(pills(container)[0]!.closest('button')).toHaveTextContent('A two')
  })

  it('keeps ONE identity within a strip, so the pill travels rather than cross-fades', async () => {
    const user = userEvent.setup()
    const { container } = render(<Strip label="A" />)
    const before = pills(container)[0]!.getAttribute('data-pill-id')

    await user.click(screen.getByRole('tab', { name: 'A two' }))

    expect(pills(container)[0]!.getAttribute('data-pill-id')).toBe(before)
  })
})
