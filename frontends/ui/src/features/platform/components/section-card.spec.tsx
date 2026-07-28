import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { BookOpenCheck } from 'lucide-react'
import { SectionCard } from './section-card'

/**
 * The point of this component is that every platform section shares ONE
 * loading / error / empty treatment. These tests pin that contract, because
 * the failure mode it replaces was each surface quietly growing its own.
 */
describe('SectionCard', () => {
  test('renders children in the resolved state', () => {
    render(
      <SectionCard title="Base knowledge" description="The shared corpus.">
        <p>42 documents</p>
      </SectionCard>,
    )

    expect(screen.getByText('Base knowledge')).toBeDefined()
    expect(screen.getByText('The shared corpus.')).toBeDefined()
    expect(screen.getByText('42 documents')).toBeDefined()
  })

  test('shows skeletons instead of children while loading', () => {
    render(
      <SectionCard title="Base knowledge" loading skeletonRows={4}>
        <p>42 documents</p>
      </SectionCard>,
    )

    expect(screen.getByTestId('section-loading').children).toHaveLength(4)
    expect(screen.queryByText('42 documents')).toBeNull()
  })

  test('hides the header action while loading, so nothing is clickable mid-fetch', () => {
    const { rerender } = render(
      <SectionCard title="Base knowledge" loading action={<button type="button">Add documents</button>} />,
    )
    expect(screen.queryByRole('button', { name: 'Add documents' })).toBeNull()

    rerender(<SectionCard title="Base knowledge" action={<button type="button">Add documents</button>} />)
    expect(screen.getByRole('button', { name: 'Add documents' })).toBeDefined()
  })

  test('offers a retry on error and calls back', async () => {
    const onRetry = vi.fn()
    render(<SectionCard title="Base knowledge" error errorMessage="Could not load it." onRetry={onRetry} />)

    expect(screen.getByText('Could not load it.')).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('keeps showing the error while a retry is in flight', () => {
    // A retry flips `loading` back on. Falling through to the skeleton would
    // hide the button the user just pressed and read as "nothing happened".
    render(<SectionCard title="Base knowledge" error loading onRetry={() => undefined} />)

    expect(screen.queryByTestId('section-loading')).toBeNull()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeDefined()
  })

  test('renders the empty state instead of children', () => {
    render(
      <SectionCard title="Base knowledge" empty emptyIcon={BookOpenCheck} emptyTitle="No documents yet">
        <p>42 documents</p>
      </SectionCard>,
    )

    expect(screen.getByText('No documents yet')).toBeDefined()
    expect(screen.queryByText('42 documents')).toBeNull()
  })

  test('loading wins over empty — an unfetched section is not an empty one', () => {
    render(<SectionCard title="Base knowledge" loading empty emptyTitle="No documents yet" />)

    expect(screen.getByTestId('section-loading')).toBeDefined()
    expect(screen.queryByText('No documents yet')).toBeNull()
  })
})
