/**
 * The Unterlagen picker: one list, two uses. What is pinned is the contract
 * the callers rely on — a row's role is exclusive (Read beats Exclude and
 * vice versa), the search matches name and title alike, and an add closes the
 * dialog with the document the run is told about.
 */

import { fireEvent, render, screen, within } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { UnterlagenDialog } from './UnterlagenDialog'

const documents: PlanDocument[] = [
  { name: 'einreichplan_v3.pdf', title: 'Einreichplan', shelf: 'project' },
  { name: 'Brandschutzkonzept.pdf', shelf: 'project' },
  { name: 'OIB-RL 2 Leitfaden.pdf', title: 'Leitfaden OIB 2', shelf: 'archiv' },
]

const rows = () => screen.getAllByTestId('unterlagen-row')

describe('UnterlagenDialog', () => {
  describe('pick', () => {
    it('lists every document under its title and reads the roles it was given', () => {
      render(
        <UnterlagenDialog
          mode="pick"
          open
          onOpenChange={() => undefined}
          documents={documents}
          grundlage={['einreichplan_v3.pdf']}
          ausgeschlossen={['brandschutzkonzept.pdf']}
          onChange={() => undefined}
        />
      )
      expect(screen.getByTestId('unterlagen-dialog')).toBeInTheDocument()
      expect(rows()).toHaveLength(3)
      expect(rows()[0]).toHaveAttribute('data-role', 'grundlage')
      expect(rows()[0]).toHaveTextContent('Einreichplan')
      // The role match folds case: the plan's edit and the inventory may spell the name apart.
      expect(rows()[1]).toHaveAttribute('data-role', 'ausgeschlossen')
      expect(rows()[2]).not.toHaveAttribute('data-role')
    })

    it('names a row Read or Excluded, never both, and clears it on a second press', () => {
      const onChange = vi.fn()
      render(
        <UnterlagenDialog
          mode="pick"
          open
          onOpenChange={() => undefined}
          documents={documents}
          grundlage={['einreichplan_v3.pdf']}
          ausgeschlossen={[]}
          onChange={onChange}
        />
      )
      const first = rows()[0]
      fireEvent.click(within(first).getByRole('button', { name: /Exclude: Einreichplan/ }))
      expect(onChange).toHaveBeenLastCalledWith({
        grundlage: [],
        ausgeschlossen: ['einreichplan_v3.pdf'],
      })
      fireEvent.click(within(first).getByRole('button', { name: /Read in full: Einreichplan/ }))
      expect(onChange).toHaveBeenLastCalledWith({ grundlage: [], ausgeschlossen: [] })
    })

    it('filters by title and by file name', () => {
      render(
        <UnterlagenDialog
          mode="pick"
          open
          onOpenChange={() => undefined}
          documents={documents}
          grundlage={[]}
          ausgeschlossen={[]}
          onChange={() => undefined}
        />
      )
      fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), {
        target: { value: 'oib' },
      })
      expect(rows()).toHaveLength(1)
      expect(rows()[0]).toHaveTextContent('Leitfaden OIB 2')
      fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), {
        target: { value: 'nichts' },
      })
      expect(screen.queryAllByTestId('unterlagen-row')).toHaveLength(0)
      expect(screen.getByText('No documents match.')).toBeInTheDocument()
    })
  })

  describe('add', () => {
    it('adds a row the run has not been told about and closes; a named row offers no add', () => {
      const onAdd = vi.fn()
      const onOpenChange = vi.fn()
      render(
        <UnterlagenDialog
          mode="add"
          open
          onOpenChange={onOpenChange}
          documents={documents}
          named={['Einreichplan_v3.pdf']}
          onAdd={onAdd}
        />
      )
      expect(within(rows()[0]).queryByRole('button')).toBeNull()
      expect(rows()[0]).toHaveTextContent('named')
      fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Add Brandschutzkonzept.pdf' }))
      expect(onAdd).toHaveBeenCalledWith(documents[1])
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('says it is loading while the inventory has not arrived', () => {
      render(
        <UnterlagenDialog
          mode="add"
          open
          onOpenChange={() => undefined}
          documents={[]}
          loading
          named={[]}
          onAdd={() => undefined}
        />
      )
      expect(screen.getByText('Loading documents …')).toBeInTheDocument()
    })
  })
})
