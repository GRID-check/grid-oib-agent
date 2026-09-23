/**
 * „Recherche planen": a plan written from nothing. Pinned: nothing is sent
 * until there is a question and a section, the plan goes out with the
 * composer's sources and the inventory it was written against, and the
 * thread is re-read so the new run's block appears.
 */

import { fireEvent, render, screen, waitFor } from '@/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/plans/plan-client', () => ({ createPlan: vi.fn() }))
vi.mock('../hooks/use-project-inventory', () => ({
  useProjectInventory: () => ({
    documents: [{ name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project', file: {}, source: 'projekt' }],
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
      dataSources: ['knowledge_base'],
      unterlagen: [{ name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project' }],
    })
    expect(hydrate).toHaveBeenCalledWith('s_conv')
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
