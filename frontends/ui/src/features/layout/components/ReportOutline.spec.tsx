import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { ReportOutline } from './ReportOutline'
import { extractReportOutline } from '../lib/report-outline'

const REPORT = [
  '## Ausgangslage',
  '### Rechtsgrundlagen',
  '## Bewertung',
  '## Quellen',
].join('\n')

const entries = extractReportOutline(REPORT)

/**
 * A stand-in for the browser's observer: happy-dom ships an inert one that
 * never reports, so the current-section mark can only be exercised by driving
 * the callback directly. `report()` says which headings are in the band.
 */
function installObserver() {
  const original = globalThis.IntersectionObserver
  let notify: IntersectionObserverCallback | null = null
  const observed: Element[] = []

  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      notify = callback
    }
    observe(target: Element): void {
      observed.push(target)
    }
    unobserve(): void {}
    disconnect(): void {
      notify = null
    }
  }

  globalThis.IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof globalThis.IntersectionObserver

  return {
    observed,
    report(ids: string[]) {
      const seen = new Set(ids)
      act(() => {
        notify?.(
          observed.map(
            (target) =>
              ({
                target,
                isIntersecting: seen.has(target.id),
              }) as unknown as IntersectionObserverEntry
          ),
          null as unknown as IntersectionObserver
        )
      })
    },
    restore() {
      globalThis.IntersectionObserver = original
    },
  }
}

/** The headings the outline links to, as the report renders them. */
function renderWithHeadings() {
  const document_ = (
    <div>
      <ReportOutline entries={entries} />
      {entries.map((entry) => (
        <h2 key={entry.key} id={entry.id}>
          {entry.text}
        </h2>
      ))}
    </div>
  )
  return render(document_)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReportOutline', () => {
  test('renders nothing when there is nothing to navigate', () => {
    const { container } = render(<ReportOutline entries={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  test('is a landmark with a named toggle, collapsed to one row', () => {
    renderWithHeadings()

    const outline = screen.getByRole('navigation', { name: /report outline/i })
    const toggle = within(outline).getByRole('button', { name: /outline/i })

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(outline).queryByRole('link', { name: 'Ausgangslage' })).not.toBeInTheDocument()
  })

  test('opening it lists every heading, in document order, as a link to its anchor', async () => {
    const user = userEvent.setup()
    renderWithHeadings()

    await user.click(screen.getByRole('button', { name: /outline/i }))

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Ausgangslage',
      'Rechtsgrundlagen',
      'Bewertung',
      'Quellen',
    ])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#ausgangslage',
      '#rechtsgrundlagen',
      '#bewertung',
      '#quellen',
    ])
  })

  test('the toggle is keyboard operable and reports its state', async () => {
    const user = userEvent.setup()
    renderWithHeadings()

    const toggle = screen.getByRole('button', { name: /outline/i })
    await user.tab()
    expect(toggle).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // The entries follow the toggle in the tab order.
    await user.tab()
    expect(screen.getByRole('link', { name: 'Ausgangslage' })).toHaveFocus()
  })

  test('choosing a section scrolls it into view and gives the screen back', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
    renderWithHeadings()

    await user.click(screen.getByRole('button', { name: /outline/i }))
    await user.click(screen.getByRole('link', { name: 'Bewertung' }))

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /outline/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  test('a reader who prefers reduced motion is not scrolled smoothly', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList)
    renderWithHeadings()

    await user.click(screen.getByRole('button', { name: /outline/i }))
    await user.click(screen.getByRole('link', { name: 'Bewertung' }))

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })

  test('marks the section in view, and names it on the collapsed row', async () => {
    const observer = installObserver()
    try {
      const user = userEvent.setup()
      renderWithHeadings()

      expect(observer.observed.map((element) => element.id)).toEqual([
        'ausgangslage',
        'rechtsgrundlagen',
        'bewertung',
        'quellen',
      ])

      observer.report(['bewertung'])
      // The collapsed row carries the answer without being opened.
      expect(screen.getByRole('button', { name: /Bewertung/ })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /outline/i }))
      expect(screen.getByRole('link', { name: 'Bewertung' })).toHaveAttribute(
        'aria-current',
        'location'
      )
      expect(screen.getByRole('link', { name: 'Ausgangslage' })).not.toHaveAttribute('aria-current')
    } finally {
      observer.restore()
    }
  })

  test('the highest heading in the band wins, and mid-section the mark stays put', async () => {
    const observer = installObserver()
    try {
      const user = userEvent.setup()
      renderWithHeadings()
      await user.click(screen.getByRole('button', { name: /outline/i }))

      observer.report(['rechtsgrundlagen', 'bewertung'])
      expect(screen.getByRole('link', { name: 'Rechtsgrundlagen' })).toHaveAttribute(
        'aria-current',
        'location'
      )

      // Scrolled past every heading: the reader is still inside the last
      // section they entered, so the mark does not wander back to the top.
      observer.report([])
      expect(screen.getByRole('link', { name: 'Rechtsgrundlagen' })).toHaveAttribute(
        'aria-current',
        'location'
      )
    } finally {
      observer.restore()
    }
  })

  test('above the first heading the first section is marked', () => {
    const observer = installObserver()
    try {
      renderWithHeadings()

      observer.report([])

      expect(screen.getByRole('button', { name: /Ausgangslage/ })).toBeInTheDocument()
    } finally {
      observer.restore()
    }
  })
})
