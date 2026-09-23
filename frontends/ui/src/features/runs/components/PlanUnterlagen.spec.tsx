/**
 * The plan's document step. Pinned: by default the research reads every
 * document and a choice only sets its focus; „Nur ausgewählte" confines the
 * reader's documents to the chosen ones and drops the exclusions beside it;
 * choosing happens in the document picker, which rules out a document already
 * on the other list and says why; picked documents travel back to the plan.
 */

import { fireEvent, render, screen, within } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { PickerDocument } from '@/features/documents/components/document-picker/DocumentPickerDialog'
import { PlanUnterlagen } from './PlanUnterlagen'

const documents: PickerDocument[] = [
  { name: 'einreichplan_v3.pdf', title: 'Einreichplan', shelf: 'project' },
  { name: 'Brandschutzkonzept.pdf', shelf: 'project' },
  { name: 'Leitfaden.pdf', title: 'Leitfaden OIB 2', shelf: 'archiv' },
]

const renderStep = (props: Partial<Parameters<typeof PlanUnterlagen>[0]> = {}) => {
  const onChange = vi.fn()
  const onBrowse = vi.fn()
  render(
    <PlanUnterlagen
      documents={documents}
      grundlage={[]}
      ausgeschlossen={[]}
      nurGrundlage={false}
      onBrowse={onBrowse}
      onChange={onChange}
      {...props}
    />
  )
  return { onChange, onBrowse }
}

describe('PlanUnterlagen', () => {
  it('reads everything by default and says so; a focus is chosen in the picker', () => {
    const { onChange, onBrowse } = renderStep()
    expect(screen.getByTestId('plan-unterlagen')).toHaveAttribute('data-scope', 'alle')
    expect(screen.getByTestId('plan-unterlagen-scope-hint')).toHaveTextContent('can read every document')
    fireEvent.click(screen.getByTestId('plan-unterlagen-pick'))
    expect(onBrowse).toHaveBeenCalled()
    const picker = screen.getByTestId('document-picker')
    expect(picker).toHaveTextContent('Choose a focus')
    fireEvent.click(within(picker).getAllByTestId('picker-doc')[1])
    fireEvent.click(within(picker).getByTestId('picker-confirm'))
    expect(onChange).toHaveBeenLastCalledWith({
      grundlage: ['einreichplan_v3.pdf'],
      ausgeschlossen: [],
      nurGrundlage: false,
      picked: [{ name: 'einreichplan_v3.pdf', title: 'Einreichplan', shelf: 'project' }],
    })
  })

  it('rules a focus out of the exclusion picker, and says why', () => {
    renderStep({ grundlage: ['einreichplan_v3.pdf'] })
    fireEvent.click(screen.getByTestId('plan-unterlagen-exclude'))
    const row = within(screen.getByTestId('document-picker'))
      .getAllByTestId('picker-doc')
      .find((item) => item.textContent?.includes('Einreichplan'))
    expect(row).toHaveTextContent('Focus')
    expect(row).toHaveAttribute('aria-disabled', 'true')
  })

  it('„Nur ausgewählte" confines to the chosen documents and drops the exclusions', () => {
    const { onChange } = renderStep({ grundlage: ['einreichplan_v3.pdf'], ausgeschlossen: ['Brandschutzkonzept.pdf'] })
    fireEvent.click(screen.getByRole('radio', { name: /only selected/i }))
    expect(onChange).toHaveBeenLastCalledWith({
      grundlage: ['einreichplan_v3.pdf'],
      ausgeschlossen: [],
      nurGrundlage: true,
      picked: [],
    })
  })

  it('under „Nur ausgewählte" names the chosen as the only ones and offers no exclusion', () => {
    renderStep({ grundlage: ['einreichplan_v3.pdf'], nurGrundlage: true })
    expect(screen.getByTestId('plan-unterlagen-scope-hint')).toHaveTextContent('Regulations and standards stay available')
    expect(screen.getByTestId('plan-grundlage')).toHaveTextContent('Only these:')
    expect(screen.queryByTestId('plan-unterlagen-exclude')).toBeNull()
  })

  it('switching to „Nur ausgewählte" with nothing chosen opens the picker', () => {
    renderStep()
    fireEvent.click(screen.getByRole('radio', { name: /only selected/i }))
    expect(screen.getByTestId('document-picker')).toHaveTextContent('Documents for this research')
  })

  it('strikes a chosen document from its chip', () => {
    const { onChange } = renderStep({ grundlage: ['einreichplan_v3.pdf', 'Brandschutzkonzept.pdf'] })
    fireEvent.click(screen.getByRole('button', { name: 'No longer selected: Einreichplan' }))
    expect(onChange.mock.calls[0][0].grundlage).toEqual(['Brandschutzkonzept.pdf'])
  })
})
