import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  logStorageWrite,
  logStorageEviction,
  logStorageFailure,
  logStorageMigration,
  logExternalStorageEvent,
  logStoreHydration,
  logStorageAvailability,
} from './storage-logger'

describe('storage-logger', () => {
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleDebugSpy.mockRestore()
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  describe('logStorageWrite', () => {
    test('logs in development mode', () => {
      vi.stubEnv('NODE_ENV', 'development')

      logStorageWrite('s_test_1', 2048)

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SessionsStore]'),
        expect.objectContaining({ conversationId: 's_test_1', chars: 2048 })
      )
    })

    test('does not log in production mode', () => {
      vi.stubEnv('NODE_ENV', 'production')

      logStorageWrite('s_test_1', 2048)

      expect(consoleDebugSpy).not.toHaveBeenCalled()
    })
  })

  describe('logStorageEviction', () => {
    test('ALWAYS logs an eviction (even in production)', () => {
      vi.stubEnv('NODE_ENV', 'production')

      logStorageEviction('s_old', 4096)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Evicted'),
        expect.objectContaining({ conversationId: 's_old', chars: 4096 })
      )
    })
  })

  describe('logStorageFailure', () => {
    test('ALWAYS logs a write that could not be stored (even in production)', () => {
      vi.stubEnv('NODE_ENV', 'production')

      logStorageFailure('aiq-chat-store:messages:s_huge', 9_000_000, new Error('QuotaExceededError'))

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('nothing left to evict'),
        expect.objectContaining({ key: 'aiq-chat-store:messages:s_huge', error: 'QuotaExceededError' })
      )
    })
  })

  describe('logStorageMigration', () => {
    test('logs in development mode only', () => {
      vi.stubEnv('NODE_ENV', 'production')
      logStorageMigration(3)
      expect(consoleDebugSpy).not.toHaveBeenCalled()

      vi.stubEnv('NODE_ENV', 'development')
      logStorageMigration(3)
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Moved 3 conversations'),
        expect.any(Object)
      )
    })
  })

  describe('logExternalStorageEvent', () => {
    test('logs storage events in development', () => {
      vi.stubEnv('NODE_ENV', 'development')

      logExternalStorageEvent('aiq-chat-store', 'oldValue', null)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Storage event detected'),
        expect.objectContaining({
          key: 'aiq-chat-store',
          cleared: true,
        })
      )
    })

    test('does not log in production', () => {
      vi.stubEnv('NODE_ENV', 'production')

      logExternalStorageEvent('aiq-chat-store', 'old', 'new')

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe('logStoreHydration', () => {
    test('logs successful hydration in development', () => {
      vi.stubEnv('NODE_ENV', 'development')

      logStoreHydration(true, 3, 'user123')

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Store hydrated'),
        expect.objectContaining({
          userId: 'user123',
        })
      )
    })

    test('logs failed hydration in development', () => {
      vi.stubEnv('NODE_ENV', 'development')

      logStoreHydration(false, 0, null)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('hydration failed'),
        expect.any(Object)
      )
    })
  })

  describe('logStorageAvailability', () => {
    test('logs when storage is unavailable in development', () => {
      vi.stubEnv('NODE_ENV', 'development')

      logStorageAvailability(false)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('localStorage not available'),
        expect.any(Object)
      )
    })

    test('does not log when storage is available', () => {
      vi.stubEnv('NODE_ENV', 'development')

      logStorageAvailability(true)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })
})
