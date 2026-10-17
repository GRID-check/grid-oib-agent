import { describe, test, expect } from 'vitest'
import {
  mapBackendStatus,
  mapToDisplayStatus,
  mapUploadResponseStatus,
  normalizeFileName,
  trackedStatusOfJobFile,
} from './utils'

describe('utils', () => {
  describe('mapBackendStatus', () => {
    test('maps uploading status', () => {
      expect(mapBackendStatus('uploading')).toBe('uploading')
    })

    test('maps ingesting status', () => {
      expect(mapBackendStatus('ingesting')).toBe('ingesting')
    })

    test('maps success status', () => {
      expect(mapBackendStatus('success')).toBe('success')
    })

    test('maps failed status', () => {
      expect(mapBackendStatus('failed')).toBe('failed')
    })

    test('defaults unknown status to uploading', () => {
      expect(mapBackendStatus('unknown' as never)).toBe('uploading')
    })
  })

  describe('mapToDisplayStatus', () => {
    test('maps uploading to uploading', () => {
      expect(mapToDisplayStatus('uploading')).toBe('uploading')
    })

    test('maps ingesting to ingesting', () => {
      expect(mapToDisplayStatus('ingesting')).toBe('ingesting')
    })

    test('maps success to available', () => {
      expect(mapToDisplayStatus('success')).toBe('available')
    })

    test('maps failed to error', () => {
      expect(mapToDisplayStatus('failed')).toBe('error')
    })

    test('defaults unknown status to uploading', () => {
      expect(mapToDisplayStatus('unknown' as never)).toBe('uploading')
    })

    test('a held file is held, never an error and never a spinner', () => {
      expect(mapToDisplayStatus('held')).toBe('held')
    })

    test('a stored file is neutral: the chat cannot answer from it', () => {
      expect(mapToDisplayStatus('stored')).toBe('stored')
    })
  })

  describe('trackedStatusOfJobFile', () => {
    test('a failure carrying the content check verdict is held', () => {
      expect(trackedStatusOfJobFile({ status: 'failed', error_message: 'quarantined:{"reasons":[]}' })).toBe('held')
    })

    test('a failure carrying the typed verdict is held, with no message at all (ADR-0113)', () => {
      expect(
        trackedStatusOfJobFile({ status: 'failed', error_message: null, quarantine: { reasons: [], checked: 'full' } })
      ).toBe('held')
    })

    test('any other failure stays failed', () => {
      expect(trackedStatusOfJobFile({ status: 'failed', error_message: 'interrupted: restart' })).toBe('failed')
      expect(trackedStatusOfJobFile({ status: 'failed', error_message: null })).toBe('failed')
    })

    test('the prefix means nothing on a file that did not fail', () => {
      expect(trackedStatusOfJobFile({ status: 'success', error_message: 'quarantined:{}' })).toBe('success')
      expect(trackedStatusOfJobFile({ status: 'ingesting' })).toBe('ingesting')
    })
  })

  describe('mapUploadResponseStatus', () => {
    test('a stored, never-read document is stored, not success', () => {
      expect(mapUploadResponseStatus('uploaded')).toBe('stored')
    })

    test('an unchanged upload is the live document, still success', () => {
      expect(mapUploadResponseStatus('uploaded', true)).toBe('success')
    })

    test('a quarantined row is held', () => {
      expect(mapUploadResponseStatus('quarantined')).toBe('held')
    })

    test('a dispatched document is being read, a failed one failed', () => {
      expect(mapUploadResponseStatus('pending')).toBe('ingesting')
      expect(mapUploadResponseStatus('processing')).toBe('ingesting')
      expect(mapUploadResponseStatus('failed')).toBe('failed')
    })
  })

  describe('normalizeFileName', () => {
    test('extracts original filename from tmp prefix pattern', () => {
      expect(normalizeFileName('tmp_m04en5b_original-file.pdf')).toBe('original-file.pdf')
    })

    test('handles various alphanumeric IDs', () => {
      expect(normalizeFileName('tmp_abc123_document.docx')).toBe('document.docx')
      expect(normalizeFileName('tmp_XYZ789_report.txt')).toBe('report.txt')
      expect(normalizeFileName('tmp_a1b2c3d4_file.md')).toBe('file.md')
    })

    test('preserves underscores in original filename', () => {
      expect(normalizeFileName('tmp_abc123_my_file_name.pdf')).toBe('my_file_name.pdf')
    })

    test('returns original if not matching tmp pattern', () => {
      expect(normalizeFileName('regular-file.pdf')).toBe('regular-file.pdf')
      expect(normalizeFileName('document.txt')).toBe('document.txt')
    })

    test('returns original for partial matches', () => {
      expect(normalizeFileName('tmp_file.pdf')).toBe('tmp_file.pdf') // Missing second underscore portion
      expect(normalizeFileName('tmp__file.pdf')).toBe('tmp__file.pdf') // Empty ID portion
    })

    test('handles empty string', () => {
      expect(normalizeFileName('')).toBe('')
    })

    test('handles filenames starting with tmp but not matching pattern', () => {
      expect(normalizeFileName('tmp-file.pdf')).toBe('tmp-file.pdf')
      expect(normalizeFileName('tmpfile.pdf')).toBe('tmpfile.pdf')
    })

    test('handles special characters in original filename', () => {
      expect(normalizeFileName('tmp_abc123_file (1).pdf')).toBe('file (1).pdf')
      expect(normalizeFileName('tmp_xyz789_report-2024.01.15.docx')).toBe('report-2024.01.15.docx')
    })
  })
})
