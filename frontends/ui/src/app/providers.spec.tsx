import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '@/shared/context'
import { identifyPosthog, resetPosthog } from '@/lib/analytics/posthog'
import { Providers } from './providers'

const layoutState = {
  theme: 'dark',
  setTheme: vi.fn(),
  fetchDataSources: vi.fn(),
  availableDataSources: [] as Array<{ id: string }>,
  setEnabledDataSources: vi.fn(),
}

const chatState = {
  currentConversation: null as { id: string; enabledDataSourceIds?: string[] } | null,
  reconnectToActiveJob: vi.fn(),
  cleanupOrphanedStartingBanners: vi.fn(),
  isDeepResearchStreaming: false,
  loadServerConversations: vi.fn(),
}

vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  AuthKitProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

// PostHogIdentitySync reads useAuth; the AuthKit mock above provides no
// session, so stub the adapter. Mutable, because the identity tests below
// need to move the session between users and to signed-out mid-test.
const authState = {
  isAuthenticated: false,
  isLoading: false,
  authRequired: false,
  user: null as { id: string; email?: string; name?: string } | null,
}

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({
    ...authState,
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }),
}))

vi.mock('@/lib/analytics/posthog', () => ({
  DISABLED_POSTHOG_CONFIG: { host: '', projectToken: '' },
  initPosthogClient: vi.fn(),
  identifyPosthog: vi.fn(),
  resetPosthog: vi.fn(),
  isPosthogEnabled: vi.fn(() => true),
}))

vi.mock('@/features/layout', () => ({
  useLayoutStore: Object.assign(
    (selector: (state: typeof layoutState) => unknown) => selector(layoutState),
    {
      getState: () => layoutState,
      subscribe: () => () => {},
    }
  ),
}))

vi.mock('@/lib/user-preferences/client', () => ({
  fetchUserPreferences: vi.fn(async () => ({})),
  patchUserPreferences: vi.fn(async () => true),
}))

vi.mock('@/features/chat/store', () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
    }
  ),
}))

const baseConfig: AppConfig = {
  authRequired: true,
  fileUpload: {
    acceptedTypes: '.pdf',
    acceptedMimeTypes: ['application/pdf'],
    maxTotalSizeMB: 100,
    maxFileSize: 100 * 1024 * 1024,
    maxIfcFileSize: 0,
    maxTotalSize: 100 * 1024 * 1024,
    maxFileCount: 10,
    fileExpirationCheckIntervalHours: 0,
  },
}

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders children inside AuthKitProvider', () => {
    const { container } = render(
      <Providers config={baseConfig} locale="en">
        <div data-testid="content">content</div>
      </Providers>
    )

    expect(container.querySelector('[data-testid="content"]')).toBeInTheDocument()
  })

  test('does not create duplicate interval timers in providers tree', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    render(
      <Providers config={baseConfig} locale="en">
        <div>content</div>
      </Providers>
    )

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  describe('PostHog identity', () => {
    const signedInAs = (id: string): void => {
      authState.authRequired = true
      authState.isAuthenticated = true
      authState.user = { id, email: `${id}@example.com`, name: id }
    }

    const signedOut = (): void => {
      authState.authRequired = true
      authState.isAuthenticated = false
      authState.user = null
    }

    afterEach(() => {
      authState.authRequired = false
      authState.isAuthenticated = false
      authState.user = null
    })

    // A session lost WITHOUT `handleSignOut` — expiry, a failed refresh — used
    // to clear only the local ref. PostHog kept its persisted identity, and
    // because the ref was null the reset-on-user-change guard then did not
    // fire, so the next person to sign in on that browser was identified onto
    // the previous user's distinct id. That is cross-user attribution, so it
    // is pinned here rather than left to review.
    test('resets PostHog when the session is lost without an explicit sign-out', () => {
      signedInAs('user-a')
      const view = render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(identifyPosthog).toHaveBeenCalledWith('user-a', expect.anything())

      signedOut()
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(resetPosthog).toHaveBeenCalled()
    })

    test('does not identify a new user onto the previous identity', () => {
      signedInAs('user-a')
      const view = render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      signedOut()
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      vi.mocked(resetPosthog).mockClear()
      signedInAs('user-b')
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      // The reset already happened on the way out, so user-b starts clean.
      expect(identifyPosthog).toHaveBeenCalledWith('user-b', expect.anything())
    })

    test('does not reset on a first render that was never authenticated', () => {
      signedOut()
      render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(resetPosthog).not.toHaveBeenCalled()
    })
  })
})
