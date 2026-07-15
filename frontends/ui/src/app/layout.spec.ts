/**
 * Tests for layout configuration building
 *
 * Verifies that file upload configuration is correctly built from
 * environment variables with proper defaults and MIME type mapping.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'

// Store original env
const originalEnv = process.env

describe('File Upload Configuration', () => {
  beforeEach(() => {
    // Reset env before each test
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  const buildFileUploadConfig = () => getFileUploadConfigFromEnv(process.env)

  describe('default values', () => {
    test('uses default accepted types when env var not set', () => {
      const config = buildFileUploadConfig()

      expect(config.acceptedTypes).toBe('.pdf,.docx,.txt,.md')
    })

    test('uses default max size when env var not set', () => {
      const config = buildFileUploadConfig()

      expect(config.maxTotalSizeMB).toBe(100)
      expect(config.maxFileSize).toBe(100 * 1024 * 1024)
      expect(config.maxTotalSize).toBe(100 * 1024 * 1024)
    })

    test('uses default max file count when env var not set', () => {
      const config = buildFileUploadConfig()

      expect(config.maxFileCount).toBe(10)
    })

    test('uses default file expiration check interval (0) when env var not set', () => {
      const config = buildFileUploadConfig()

      expect(config.fileExpirationCheckIntervalHours).toBe(0)
    })

    test('builds correct MIME types from default extensions', () => {
      const config = buildFileUploadConfig()

      expect(config.acceptedMimeTypes).toContain('application/pdf')
      expect(config.acceptedMimeTypes).toContain('text/markdown')
      expect(config.acceptedMimeTypes).toContain('text/x-markdown')
      expect(config.acceptedMimeTypes).toContain('text/plain')
      expect(
        config.acceptedMimeTypes.includes(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
      ).toBe(true)
      expect(config.acceptedMimeTypes).not.toContain('text/html')
    })

    test('does NOT include image types by default (flag on, capability unconfirmed)', () => {
      // Images are a DERIVED capability (flag AND vlmAvailable). With the flag
      // on but the capability not supplied (defaults false, fail-closed),
      // images stay out — a deployment never has to touch the env list.
      const enabled = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: true })

      expect(enabled.acceptedTypes).toBe('.pdf,.docx,.txt,.md')
      expect(enabled.acceptedTypes).not.toContain('.png')
      expect(enabled.acceptedTypes).not.toContain('.jpg')
      expect(enabled.acceptedTypes).not.toContain('.jpeg')
      expect(enabled.acceptedMimeTypes).not.toContain('image/png')
      expect(enabled.acceptedMimeTypes).not.toContain('image/jpeg')
    })
  })

  describe('image availability = flag AND VLM capability (four combinations)', () => {
    // Images are derived from (imageUpload flag AND vlmAvailable), never from
    // the env accept-list. All four combinations, with and without env-listed
    // images, to prove the env list can neither add nor withhold images.
    test('flag on + capability on → images included (no env opt-in needed)', () => {
      const config = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: true, vlmAvailable: true })

      expect(config.acceptedTypes).toContain('.png')
      expect(config.acceptedTypes).toContain('.jpg')
      expect(config.acceptedTypes).toContain('.jpeg')
      expect(config.acceptedMimeTypes).toContain('image/png')
      expect(config.acceptedMimeTypes).toContain('image/jpeg')
      expect(config.imageUploadBlockedReason).toBeNull()
      // Non-image types survive.
      expect(config.acceptedMimeTypes).toContain('application/pdf')
    })

    test('flag on + capability off → images excluded, reason vlm-unavailable', () => {
      const config = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: true, vlmAvailable: false })

      expect(config.acceptedTypes).toBe('.pdf,.docx,.txt,.md')
      expect(config.acceptedMimeTypes).not.toContain('image/png')
      expect(config.imageUploadBlockedReason).toBe('vlm-unavailable')
    })

    test('flag off + capability on → images excluded, no reason (product decision)', () => {
      const config = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: false, vlmAvailable: true })

      expect(config.acceptedTypes).toBe('.pdf,.docx,.txt,.md')
      expect(config.acceptedMimeTypes).not.toContain('image/png')
      expect(config.imageUploadBlockedReason).toBeNull()
    })

    test('flag off + capability off → images excluded, no reason', () => {
      const config = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: false, vlmAvailable: false })

      expect(config.acceptedTypes).toBe('.pdf,.docx,.txt,.md')
      expect(config.imageUploadBlockedReason).toBeNull()
    })

    test('explicit env images without VLM → still excluded (closes the silent-failure hole)', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg'
      const config = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: true, vlmAvailable: false })

      expect(config.acceptedTypes).toBe('.pdf,.docx,.txt,.md')
      expect(config.acceptedMimeTypes).not.toContain('image/png')
      expect(config.imageUploadBlockedReason).toBe('vlm-unavailable')
    })

    test('explicit env images WITH VLM → included exactly once (no duplication)', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.pdf,.png'
      const config = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled: true, vlmAvailable: true })

      // env-listed .png is stripped then re-added by the capability path — it
      // must appear exactly once.
      expect(config.acceptedTypes.split(',').filter((e) => e === '.png')).toHaveLength(1)
      expect(config.acceptedTypes).toContain('.jpg')
      expect(config.acceptedTypes).toContain('.jpeg')
    })
  })

  describe('environment variable overrides', () => {
    test('FILE_UPLOAD_ACCEPTED_TYPES overrides default accepted types', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.csv,.json'

      const config = buildFileUploadConfig()

      expect(config.acceptedTypes).toBe('.csv,.json')
      expect(config.acceptedMimeTypes).toContain('text/csv')
      expect(config.acceptedMimeTypes).toContain('application/json')
      expect(config.acceptedMimeTypes).not.toContain('application/pdf')
    })

    test('FILE_UPLOAD_ACCEPTED_TYPES with .pptx resolves correct MIME type', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.pdf,.docx,.pptx,.txt,.md'

      const config = buildFileUploadConfig()

      expect(config.acceptedTypes).toBe('.pdf,.docx,.pptx,.txt,.md')
      expect(config.acceptedMimeTypes).toContain(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
      expect(config.acceptedMimeTypes).toContain('application/pdf')
    })

    test('FILE_UPLOAD_MAX_SIZE_MB overrides default max size', () => {
      process.env.FILE_UPLOAD_MAX_SIZE_MB = '50'

      const config = buildFileUploadConfig()

      expect(config.maxTotalSizeMB).toBe(50)
      expect(config.maxFileSize).toBe(50 * 1024 * 1024)
      expect(config.maxTotalSize).toBe(50 * 1024 * 1024)
    })

    test('FILE_UPLOAD_MAX_FILE_COUNT overrides default max file count', () => {
      process.env.FILE_UPLOAD_MAX_FILE_COUNT = '5'

      const config = buildFileUploadConfig()

      expect(config.maxFileCount).toBe(5)
    })

    test('FILE_EXPIRATION_CHECK_INTERVAL_HOURS overrides default', () => {
      process.env.FILE_EXPIRATION_CHECK_INTERVAL_HOURS = '12'

      const config = buildFileUploadConfig()

      expect(config.fileExpirationCheckIntervalHours).toBe(12)
    })

    test('all env vars can be set together', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.pdf,.txt'
      process.env.FILE_UPLOAD_MAX_SIZE_MB = '25'
      process.env.FILE_UPLOAD_MAX_FILE_COUNT = '3'

      const config = buildFileUploadConfig()

      expect(config.acceptedTypes).toBe('.pdf,.txt')
      expect(config.maxTotalSizeMB).toBe(25)
      expect(config.maxFileSize).toBe(25 * 1024 * 1024)
      expect(config.maxFileCount).toBe(3)
      expect(config.acceptedMimeTypes).toContain('application/pdf')
      expect(config.acceptedMimeTypes).toContain('text/plain')
      expect(config.acceptedMimeTypes).toHaveLength(2)
    })
  })

  describe('edge cases', () => {
    test('handles invalid number for max size (falls back to default)', () => {
      process.env.FILE_UPLOAD_MAX_SIZE_MB = 'invalid'

      const config = buildFileUploadConfig()

      expect(config.maxTotalSizeMB).toBe(100) // Default
    })

    test('handles invalid number for max file count (falls back to default)', () => {
      process.env.FILE_UPLOAD_MAX_FILE_COUNT = 'invalid'

      const config = buildFileUploadConfig()

      expect(config.maxFileCount).toBe(10) // Default
    })

    test('handles extensions with spaces', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.pdf, .txt , .md'

      const config = buildFileUploadConfig()

      expect(config.acceptedMimeTypes).toContain('application/pdf')
      expect(config.acceptedMimeTypes).toContain('text/plain')
      expect(config.acceptedMimeTypes).toContain('text/markdown')
    })

    test('handles uppercase extensions', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.PDF,.TXT'

      const config = buildFileUploadConfig()

      expect(config.acceptedMimeTypes).toContain('application/pdf')
      expect(config.acceptedMimeTypes).toContain('text/plain')
    })

    test('unknown extensions do not add MIME types', () => {
      process.env.FILE_UPLOAD_ACCEPTED_TYPES = '.xyz,.unknown'

      const config = buildFileUploadConfig()

      expect(config.acceptedTypes).toBe('.xyz,.unknown')
      expect(config.acceptedMimeTypes).toHaveLength(0)
    })
  })
})
