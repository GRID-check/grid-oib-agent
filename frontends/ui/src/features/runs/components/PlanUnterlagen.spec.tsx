/**
 * The plan's document step. Pinned: by default nothing needs doing, and the
 * step says so in a sentence that names the sources the run searches; the one
 * main action chooses documents to read first, in the document picker;
 * „Nur diese verwenden" is a checkbox inside that picker and confines the
 * reader's own documents to the chosen ones, keeping the exclusions; excluding
 * is behind the disclosure, whose trigger says when something is set; each
 * picker rules out a document already on the other list and says why; picked
 * documents travel back to the plan.
 */

import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { libraryDocument } from '@/test-utils/library-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanUnterlagen } from './PlanUnterlagen'

const library = [
  libraryDocument('einreichplan_v3.pdf', { title: 'Einreichplan' }),
  libraryDocument('Brandschutzkonzept.pdf'),
  libraryDocument('Leitfaden.pdf', { title: 'Leitfaden OIB 2', shelf: 'archiv' }),
]

const renderStep = (props: Partial<Parameters<typeof PlanUnterlagen>[0]> = {}) => {
  const onChange = vi.fn()
  const onBrowse = vi.fn()
  render(
    <PlanUnterlagen
      library={library}
      known={[]}
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

const cardNamed = (name: string) =>
  within(screen.getByTestId('document-picker'))
    .getAllByTestId('file-card')
    .find((card) => card.textContent?.includes(name))

describe('PlanUnterlagen', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 }))))
  afterEach(() => vi.unstubAllGlobals())

  it('says what happens by default, naming the sources the run searches', () => {
    renderStep({ sources: ['Wissensbasis', 'Projektunterlagen'] })
    const line = screen.getByTestId('plan-unterlagen-default')
    expect(line).toHaveTextContent('Piloti searches')
    expect(line).toHaveTextContent('Wissensbasis')
    expect(line).toHaveTextContent('picks what fits the question')
    expect(screen.getByTestId('plan-unterlagen')).toHaveAttribute('data-scope', 'alle')
  })

  it('chooses documents to read first in the picker, and hands them back', () => {
    const { onChange, onBrowse } = renderStep()
    fireEvent.click(screen.getByTestId('plan-unterlagen-pick'))
    expect(onBrowse).toHaveBeenCalled()
    expect(screen.getByTestId('document-picker')).toHaveTextContent('Which documents should Piloti read first?')
    fireEvent.click(cardNamed('Einreichplan')!)
    fireEvent.click(screen.getByTestId('picker-confirm'))
    expect(onChange).toHaveBeenLastCalledWith({
      grundlage: ['einreichplan_v3.pdf'],
      ausgeschlossen: [],
      nurGrundlage: false,
      picked: [{ name: 'einreichplan_v3.pdf', title: 'Einreichplan', shelf: 'project' }],
    })
  })

  it('„Use only these" in the picker confines to the chosen, and keeps the exclusions', () => {
    const { onChange } = renderStep({ grundlage: ['einreichplan_v3.pdf'], ausgeschlossen: ['Brandschutzkonzept.pdf'] })
    fireEvent.click(screen.getByTestId('plan-unterlagen-pick'))
    fireEvent.click(screen.getByTestId('plan-only-these'))
    fireEvent.click(screen.getByTestId('picker-confirm'))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        grundlage: ['einreichplan_v3.pdf'],
        ausgeschlossen: ['Brandschutzkonzept.pdf'],
        nurGrundlage: true,
      })
    )
  })

  it('under „Only these" names the chosen as the only ones and says what stays available', () => {
    renderStep({ grundlage: ['einreichplan_v3.pdf'], nurGrundlage: true })
    expect(screen.getByTestId('plan-unterlagen')).toHaveAttribute('data-scope', 'nur')
    expect(screen.getByTestId('plan-grundlage')).toHaveTextContent('Only these:')
    expect(screen.getByTestId('plan-unterlagen')).toHaveTextContent('Regulations and standards stay available')
  })

  it('keeps excluding behind the disclosure, whose trigger says what is set', async () => {
    renderStep({ ausgeschlossen: ['Brandschutzkonzept.pdf'] })
    const trigger = screen.getByTestId('plan-unterlagen-advanced')
    expect(trigger).toHaveTextContent('1 excluded')
    expect(screen.queryByTestId('plan-unterlagen-exclude')).toBeNull()
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByTestId('plan-ausgeschlossen')).toHaveTextContent('Brandschutzkonzept'))
  })

  it('rules a document read first out of the exclusion picker, and says why', async () => {
    renderStep({ grundlage: ['einreichplan_v3.pdf'] })
    fireEvent.click(screen.getByTestId('plan-unterlagen-advanced'))
    fireEvent.click(await screen.findByTestId('plan-unterlagen-exclude'))
    const card = cardNamed('Einreichplan')
    expect(card).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('file-card-reason')).toHaveTextContent('Read first')
  })

  it('striking the last document read first also lifts „Only these"', () => {
    const { onChange } = renderStep({ grundlage: ['einreichplan_v3.pdf'], nurGrundlage: true })
    fireEvent.click(screen.getByRole('button', { name: 'No longer selected: Einreichplan' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ grundlage: [], nurGrundlage: false }))
  })
})
