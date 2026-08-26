import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './page-header'

/**
 * The header shipped as an unconditional flex row whose action was `shrink-0`.
 * That is a promise a phone cannot keep: the action takes its natural width — a
 * 256px search field, a toggle group — and the title column absorbs the whole
 * shortfall. Measured on `/dev/project-chrome` at 390px, the left column
 * rendered 44px wide with the action holding 266px of the 326px available; the
 * Files title came out as "Fi".
 *
 * `projects-grid` had patched around it locally, so the defect was known at one
 * call site while the six project sections reaching this through
 * `ProjectSectionFrame` inherited none of the fix. These hold it in the
 * primitive, where it belongs.
 *
 * The subtitle and breadcrumb slots this originally also covered are gone — the
 * header is one line now — so the symptom these guard is the title itself.
 */
describe('PageHeader', () => {
  it('stacks the title above the action on a narrow viewport', () => {
    const { container } = render(
      <PageHeader title="History" action={<input aria-label="Search" className="w-full sm:w-64" />} />,
    )
    const row = container.querySelector('header')!
    // Stacked below `sm`, side by side at `sm` and up.
    expect(row.className).toContain('flex-col')
    expect(row.className).toContain('sm:flex-row')
    // Stretched while stacked, or a child's `w-full` has no width to resolve
    // against and the field collapses to its content.
    expect(row.className).toContain('items-stretch')
  })

  it('never lets the action refuse to shrink while it is stacked', () => {
    const { container } = render(
      <PageHeader title="History" action={<button type="button">New</button>} />,
    )
    const wrapper = screen.getByRole('button', { name: 'New' }).parentElement!
    // `shrink-0` unqualified is the bug: it holds the action at natural width on
    // a phone. It may only apply once the row exists.
    expect(wrapper.className).toContain('sm:shrink-0')
    expect(wrapper.className.split(/\s+/)).not.toContain('shrink-0')
    expect(container.querySelector('h1')).toHaveTextContent('History')
  })

  it('keeps the documented title size, and truncates rather than crushing', () => {
    render(<PageHeader title="History" />)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.className).toContain('text-xl')
    // The row still applies on a narrow desktop, where stacking does not help.
    expect(heading.className).toContain('truncate')
  })
})
