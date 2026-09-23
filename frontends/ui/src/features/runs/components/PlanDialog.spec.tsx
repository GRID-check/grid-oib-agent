/**
 * „Recherche planen": a plan written from nothing. Pinned: nothing is sent
 * until there is a question and a section, the plan goes out with the
 * composer's sources and the inventory it was written against, and the
 * thread is re-read so the new run's block appears.
 */

import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/plans/plan-client', () => ({ createPlan: vi.fn() }))
vi.mock('@/features/documents/hooks/use-document-library', () => ({
  useDocumentLibrary: () => ({
    documents: [{ name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project', file: {} }],
    folders: [],
    loading: false,
  }),
}))

import { useChatStore } from '@/features/chat/store'
import { useLayoutStore } from '@/features/layout/store'
import { createPlan } from '@/lib/plans/plan-client'
import { PlanDialog } from './PlanDialog'

const hydrate = vi.fn(async () => undefined)

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({ hydrateConversationMessages: hydrate } as never)
  useLayoutStore.setState({ enabledDataSourceIds: ['knowledge_base'] } as never)
  vi.mocked(createPlan).mockResolvedValue({ plan: {}, run: {} } as never)
})

describe('PlanDialog', () => {
  it('creates the plan and its run, then re-reads the thread and closes', async () => {
    const onOpenChange = vi.fn()
    render(<PlanDialog open onOpenChange={onOpenChange} projectId="proj" conversationId="s_conv" />)
    const submit = screen.getByTestId('plan-dialog-submit')
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByTestId('plan-dialog-question'), { target: { value: 'Fluchtwege prüfen' } })
    const add = screen.getByRole('textbox', { name: /add a section/i })
    fireEvent.change(add, { target: { value: 'Bestand' } })
    fireEvent.keyDown(add, { key: 'Enter' })
    expect(submit).toBeEnabled()

    fireEvent.click(submit)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(createPlan).toHaveBeenCalledWith('proj', {
      conversationId: 's_conv',
      question: 'Fluchtwege prüfen',
      sections: ['Bestand'],
      genre: 'bericht',
      depth: 'gutachten',
      grundlage: [],
      ausgeschlossen: [],
      nurGrundlage: false,
      dataSources: ['knowledge_base'],
      unterlagen: [{ name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project' }],
    })
    expect(hydrate).toHaveBeenCalledWith('s_conv')
  })

  it('starts from a ready outline, and says what is still missing', () => {
    render(<PlanDialog open onOpenChange={vi.fn()} projectId="proj" conversationId="s_conv" />)
    const missing = screen.getByTestId('plan-dialog-missing')
    expect(missing.querySelectorAll('[data-met]')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('plan-use-template'))
    expect(screen.getAllByTestId('plan-point')).toHaveLength(5)
    expect(missing.querySelectorAll('[data-met]')).toHaveLength(1)
    // The preview shows the outline as the block will.
    expect(screen.getByTestId('plan-dialog-preview')).toHaveTextContent('Starting point')
  })

  it('sends „Nur ausgewählte" with the documents it confines to', async () => {
    render(<PlanDialog open onOpenChange={vi.fn()} projectId="proj" conversationId="s_conv" />)
    fireEvent.change(screen.getByTestId('plan-dialog-question'), { target: { value: 'Frage' } })
    fireEvent.click(screen.getByTestId('plan-use-template'))
    fireEvent.click(screen.getByRole('radio', { name: /only selected/i }))
    // With nothing chosen yet, „Nur ausgewählte" opens the picker.
    const picker = screen.getByTestId('document-picker')
    fireEvent.click(within(picker).getAllByTestId('picker-doc')[0])
    fireEvent.click(within(picker).getByTestId('picker-confirm'))
    fireEvent.click(screen.getByTestId('plan-dialog-submit'))
    await waitFor(() => expect(createPlan).toHaveBeenCalled())
    expect(vi.mocked(createPlan).mock.calls[0][1]).toMatchObject({
      grundlage: ['Einreichplan.pdf'],
      ausgeschlossen: [],
      nurGrundlage: true,
    })
  })

  it('says so when the plan could not be created, and stays open', async () => {
    vi.mocked(createPlan).mockRejectedValue(new Error('500'))
    const onOpenChange = vi.fn()
    render(<PlanDialog open onOpenChange={onOpenChange} projectId="proj" conversationId="s_conv" />)
    fireEvent.change(screen.getByTestId('plan-dialog-question'), { target: { value: 'Frage' } })
    const add = screen.getByRole('textbox', { name: /add a section/i })
    fireEvent.change(add, { target: { value: 'A' } })
    fireEvent.keyDown(add, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('plan-dialog-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be created')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
