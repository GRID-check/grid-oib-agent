/**
 * Tests for useConnectionRecovery hook
 *
 * Covers:
 * 1. Dormant when no connection errors
 * 2. Exponential backoff polling on connection error
 * 3. Recovery detection and auto-dismiss
 * 4. Browser online/visibility event triggers
 * 5. Cleanup on unmount and error dismissal
 */

import { renderHook, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { asStoreState, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStore } from '../types'

// Mock the health check module
vi.mock('@/shared/hooks/use-backend-health', () => ({
  checkBackendHealthCached: vi.fn(),
  invalidateHealthCache: vi.fn(),
}))

import {
  checkBackendHealthCached,
  invalidateHealthCache,
} from '@/shared/hooks/use-backend-health'

const mockCheckHealth = checkBackendHealthCached as ReturnType<typeof vi.fn>
const mockInvalidateCache = invalidateHealthCache as ReturnType<typeof vi.fn>

// Mock the store
vi.mock('../store', () => {
  const mockDismiss = vi.fn()
  let hasError = false

  return {
    useChatStore: vi.fn((selector: StoreSelector<ChatStore>) =>
      selector(
        asStoreState<ChatStore>({
          dismissConnectionErrors: mockDismiss,
          currentConversation: {
            id: 'conv-1',
            messages: hasError
              ? [
                  {
                    id: 'err-1',
                    messageType: 'error',
                    errorData: { errorCode: 'connection.failed' },
                  },
                ]
              : [],
          },
        }),
      ),
    ),
    // Mirrors the production selector (store.ts) so the hook under test sees
    // the same predicate it will see at runtime.
    selectHasConnectionError: (state: ChatStore): boolean =>
      state.currentConversation?.messages.some(
        (m) => m.messageType === 'error' && m.errorData?.errorCode?.startsWith('connection.')
      ) ?? false,
    __setHasError: (val: boolean) => {
      hasError = val
    },
    __getMockDismiss: () => mockDismiss,
  }
})

/**
 * The mocked `../store` module: the real exports plus the two test hooks the
 * factory above adds for driving the error state.
 */
type MockedStoreModule = typeof import('../store') & {
  __setHasError: (value: boolean) => void
  __getMockDismiss: () => ReturnType<typeof vi.fn>
}

const storeMock = (await import('../store')) as unknown as MockedStoreModule

import { useConnectionRecovery } from './use-connection-recovery'

describe('useConnectionRecovery', () => {
  const onRecovered = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    storeMock.__setHasError(false)
    mockCheckHealth.mockResolvedValue(false)
    // The poll delay carries equal jitter (see `applyJitter`). Pin the random
    // source to the top of the window so the backoff assertions below stay
    // exact rather than merely "fired at or before N".
    vi.spyOn(Math, 'random').mockReturnValue(1)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does nothing when no connection errors exist', () => {
    storeMock.__setHasError(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    vi.advanceTimersByTime(120_000)

    expect(mockCheckHealth).not.toHaveBeenCalled()
    expect(onRecovered).not.toHaveBeenCalled()
  })

  it('starts polling when connection error appears', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    // Initial delay is 5s
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })

    expect(mockInvalidateCache).toHaveBeenCalled()
    expect(mockCheckHealth).toHaveBeenCalledTimes(1)
  })

  it('uses exponential backoff on repeated failures', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    // 5s -> first check
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(1)

    // 10s -> second check (backoff 5*2=10)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(2)

    // 20s -> third check (backoff 10*2=20)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(3)
  })

  it('jitters the poll so clients that failed together do not poll together', async () => {
    // Regression: a rolling deploy puts every affected client into the error
    // state at the same instant. Without jitter they all poll on an identical
    // schedule, so the recovery traffic arrives as a spike.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    // Bottom of the window is half the nominal 5s delay.
    await act(async () => {
      vi.advanceTimersByTime(2_499)
    })
    expect(mockCheckHealth).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(1)
  })

  it('dismisses errors and calls onRecovered when health check succeeds', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(true)

    renderHook(() => useConnectionRecovery(onRecovered))

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })

    const mockDismiss = storeMock.__getMockDismiss()
    expect(mockDismiss).toHaveBeenCalled()
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  it('stops polling after successful recovery', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(true)

    renderHook(() => useConnectionRecovery(onRecovered))

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(1)

    // No further polling
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(1)
  })

  it('responds to browser online event', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    expect(mockCheckHealth).toHaveBeenCalled()
  })

  it('responds to visibility change event', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(mockCheckHealth).toHaveBeenCalled()
  })

  it('cleans up timers and listeners on unmount', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    const { unmount } = renderHook(() => useConnectionRecovery(onRecovered))

    unmount()

    // Advance past where polling would trigger
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })

    expect(mockCheckHealth).not.toHaveBeenCalled()
  })

  it('resets backoff delay when errors are cleared and reappear', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    const { rerender } = renderHook(() => useConnectionRecovery(onRecovered))

    // First poll at 5s
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(1)

    // Second poll at 10s (backoff)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(2)

    // Clear errors
    storeMock.__setHasError(false)
    rerender()

    // Re-introduce errors
    storeMock.__setHasError(true)
    rerender()

    // Should poll again at 5s (reset backoff), not 20s
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(mockCheckHealth).toHaveBeenCalledTimes(3)
  })

  it('invalidates health cache before each poll', async () => {
    storeMock.__setHasError(true)
    mockCheckHealth.mockResolvedValue(false)

    renderHook(() => useConnectionRecovery(onRecovered))

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })

    expect(mockInvalidateCache).toHaveBeenCalledTimes(1)
    expect(mockInvalidateCache).toHaveBeenCalledBefore(mockCheckHealth)
  })
})
