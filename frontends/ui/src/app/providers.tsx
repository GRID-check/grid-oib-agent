/**
 * Application Providers
 *
 * Wraps the application with necessary providers:
 * - AppConfigProvider (runtime server-side config)
 * - TooltipProvider / Toaster (shadcn/ui primitives)
 * - AuthKitProvider (WorkOS AuthKit session)
 * - ConversationHydrator (loads server-persisted conversations)
 *
 * Theme (dark/light) is applied directly to the document element: before the
 * first paint by the inline script from `theme-boot.ts` (rendered in
 * layout.tsx), and from then on by useThemeEffect below. Both toggle the
 * `.dark` class that the token stylesheet keys off of. Light is the default
 * (no class). There is no separate theme provider.
 */

'use client'

import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { AuthKitProvider } from '@workos-inc/authkit-nextjs/components'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppConfigProvider, type AppConfig, useAppConfig } from '@/shared/context'
import { useLayoutStore } from '@/features/layout'
import { useChatStore } from '@/features/chat/store'
import type { ThemeMode } from '@/features/layout'
import { I18nProvider, type Locale } from '@/i18n'
import { THEME_COLOR } from './theme-boot'
import { fetchUserPreferences, patchUserPreferences } from '@/lib/user-preferences/client'
import { useAuth } from '@/adapters/auth'
import {
  DISABLED_POSTHOG_CONFIG,
  identifyPosthog,
  initPosthogClient,
  isPosthogEnabled,
  resetPosthog,
} from '@/lib/analytics/posthog'

interface ProvidersProps {
  children: ReactNode
  /** Runtime configuration from server-side environment variables */
  config: AppConfig
  /** Locale resolved server-side (cookie / Accept-Language). */
  locale: Locale
}

const THEME_MODES: ReadonlySet<string> = new Set(['system', 'light', 'dark'])
const isThemeMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && THEME_MODES.has(value)

/**
 * Initializes browser analytics from runtime config and associates the
 * PostHog session with the authenticated WorkOS user. Runs after AuthKit has
 * restored its session on each page load; sign-out resets PostHog in the auth
 * action before AuthKit redirects. Everything no-ops while analytics is
 * unconfigured (fail-open).
 */
const PostHogIdentitySync = (): null => {
  const { authRequired, isAuthenticated, user } = useAuth()
  const { posthog: posthogConfig = DISABLED_POSTHOG_CONFIG } = useAppConfig()
  const previousDistinctId = useRef<string | null>(null)
  const distinctId = authRequired && isAuthenticated && user?.id ? user.id : null

  useEffect(() => {
    initPosthogClient(posthogConfig.host, posthogConfig.projectToken)
  }, [posthogConfig.host, posthogConfig.projectToken])

  useEffect(() => {
    if (!distinctId) {
      // Losing the id without passing through `handleSignOut` — an expired
      // session, a failed token refresh — must still clear PostHog's OWN
      // persisted identity, not just this ref. Clearing the ref alone was
      // actively harmful: it made the `previousDistinctId.current` guard below
      // false, so the next sign-in on the same browser identified a DIFFERENT
      // user onto the previous user's persisted distinct id instead of
      // resetting first. Resetting here is self-limiting — it runs only on the
      // transition into the no-id state, because the ref is null afterwards.
      if (previousDistinctId.current && isPosthogEnabled()) resetPosthog()
      previousDistinctId.current = null
      return
    }
    if (!isPosthogEnabled() || previousDistinctId.current === distinctId) return

    if (previousDistinctId.current) resetPosthog()
    identifyPosthog(distinctId, {
      email: user?.email ?? undefined,
      name: user?.name ?? undefined,
    })
    previousDistinctId.current = distinctId
  }, [distinctId, user?.email, user?.name])

  return null
}

/**
 * Keeps the document's theme in step with the store after the first paint.
 *
 * The first paint is not this hook's job: `THEME_BOOT_SCRIPT` (theme-boot.ts)
 * sets `.dark` from the same persisted store entry before React runs, so on
 * mount this re-applies what is already there. A LAYOUT effect, and no
 * "wait until mounted" gate, because React's dev remount resets `<html>` to the
 * attributes its JSX declares — a passive effect let that reset paint one light
 * frame.
 *
 * The effect reads the theme from `getState()`, not from the hook's argument.
 * The store holds the persisted theme from the moment its module loads
 * (zustand's localStorage hydration is synchronous), but the HYDRATION render
 * sees the server snapshot, which is the store's initial 'system'. Acting on
 * that value turned an explicit dark choice on a light OS into a light frame
 * (~200ms in dev) right after the boot script had painted it dark. `theme`
 * stays the dependency, so a real change still re-runs the effect.
 *
 * It also points `<meta name="theme-color">` at the resolved theme. The
 * viewport export can only follow the OS; an explicit choice against it would
 * otherwise leave the browser's bar in the wrong colour.
 */
