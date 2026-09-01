import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './page-header'

/**
 * The header shipped as an unconditional flex row whose action was `shrink-0`.
 * That is a promise a phone cannot keep: the action takes its natural width — a
 * 256px search field, a toggle group — and the title column absorbs the whole
 * shortfall. Measured on `/dev/project-chrome` at 390px, History's subtitle
 * rendered 44px wide across 8 lines, one word per line, with the action holding
 * 266px of the 326px available.
 *
 * `projects-grid` had patched around it locally, so the defect was known at one
 * call site while the six project sections reaching this through
 * `ProjectSectionFrame` inherited none of the fix. These hold it in the
 * primitive, where it belongs.
 */
describe('PageHeader', () => {
  it('stacks the title above the action on a narrow viewport', () => {
    const { container } = render(
      <PageHeader
        title="History"
        subtitle="Every conversation and deep-research run in this project."
        action={<input aria-label="Search" className="w-full sm:w-64" />}
      />,
    )
    const row = container.querySelector('header')!
    // Stacked below `sm`, side by side at `sm` and up.
    expect(row.className).toContain('flex-col')
    expect(row.className).toContain('sm:flex-row')
    // Stretched while stacked, or a child's `w-full` has no width to resolve
    // against and the field collapses to its content.
    expect(row.className).toContain('items-stretch')
  })

  /**
   * Stacking fixed the phone and left the laptop broken.
   *
   * In the row the action was still `sm:shrink-0`, so above 640px it kept its
   * natural width and the title column was the only side that could give.
   * Project → Dateien is the case that showed it: a view toggle, a filter menu,
   * a `lg:w-72` search field and an upload button against the ~900px a header
   * gets inside the sidebar, and the German subtitle came out as a
   * one-to-two-word column. These two assertions are the fix, and they only
   * work as a pair — a floor with a `shrink-0` action overflows the row
   * instead.
   */
  it('gives the title a floor so the action is the side that yields', () => {
    const { container } = render(
      <PageHeader title="History" subtitle="Every conversation." action={<button type="button">New</button>} />,
    )
    const titleColumn = container.querySelector('h1')!.parentElement!
    expect(titleColumn.className).toContain('sm:min-w-56')
    // Still `min-w-0` below `sm`, where the row is stacked and the title
    // already owns the width.
    expect(titleColumn.className.split(/\s+/)).toContain('min-w-0')
  })

  it('never lets the action refuse to shrink', () => {
    const { container } = render(
      <PageHeader title="History" action={<button type="button">New</button>} />,
    )
    const wrapper = screen.getByRole('button', { name: 'New' }).parentElement!
    // `shrink-0` in ANY form is the bug — unqualified it holds the action at
    // natural width on a phone, and `sm:`-qualified it does the same on a
    // laptop. The action rows below this are `flex-wrap`; that wrap is dead
    // code while the box is never narrower than its content.
    expect(wrapper.className).not.toContain('shrink-0')
    expect(wrapper.className.split(/\s+/)).toContain('min-w-0')
    expect(container.querySelector('h1')).toHaveTextContent('History')
  })

  it('keeps the documented title size', () => {
    render(<PageHeader title="History" />)
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('text-xl')
  })
})
