import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewerField, ViewerFieldGroup, ViewerPanel } from './viewer-panel'

function panel(overrides: Partial<Parameters<typeof ViewerPanel>[0]> = {}) {
  return render(
    <ViewerPanel title="AW 38" closeLabel="Schließen" onClose={() => {}} {...overrides}>
      <ViewerFieldGroup label="Bauteil">
        <ViewerField label="Geschoss">Erdgeschoss</ViewerField>
      </ViewerFieldGroup>
    </ViewerPanel>
  )
}

describe('ViewerPanel', () => {
  it('announces WHAT is selected rather than "complementary"', () => {
    panel()
    expect(screen.getByRole('complementary', { name: 'AW 38' })).toBeInTheDocument()
  })

  it('closes from its own control', async () => {
    const onClose = vi.fn()
    panel({ onClose })
    await userEvent.click(screen.getByRole('button', { name: 'Schließen' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders a subtitle when the selection needs one line of context', () => {
    panel({ subtitle: 'Wand · Erdgeschoss' })
    expect(screen.getByText('Wand · Erdgeschoss')).toBeInTheDocument()
  })

  it('pins a footer action outside the scroll area', () => {
    panel({ footer: <button type="button">Piloti fragen</button> })
    expect(screen.getByRole('button', { name: 'Piloti fragen' })).toBeInTheDocument()
  })
})

describe('ViewerField', () => {
  it('pairs a term with its value as a real definition list', () => {
    panel()
    const term = screen.getByText('Geschoss')
    expect(term.tagName).toBe('DT')
    expect(screen.getByText('Erdgeschoss').tagName).toBe('DD')
  })
})
