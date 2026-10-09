import { useState } from 'react'
import { fireEvent, render, screen } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defaultTagNormalize, TagInput } from './tag-input'

/** A controlled harness, so the spec sees the list the way a form would hold it. */
function Harness({
  initial = [],
  readOnly = false,
  onChange,
}: {
  initial?: string[]
  readOnly?: boolean
  onChange?: (next: string[]) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <TagInput
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      readOnly={readOnly}
      aria-label="Terms"
      removeLabel={(tag) => `Remove ${tag}`}
      emptyLabel="No terms"
    />
  )
}

const chips = (): string[] =>
  screen.queryAllByRole('listitem').map((item) => item.textContent ?? '')

describe('TagInput', () => {
  it('adds the typed value on Enter and clears the field', () => {
    render(<Harness />)
    const input = screen.getByRole('textbox', { name: 'Terms' })
    fireEvent.change(input, { target: { value: '  Rechnung ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chips()).toEqual(['Rechnung'])
    expect(input).toHaveValue('')
  })

  it('removes one chip with its own button', () => {
    render(<Harness initial={['Rechnung', 'Lohn']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Rechnung' }))
    expect(chips()).toEqual(['Lohn'])
  })

  it('does not add a value that is already there, whatever its case', () => {
    const onChange = vi.fn()
    render(<Harness initial={['Rechnung']} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Terms' })
    fireEvent.change(input, { target: { value: 'RECHNUNG' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chips()).toEqual(['Rechnung'])
    expect(input).toHaveValue('')
  })

  it('adds every entry of a pasted list', () => {
    render(<Harness />)
    const input = screen.getByRole('textbox', { name: 'Terms' })
    fireEvent.paste(input, { clipboardData: { getData: () => 'Lohn, Gehalt;\nLohn\nSteuer' } })
    expect(chips()).toEqual(['Lohn', 'Gehalt', 'Steuer'])
  })

  it('adds what was typed when the field loses focus, so a Save right after keeps it', () => {
    render(<Harness />)
    const input = screen.getByRole('textbox', { name: 'Terms' })
    fireEvent.change(input, { target: { value: 'Honorar' } })
    fireEvent.blur(input)
    expect(chips()).toEqual(['Honorar'])
  })

  it('removes the last chip on Backspace in the empty field', () => {
    render(<Harness initial={['Rechnung', 'Lohn']} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Terms' }), { key: 'Backspace' })
    expect(chips()).toEqual(['Rechnung'])
  })

  it('read-only shows the chips without remove buttons or a typing surface', () => {
    render(<Harness initial={['Rechnung']} readOnly />)
    expect(chips()).toEqual(['Rechnung'])
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('read-only and empty says so', () => {
    render(<Harness readOnly />)
    expect(screen.getByText('No terms')).toBeInTheDocument()
  })

  it('the default normalize trims, drops empties and keeps the first spelling', () => {
    expect(defaultTagNormalize([' a ', '', 'A', 'b'])).toEqual(['a', 'b'])
  })
})
