/**
 * The locale a caller pins must survive hydration.
 *
 * The provider reconciles on first mount against the user's saved preference and
 * then the organization default, which is right in the product and wrong for a
 * `/dev/*` preview: the screenshot evidence would carry whichever language the
 * capturing developer's own account prefers. `fixedLocale` opts out.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, useLocale } from './index'

const Probe = () => {
  const { locale } = useLocale()
  return <span data-testid="locale">{locale}</span>
}

/** The user prefers English; the org default is never reached. */
const stubPreferredLocale = (locale: string): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/user/preferences')) {
        return new Response(JSON.stringify({ prefs: { locale } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
  )
}

describe('I18nProvider locale reconciliation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adopts the saved user preference by default', async () => {
    stubPreferredLocale('en')

    render(
      <I18nProvider initialLocale="de">
        <Probe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'))
  })

  it('keeps the pinned locale, and asks for nothing, when fixedLocale is set', async () => {
    stubPreferredLocale('en')

    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <Probe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('de'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

/**
 * Reconciliation is a GUESS at the language the user would have wanted. An
 * explicit choice is the answer, and once the answer exists the guess has to be
 * abandoned — including mid-flight, which is the case that actually bites.
 *
 * The failing sequence: the page opens in `en` (Accept-Language, no cookie) while
 * the saved preference is `de`. The read is issued. Before it returns the user
 * picks English themselves. The read then resolves with the pre-choice `de` and,
 * comparing against the MOUNT-time locale rather than the current one, applied it —
 * flipping the UI to German and rewriting the cookie moments after an explicit
 * choice of English.
 */
describe('an explicit choice outranks an in-flight reconciliation', () => {
  const Switcher = ({ to }: { to: 'de' | 'en' }) => {
    const { locale, setLocale } = useLocale()
    return (
      <>
        <span data-testid="locale">{locale}</span>
        <button onClick={() => setLocale(to)}>switch</button>
      </>
    )
  }

  it('does not overwrite a locale the user picked while the read was pending', async () => {
    let releasePrefs = (): void => {}
    const prefsPending = new Promise<void>((resolve) => {
      releasePrefs = () => resolve()
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/user/preferences')) {
          // The PATCH from `setLocale` must not be held up by the pending GET.
          if (init?.method === 'PATCH') return new Response('{}', { status: 200 })
          await prefsPending
          // Deliberately the PRE-choice value: this GET was issued first.
          return new Response(JSON.stringify({ prefs: { locale: 'de' } }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      })
    )

    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <Switcher to="en" />
      </I18nProvider>
    )

    // The user answers the question while the guess is still in flight…
    await user.click(screen.getByRole('button', { name: 'switch' }))
    expect(screen.getByTestId('locale')).toHaveTextContent('en')

    // …and the stale answer lands afterwards.
    releasePrefs()
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())

    // Their choice stands.
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'))
    expect(document.cookie).not.toContain('locale=de')
  })
})
