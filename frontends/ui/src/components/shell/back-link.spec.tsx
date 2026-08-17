import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { BackLink } from './back-link'
import { writeTrail, type ReturnTrail } from '@/lib/navigation/return-trail'

const visits = (...paths: string[]): ReturnTrail => paths.map((path) => ({ path }))

const back = vi.fn()
let pathname = '/app/archiv'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}))

function renderBackLink() {
  return render(<BackLink fallbackHref="/app/projects" fallbackLabel="Back to projects" />)
}

/**
 * How many entries the tab's history holds. A test document has one, and the
 * control deliberately refuses to go "back" to nothing (a link opened in a new
 * tab copies the trail but not the history), so the normal case has to say so.
 */
function setHistoryLength(length: number): void {
  Object.defineProperty(window.history, 'length', { configurable: true, get: () => length })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  pathname = '/app/archiv'
  setHistoryLength(3)
})

describe('BackLink — where it points', () => {
  test('falls back to the server-resolved link when the tab has no trail', async () => {
    renderBackLink()
    const link = screen.getByTestId('back-link')
    await waitFor(() => expect(link).toHaveTextContent('Back to projects'))
    expect(link).toHaveAttribute('href', '/app/projects')
  })

  test('points at the page the reader actually came from, and names it', async () => {
    writeTrail(visits('/app/projects/p1/files', '/app/archiv'))
    renderBackLink()

    const link = screen.getByTestId('back-link')
    // The name comes from the destination's own nav entry (`nav.sections.files`).
    await waitFor(() => expect(link).toHaveTextContent('Back to Files'))
    expect(link).toHaveAttribute('href', '/app/projects/p1/files')
  })

  test('names the PROJECT the reader came out of, when the project said its name', async () => {
    writeTrail([
      { path: '/app/projects/p1/files', label: 'Stadthaus Wien' },
      { path: '/app/archiv' },
    ])
    renderBackLink()

    const link = screen.getByTestId('back-link')
    // Not "Back to Files": leaving that project is what the reader is undoing.
    await waitFor(() => expect(link).toHaveTextContent('Back to Stadthaus Wien'))
    expect(link).toHaveAttribute('href', '/app/projects/p1/files')
  })

  test('says only "Back" for a real page it cannot name', async () => {
    writeTrail(visits('/app/onboarding/organization', '/app/archiv'))
    renderBackLink()

    const link = screen.getByTestId('back-link')
    await waitFor(() => expect(link).toHaveTextContent('Back'))
    expect(link).toHaveTextContent(/^Back$/)
    expect(link).toHaveAttribute('href', '/app/onboarding/organization')
  })

  test('ignores a trail that has moved past this page', async () => {
    writeTrail(visits('/app/projects/p1/files', '/app/archiv', '/app/inbox'))
    renderBackLink()

    const link = screen.getByTestId('back-link')
    await waitFor(() => expect(link).toHaveTextContent('Back to projects'))
    expect(link).toHaveAttribute('href', '/app/projects')
  })
})

describe('BackLink — how it navigates', () => {
  test('goes back through history, so the page is restored as it was left', async () => {
    writeTrail(visits('/app/projects/p1/files', '/app/archiv'))
    const user = userEvent.setup()
    renderBackLink()
    await waitFor(() => expect(screen.getByTestId('back-link')).toHaveTextContent('Back to Files'))

    await user.click(screen.getByTestId('back-link'))
    expect(back).toHaveBeenCalledTimes(1)
  })

  test('leaves a modified click to the browser, so the target still opens in a new tab', async () => {
    writeTrail(visits('/app/projects/p1/files', '/app/archiv'))
    const user = userEvent.setup()
    renderBackLink()
    await waitFor(() => expect(screen.getByTestId('back-link')).toHaveTextContent('Back to Files'))

    await user.keyboard('{Meta>}')
    await user.click(screen.getByTestId('back-link'))
    await user.keyboard('{/Meta}')
    expect(back).not.toHaveBeenCalled()
  })

  test('does not walk a settings tab when the destination is the project', async () => {
    // Older trails stacked every org tab. Back must leave the shell, not land
    // on the previous submenu — so this click follows the href, not history.
    pathname = '/app/organization/models'
    writeTrail(visits('/app/projects/p1/chat', '/app/organization', '/app/organization/models'))
    const user = userEvent.setup()
    renderBackLink()
    await waitFor(() => expect(screen.getByTestId('back-link')).toHaveTextContent('Back to Chat'))

    await user.click(screen.getByTestId('back-link'))
    expect(back).not.toHaveBeenCalled()
    expect(screen.getByTestId('back-link')).toHaveAttribute('href', '/app/projects/p1/chat')
  })

  test('does not call history.back when there is no history to go back to', async () => {
    // A link opened in a new tab: the browser copies session storage, so the
    // trail is there, but the history behind it is not.
    setHistoryLength(1)
    writeTrail(visits('/app/projects/p1/files', '/app/archiv'))
    const user = userEvent.setup()
    renderBackLink()
    await waitFor(() => expect(screen.getByTestId('back-link')).toHaveTextContent('Back to Files'))

    await user.click(screen.getByTestId('back-link'))
    expect(back).not.toHaveBeenCalled()
  })
})
