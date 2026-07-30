/**
 * The locale a caller pins must survive hydration.
 *
 * The provider reconciles on first mount against the user's saved preference and
 * then the organization default, which is right in the product and wrong for a
 * `/dev/*` preview: the screenshot evidence would carry whichever language the
 * capturing developer's own account prefers. `fixedLocale` opts out.
 */

import { render, screen, waitFor } from '@testing-library/react'
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
