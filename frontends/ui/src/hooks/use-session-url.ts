/**
 * useSessionUrl Hook
 *
 * Syncs the current session/conversation with the URL query parameter.
 * - On mount, reads ?session=xxx from URL and selects that conversation
 * - Provides updateSessionUrl to update URL when session changes
 * - Handles invalid/missing session IDs gracefully
 */

'use client'

import { useEffect, useCallback, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useChatStore } from '@/features/chat'
import { resumableSessionId } from '@/features/chat/lib/resume-session'

interface UseSessionUrlOptions {
  /** Whether the user is authenticated (sessions only work when authenticated) */
  isAuthenticated: boolean
}

interface UseSessionUrlReturn {
  /** Update URL to reflect the given session ID */
  updateSessionUrl: (sessionId: string | null) => void
  /** Clear session from URL (navigate to root) */
  clearSessionUrl: () => void
}

/**
 * Hook to sync session state with URL query parameters.
 * Enables refreshing to the same session and shareable session URLs.
 */
export function useSessionUrl({ isAuthenticated }: UseSessionUrlOptions): UseSessionUrlReturn {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const searchParams = useSearchParams()

  const { currentConversation, currentUserId } = useChatStore(useShallow((s) => ({
    currentConversation: s.currentConversation,
    currentUserId: s.currentUserId,
  })))
  const selectConversation = useChatStore((s) => s.selectConversation)
  const getUserConversations = useChatStore((s) => s.getUserConversations)

  // Track if we've done the initial URL sync to avoid duplicate effects
  const initialSyncDone = useRef(false)

  // Read session from URL on mount and select it
  // Wait for both isAuthenticated AND currentUserId to be set (user ID is synced by chat hooks)
  useEffect(() => {
    if (!isAuthenticated || !currentUserId || !searchParams || !pathname || initialSyncDone.current)
      return

    const sessionId = searchParams.get('session')
    if (!sessionId) {
      // No session in the URL: resume the last one if continuing it is clearly
      // what the user meant (see `resumableSessionId` for why the rule is
      // narrow). Reloading a tab should not cost three clicks to get back.
      const resumeId = resumableSessionId(getUserConversations())
      if (resumeId) {
        selectConversation(resumeId)
        // Put it back in the URL so a further reload is a plain URL restore
        // rather than a second round of inference.
        const params = new URLSearchParams(searchParams.toString())
        params.set('session', resumeId)
        router.replace(`${pathname}?${params.toString()}`)
      }
      initialSyncDone.current = true
      return
    }

    // Check if this session exists for the current user
    const userConversations = getUserConversations()
    const sessionExists = userConversations.some((c) => c.id === sessionId)

    if (sessionExists) {
      // Select the session from URL
      selectConversation(sessionId)
    } else {
      // Invalid session ID - clear it from URL
      const newParams = new URLSearchParams(searchParams.toString())
      newParams.delete('session')
      const newUrl = newParams.toString() ? `${pathname}?${newParams.toString()}` : pathname
      router.replace(newUrl)
    }

    initialSyncDone.current = true
  }, [
    isAuthenticated,
    currentUserId,
    searchParams,
    pathname,
    router,
    selectConversation,
    getUserConversations,
  ])

  // Update URL when current conversation changes (but not on initial load)
  useEffect(() => {
    if (!isAuthenticated || !currentUserId || !searchParams || !pathname || !initialSyncDone.current)
      return

    const urlSessionId = searchParams.get('session')
    const currentSessionId = currentConversation?.id

    // Only update if they're different
    if (currentSessionId && currentSessionId !== urlSessionId) {
      const newParams = new URLSearchParams(searchParams.toString())
      newParams.set('session', currentSessionId)
      router.replace(`${pathname}?${newParams.toString()}`)
    } else if (!currentSessionId && urlSessionId) {
      // No current session but URL has one - clear it
      const newParams = new URLSearchParams(searchParams.toString())
      newParams.delete('session')
      const newUrl = newParams.toString() ? `${pathname}?${newParams.toString()}` : pathname
      router.replace(newUrl)
    }
  }, [isAuthenticated, currentUserId, currentConversation?.id, searchParams, pathname, router])

  // Manual URL update function
  const updateSessionUrl = useCallback(
    (sessionId: string | null) => {
      if (!pathname) return
      const currentParams = searchParams?.toString() ?? ''
      const newParams = new URLSearchParams(currentParams)

      if (sessionId) {
        newParams.set('session', sessionId)
      } else {
        newParams.delete('session')
      }

      const newUrl = newParams.toString() ? `${pathname}?${newParams.toString()}` : pathname
      router.replace(newUrl)
    },
    [searchParams, pathname, router]
  )

  const clearSessionUrl = useCallback(() => {
    updateSessionUrl(null)
  }, [updateSessionUrl])

  return {
    updateSessionUrl,
    clearSessionUrl,
  }
}
