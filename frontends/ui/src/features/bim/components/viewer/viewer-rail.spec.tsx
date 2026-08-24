import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewerRail, ViewerRailItem, ViewerRailSection } from './viewer-rail'

describe('ViewerRailSection', () => {
  it('is a labelled group, so the model list and the level list are told apart', () => {
    render(
      <ViewerRail>
        <ViewerRailSection label="Modelle">
          <ViewerRailItem label="Haus-A" />
        </ViewerRailSection>
        <ViewerRailSection label="Geschosse">
          <ViewerRailItem label="Erdgeschoss" />
        </ViewerRailSection>
      </ViewerRail>
    )
    const levels = screen.getByRole('region', { name: 'Geschosse' })
    expect(within(levels).getByRole('button', { name: 'Erdgeschoss' })).toBeInTheDocument()
    expect(within(levels).queryByRole('button', { name: 'Haus-A' })).not.toBeInTheDocument()
  })
})

describe('ViewerRailItem', () => {
  it('says which row is the one being shown', () => {
    render(
      <>
        <ViewerRailItem label="Erdgeschoss" selected />
        <ViewerRailItem label="Obergeschoss" />
      </>
    )
    expect(screen.getByRole('button', { name: 'Erdgeschoss' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Obergeschoss' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('selects on click', async () => {
    const onClick = vi.fn()
    render(<ViewerRailItem label="Keller" onClick={onClick} />)
    await userEvent.click(screen.getByRole('button', { name: 'Keller' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('shows secondary information without it becoming the name', () => {
    // The elevation is context, not identity: a screen reader announcing
    // "Erdgeschoss +0,00 m 412" as the button's name buries the one word that
    // matters under two that do not.
    render(<ViewerRailItem label="Erdgeschoss" meta="+0,00 m" ariaLabel="Erdgeschoss" />)
    const item = screen.getByRole('button', { name: 'Erdgeschoss' })
    expect(within(item).getByText('+0,00 m')).toBeInTheDocument()
  })

  it('does not fire while disabled', async () => {
    const onClick = vi.fn()
    render(<ViewerRailItem label="Wird gelesen" onClick={onClick} disabled />)
    await userEvent.click(screen.getByRole('button', { name: 'Wird gelesen' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})
