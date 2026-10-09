import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'

import { MultiSelect, type MultiSelectOption } from './multi-select'

const OPTIONS: MultiSelectOption[] = [
  { value: 'brandschutz', label: 'Brandschutz', count: 42 },
  { value: 'statik', label: 'Statik', count: 3 },
  { value: 'energie', label: 'Energie & Wärme', count: 0 },
]

function Harness({
  initial = [],
  onChange,
  ...props
}: Partial<React.ComponentProps<typeof MultiSelect>> & { initial?: string[]; onChange?: (next: string[]) => void }) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <MultiSelect
      label="Themen"
      placeholder="Alle Themen"
      searchPlaceholder="Suchen…"
      emptyText="Nichts gefunden"
      options={OPTIONS}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      {...props}
    />
  )
}

describe('MultiSelect', () => {
  it('reads "all" until something is picked', () => {
    render(<Harness />)
    expect(screen.getByRole('combobox', { name: 'Themen' })).toHaveTextContent('Alle Themen')
  })

  it('picks several values with their counts and keeps the list open while picking', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.click(screen.getByRole('combobox', { name: 'Themen' }))
    const list = await screen.findByRole('listbox')
    expect(within(list).getByRole('option', { name: /Brandschutz.*42/ })).toBeInTheDocument()

    await user.click(within(list).getByRole('option', { name: /Statik/ }))
    await user.click(within(list).getByRole('option', { name: /Brandschutz/ }))

    // The value follows the options' order, not the click order.
    expect(onChange).toHaveBeenLastCalledWith(['brandschutz', 'statik'])
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(within(list).getByRole('option', { name: /Statik/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('removes a value from its chip', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={['statik']} onChange={onChange} removeLabel={(name) => `${name} entfernen`} />)

    await user.click(screen.getByRole('button', { name: 'Statik entfernen' }))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.queryByText('Statik')).not.toBeInTheDocument()
  })

  it('removes the last chip with Backspace in an empty search', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={['brandschutz', 'statik']} onChange={onChange} searchable />)

    await user.click(screen.getByRole('combobox', { name: 'Themen' }))
    await user.click(await screen.findByPlaceholderText('Suchen…'))
    await user.keyboard('{Backspace}')
    expect(onChange).toHaveBeenLastCalledWith(['brandschutz'])
  })

  it('narrows the list by label as you type, and says when nothing matches', async () => {
    const user = userEvent.setup()
    render(<Harness searchable />)

    await user.click(screen.getByRole('combobox', { name: 'Themen' }))
    await user.type(await screen.findByPlaceholderText('Suchen…'), 'wärme')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Energie')])

    await user.clear(screen.getByPlaceholderText('Suchen…'))
    await user.type(screen.getByPlaceholderText('Suchen…'), 'xyz')
    expect(screen.getByText('Nichts gefunden')).toBeInTheDocument()
  })

  it('selects with the keyboard', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} searchable />)

    await user.click(screen.getByRole('combobox', { name: 'Themen' }))
    await user.click(await screen.findByPlaceholderText('Suchen…'))
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['statik'])
  })

  it('shows a value the options do not know by its label, and collapses past maxChips', () => {
    render(
      <Harness
        initial={['brandschutz', 'statik', 'org_unknown']}
        labelFor={(value) => (value === 'org_unknown' ? 'Atelier Nord' : value)}
        maxChips={2}
        moreLabel={(count) => `+${count} weitere`}
      />
    )
    expect(screen.getByText('Brandschutz')).toBeInTheDocument()
    expect(screen.getByText('Statik')).toBeInTheDocument()
    expect(screen.queryByText('Atelier Nord')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+1 weitere' })).toBeInTheDocument()
  })

  it('cannot be opened while disabled', async () => {
    const user = userEvent.setup()
    render(<Harness disabled placeholder="Erst eine Organisation wählen" />)

    const trigger = screen.getByRole('combobox', { name: 'Themen' })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
