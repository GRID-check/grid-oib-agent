import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { Pagination } from './pagination'

const base = {
  pageSize: 10,
  onOffsetChange: vi.fn(),
  rangeLabel: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
  previousLabel: 'Previous',
  nextLabel: 'Next',
}

describe('Pagination', () => {
  test('renders nothing when everything fits on one page', () => {
    // The range label would only restate the row count already on screen.
    const { container } = render(<Pagination {...base} offset={0} total={7} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('states the visible range against the true total', () => {
    render(<Pagination {...base} offset={0} total={42} />)
    expect(screen.getByText('1–10 of 42')).toBeDefined()
  })

  test('clamps the final page to the total rather than the page size', () => {
    render(<Pagination {...base} offset={40} total={42} />)
    expect(screen.getByText('41–42 of 42')).toBeDefined()
  })

  test('disables previous on the first page and next on the last', () => {
    const { rerender } = render(<Pagination {...base} offset={0} total={42} />)
    expect(screen.getByRole('button', { name: /Previous/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /Next/ })).toHaveProperty('disabled', false)

    rerender(<Pagination {...base} offset={40} total={42} />)
    expect(screen.getByRole('button', { name: /Previous/ })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: /Next/ })).toHaveProperty('disabled', true)
  })

  test('steps by a page in each direction', async () => {
    const onOffsetChange = vi.fn()
    render(<Pagination {...base} offset={10} total={42} onOffsetChange={onOffsetChange} />)

    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(onOffsetChange).toHaveBeenLastCalledWith(20)

    await userEvent.click(screen.getByRole('button', { name: /Previous/ }))
    expect(onOffsetChange).toHaveBeenLastCalledWith(0)
  })

  test('never steps back past the start', async () => {
    const onOffsetChange = vi.fn()
    render(<Pagination {...base} offset={5} total={42} onOffsetChange={onOffsetChange} />)

    await userEvent.click(screen.getByRole('button', { name: /Previous/ }))
    expect(onOffsetChange).toHaveBeenLastCalledWith(0)
  })
})