const useThemeEffect = (theme: ThemeMode): void => {
  useLayoutEffect(() => {
    const applyDark = (isDark: boolean): void => {
      document.documentElement.classList.toggle('dark', isDark)
      const color = isDark ? THEME_COLOR.dark : THEME_COLOR.light
      document
        .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
        .forEach((meta) => meta.setAttribute('content', color))
    }

    const current = useLayoutStore.getState().theme
    if (current !== 'system') {
      applyDark(current === 'dark')
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    applyDark(mediaQuery.matches)
    const handleChange = (e: MediaQueryListEvent): void => applyDark(e.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])
}

/**
 * Hook to fetch data sources on app initialization.
 * Loads available data sources from the API and updates the layout store.
 * Only web_search is enabled by default - users must manually enable other sources.
 */
const useDataSourcesInit = (): void => {
  const fetchDataSources = useLayoutStore((state) => state.fetchDataSources)
  const availableDataSources = useLayoutStore((state) => state.availableDataSources)

  useEffect(() => {
    // Only fetch if not already loaded
    if (availableDataSources === null) {
      fetchDataSources()
    }
  }, [fetchDataSources, availableDataSources])
}

/**
 * Restores per-session data source toggles after the initial API fetch.
 * On page refresh, fetchDataSources sets enabledDataSourceIds to [web_search].
 * This hook overrides that default with the stored per-session selection.
 * Waits for both availableDataSources and a hydrated conversation before restoring.
 */
const useDataSourceSessionRestore = (): void => {
  const availableDataSources = useLayoutStore((state) => state.availableDataSources)
  const setEnabledDataSources = useLayoutStore((state) => state.setEnabledDataSources)
  const conversationId = useChatStore((state) => state.currentConversation?.id)
  const restoredRef = useRef(false)

  useEffect(() => {
    if (restoredRef.current || !availableDataSources) return

    const conversation = useChatStore.getState().currentConversation
    if (!conversation) return

    const savedIds = conversation.enabledDataSourceIds
    if (savedIds) {
      const availableIds = new Set(availableDataSources.map((s) => s.id))
      const validIds = savedIds.filter((id) => availableIds.has(id))
      setEnabledDataSources(validIds)
    }

    restoredRef.current = true
  }, [availableDataSources, conversationId, setEnabledDataSources])
}

/**
 * Syncs the user's theme preference with the server.
 *
 * On mount, hydrates the layout store from the user's saved theme (so the
 * choice follows them across devices). Thereafter, persists any theme change
 * back to the user's preferences. Both directions fail soft — with auth
 * disabled the endpoint 401s and theme simply stays in localStorage.
 */
const useThemePreferenceSync = (): void => {
  const setTheme = useLayoutStore((state) => state.setTheme)
  const hydratedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void fetchUserPreferences()
      .then((prefs) => {
        if (!cancelled && isThemeMode(prefs.theme)) {
          setTheme(prefs.theme)
        }
      })
      .finally(() => {
        hydratedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [setTheme])

  useEffect(() => {
    return useLayoutStore.subscribe((state, prev) => {
      if (!hydratedRef.current || state.theme === prev.theme) return
      void patchUserPreferences({ theme: state.theme })
    })
  }, [])
}

/**
 * Theme wrapper that syncs with layout store.
 * Applies theme classes directly to document for instant updates.
 */
const ThemeWrapper = ({ children }: { children: ReactNode }): ReactNode => {
  const theme = useLayoutStore((state) => state.theme)

  // Apply theme classes directly to document
  useThemeEffect(theme)

  // Persist/hydrate theme against the signed-in user
  useThemePreferenceSync()

  // Initialize data sources
  useDataSourcesInit()

  // Restore per-session data source toggles after initial fetch
  useDataSourceSessionRestore()

  return <>{children}</>
}

/**
 * Loads server-persisted conversations into the chat store on initial mount.
 */
const useConversationsInit = (): void => {
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    useChatStore.getState().loadServerConversations()
  }, [])
}

export const Providers = ({ children, config, locale }: ProvidersProps): ReactNode => {
  const content = (
    <ThemeWrapper>
      <ConversationsHydrator>
        {children}
      </ConversationsHydrator>
    </ThemeWrapper>
  )

  return (
    <AppConfigProvider config={config}>
      <I18nProvider initialLocale={locale}>
        <AuthKitProvider>
          {/* reducedMotion="user" disables transform/layout animations for users
              with prefers-reduced-motion, app-wide. */}
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={200}>
              <PostHogIdentitySync />
              {content}
            </TooltipProvider>
            <Toaster />
          </MotionConfig>
        </AuthKitProvider>
      </I18nProvider>
    </AppConfigProvider>
  )
}

/**
 * Hydrates conversations from the server on mount.
 */
const ConversationsHydrator = ({ children }: { children: ReactNode }): ReactNode => {
  useConversationsInit()
  return <>{children}</>
}
