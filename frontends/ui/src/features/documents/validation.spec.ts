import { describe, test, expect } from 'vitest'
import {
  validateFileUpload,
  isValidFileExtension,
  isValidMimeType,
  createEmptyValidationContext,
  type ValidationContext,
} from './validation'
import { MAX_FILE_SIZE, MAX_FILE_COUNT } from './constants'

describe('validation', () => {
  const createFile = (name: string, size: number = 1024, type: string = 'application/pdf'): File => {
    return new File(['x'.repeat(size)], name, { type })
  }

  describe('isValidFileExtension', () => {
    test('accepts valid extensions', () => {
      expect(isValidFileExtension('document.pdf')).toBe(true)
      expect(isValidFileExtension('document.docx')).toBe(true)
      expect(isValidFileExtension('document.txt')).toBe(true)
      expect(isValidFileExtension('document.md')).toBe(true)
    })

    test('rejects invalid extensions', () => {
      expect(isValidFileExtension('document.exe')).toBe(false)
      expect(isValidFileExtension('document.js')).toBe(false)
      expect(isValidFileExtension('document.zip')).toBe(false)
      expect(isValidFileExtension('document.html')).toBe(false)
    })

    test('rejects files without extension', () => {
      expect(isValidFileExtension('document')).toBe(false)
    })

    test('rejects image extensions by default (opt-in only, needs a VLM)', () => {
      // Images are not a shipped default; a deployment opts in via
      // FILE_UPLOAD_ACCEPTED_TYPES, which flows through AppConfig, not the
      // default validation config used here.
      expect(isValidFileExtension('photo.png')).toBe(false)
      expect(isValidFileExtension('photo.jpg')).toBe(false)
      expect(isValidFileExtension('photo.jpeg')).toBe(false)
    })

    test('handles case insensitivity', () => {
      expect(isValidFileExtension('document.PDF')).toBe(true)
      expect(isValidFileExtension('document.Pdf')).toBe(true)
    })
  })

  describe('isValidMimeType', () => {
    test('accepts valid mime types', () => {
      expect(isValidMimeType('application/pdf')).toBe(true)
      expect(isValidMimeType('text/plain')).toBe(true)
      expect(isValidMimeType('text/markdown')).toBe(true)
    })

    test('accepts empty mime type (some files lack it)', () => {
      expect(isValidMimeType('')).toBe(true)
    })

    test('rejects invalid mime types', () => {
      expect(isValidMimeType('image/gif')).toBe(false)
      expect(isValidMimeType('application/javascript')).toBe(false)
      expect(isValidMimeType('text/html')).toBe(false)
    })

    test('rejects image mime types by default (opt-in only, needs a VLM)', () => {
      expect(isValidMimeType('image/png')).toBe(false)
      expect(isValidMimeType('image/jpeg')).toBe(false)
    })
  })

  describe('createEmptyValidationContext', () => {
    test('creates empty context', () => {
      const context = createEmptyValidationContext()

      expect(context.existingTotalSize).toBe(0)
      expect(context.existingFileCount).toBe(0)
      expect(context.existingFileNames.size).toBe(0)
    })

    test('defaults to the chat session, and takes a durable collection', () => {
      expect(createEmptyValidationContext().collectionKind).toBe('chat-session')
      expect(createEmptyValidationContext('durable').collectionKind).toBe('durable')
    })
  })

  describe('validateFileUpload', () => {
    describe('basic validation', () => {
      test('accepts valid files', () => {
        const files = [createFile('doc1.pdf'), createFile('doc2.txt')]

        const result = validateFileUpload(files)

        expect(result.valid).toBe(true)
        expect(result.validFiles).toHaveLength(2)
        expect(result.fileErrors).toHaveLength(0)
        expect(result.batchErrors).toHaveLength(0)
        expect(result.summary).toBeNull()
      })

      test('rejects invalid file types', () => {
        const files = [createFile('document.exe')]

        const result = validateFileUpload(files)

        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(0)
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].code).toBe('INVALID_TYPE')
      })

      test('rejects oversized files', () => {
        const files = [createFile('large.pdf', MAX_FILE_SIZE + 1)]

        const result = validateFileUpload(files)

        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(0)
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].code).toBe('FILE_TOO_LARGE')
      })

      /*
        The size named in an error is the same size the user can read off the
        file card beside it, so it has to be punctuated the same way — and it
        has to be the same NUMBER. Both now go through the one `formatBytes`
        with the APP's locale, over a limit stored in decimal MB, so a
        deployment configured for 100 MB says exactly that.
      */
      test('punctuates the size with the caller-supplied locale', () => {
        // Half a megabyte over, so the file's own size carries a decimal and
        // the locale's separator is actually exercised.
        const files = [createFile('large.pdf', MAX_FILE_SIZE + 500_000)]

        const german = validateFileUpload(files, createEmptyValidationContext(), undefined, 'de')
        const english = validateFileUpload(files, createEmptyValidationContext(), undefined, 'en-US')

        expect(german.fileErrors[0].message).toContain('100,5 MB')
        expect(english.fileErrors[0].message).toContain('100.5 MB')
        // And the LIMIT reads as the number a deployment configured, exactly.
        expect(german.fileErrors[0].message).toContain('100 MB')
        expect(english.fileErrors[0].message).toContain('100 MB')
      })
    })

    describe('duplicate detection', () => {
      test('detects duplicates within batch', () => {
        const files = [createFile('doc.pdf'), createFile('doc.pdf')]

        const result = validateFileUpload(files)

        // First file is valid, second is duplicate
        expect(result.validFiles).toHaveLength(1)
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].code).toBe('DUPLICATE_FILE')
      })

      test('detects duplicates against existing session files', () => {
        const files = [createFile('existing.pdf')]
        const context: ValidationContext = {
          collectionKind: 'chat-session',
          existingTotalSize: 1024,
          existingFileCount: 1,
          existingFileNames: new Set(['existing.pdf']),
        }

        const result = validateFileUpload(files, context)

        expect(result.validFiles).toHaveLength(0)
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].code).toBe('DUPLICATE_FILE')
        expect(result.fileErrors[0].message).toContain('already exists in this session')
      })
    })

    describe('partial batch uploads (file-level errors allow other files)', () => {
      test('allows valid files when some have invalid types', () => {
        const files = [createFile('valid.pdf'), createFile('invalid.exe')]

        const result = validateFileUpload(files)

        // valid should be false (there were errors), but validFiles should have the valid one
        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(1)
        expect(result.validFiles[0].name).toBe('valid.pdf')
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].file.name).toBe('invalid.exe')
      })

      test('allows valid files when some are duplicates', () => {
        const files = [createFile('new.pdf'), createFile('existing.pdf')]
        const context: ValidationContext = {
          collectionKind: 'chat-session',
          existingTotalSize: 1024,
          existingFileCount: 1,
          existingFileNames: new Set(['existing.pdf']),
        }

        const result = validateFileUpload(files, context)

        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(1)
        expect(result.validFiles[0].name).toBe('new.pdf')
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].code).toBe('DUPLICATE_FILE')
      })

      test('allows valid files when some are oversized', () => {
        const files = [createFile('small.pdf', 1024), createFile('huge.pdf', MAX_FILE_SIZE + 1)]

        const result = validateFileUpload(files)

        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(1)
        expect(result.validFiles[0].name).toBe('small.pdf')
        expect(result.fileErrors).toHaveLength(1)
        expect(result.fileErrors[0].code).toBe('FILE_TOO_LARGE')
      })

      test('handles multiple file-level errors in same batch', () => {
        const files = [
          createFile('valid.pdf'),
          createFile('invalid.exe'),
          createFile('duplicate.pdf'),
          createFile('duplicate.pdf'), // duplicate within batch
        ]

        const result = validateFileUpload(files)

        expect(result.validFiles).toHaveLength(2) // valid.pdf and first duplicate.pdf
        expect(result.fileErrors).toHaveLength(2) // invalid.exe and second duplicate.pdf
      })
    })

    describe('batch-level errors (block entire upload)', () => {
      test('blocks all files when max count exceeded', () => {
        const files = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, i) => createFile(`doc${i}.pdf`))

        const result = validateFileUpload(files)

        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(0)
        expect(result.batchErrors).toHaveLength(1)
        expect(result.batchErrors[0].code).toBe('MAX_FILES_EXCEEDED')
      })

      test("a chat session's count still includes what is already attached", () => {
        // A conversation's attachment set is bounded on purpose: the cap is
        // cumulative HERE, and issue #432 must not have relaxed that.
        const files = [createFile('new.pdf')]
        const context: ValidationContext = {
          collectionKind: 'chat-session',
          existingTotalSize: 1024,
          existingFileCount: MAX_FILE_COUNT,
          existingFileNames: new Set(),
        }

        const result = validateFileUpload(files, context)

        expect(result.valid).toBe(false)
        expect(result.validFiles).toHaveLength(0)
        expect(result.batchErrors).toHaveLength(1)
        expect(result.batchErrors[0].code).toBe('MAX_FILES_EXCEEDED')
        expect(result.batchErrors[0].variant).toBe('remaining')
      })

      test('batch errors take precedence over file errors', () => {
        // When valid files exceed batch limit, batch error blocks all (even with file errors present)
        // Need MAX_FILE_COUNT + 1 valid files to trigger batch error
        const files = [
          ...Array.from({ length: MAX_FILE_COUNT + 1 }, (_, i) => createFile(`doc${i}.pdf`)),
          createFile('invalid.exe'), // This file-level error doesn't matter - batch error wins
        ]

        const result = validateFileUpload(files)

        expect(result.validFiles).toHaveLength(0) // Batch error blocks all
        expect(result.batchErrors).toHaveLength(1)
        expect(result.batchErrors[0].code).toBe('MAX_FILES_EXCEEDED')
        expect(result.fileErrors).toHaveLength(1) // File error is still recorded
      })
    })

    describe('summary generation', () => {
      test('generates summary for single file error', () => {
        const files = [createFile('invalid.exe')]

        const result = validateFileUpload(files)

        expect(result.summary).toContain('invalid.exe')
        expect(result.summary).toContain('not a supported file type')
      })

      test('generates summary for multiple file errors', () => {
        const files = [createFile('a.exe'), createFile('b.zip')]

        const result = validateFileUpload(files)

        expect(result.summary).toContain('2 files have issues')
      })

      test('generates summary for batch errors', () => {
        const files = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, i) => createFile(`doc${i}.pdf`))

        const result = validateFileUpload(files)

        expect(result.summary).toContain('file limit')
      })

      test('no summary for valid batch', () => {
        const files = [createFile('valid.pdf')]

        const result = validateFileUpload(files)

        expect(result.summary).toBeNull()
      })
    })

    describe('custom configuration', () => {
      test('uses custom accepted file types from config', () => {
        const customConfig = {
          acceptedTypes: '.csv,.json',
          acceptedMimeTypes: ['text/csv', 'application/json'],
          maxTotalSizeMB: 100,
          maxFileSize: 100 * 1024 * 1024,
          maxIfcFileSize: 0,
          maxTotalSize: 100 * 1024 * 1024,
          maxFileCount: 10,
          fileExpirationCheckIntervalHours: 0,
        }

        // CSV should be valid with custom config
        expect(isValidFileExtension('data.csv', customConfig)).toBe(true)
        expect(isValidFileExtension('config.json', customConfig)).toBe(true)

        // PDF should be invalid with custom config (not in accepted types)
        expect(isValidFileExtension('document.pdf', customConfig)).toBe(false)
      })

      test('uses custom MIME types from config', () => {
        const customConfig = {
          acceptedTypes: '.csv,.json',
          acceptedMimeTypes: ['text/csv', 'application/json'],
          maxTotalSizeMB: 100,
          maxFileSize: 100 * 1024 * 1024,
          maxIfcFileSize: 0,
          maxTotalSize: 100 * 1024 * 1024,
          maxFileCount: 10,
          fileExpirationCheckIntervalHours: 0,
        }

        expect(isValidMimeType('text/csv', customConfig)).toBe(true)
        expect(isValidMimeType('application/json', customConfig)).toBe(true)
        expect(isValidMimeType('application/pdf', customConfig)).toBe(false)
      })

      test('uses custom max file size from config', () => {
        const smallSizeConfig = {
          acceptedTypes: '.pdf,.txt',
          acceptedMimeTypes: ['application/pdf', 'text/plain'],
          maxTotalSizeMB: 1,
          maxFileSize: 1 * 1024 * 1024, // 1MB limit
          maxIfcFileSize: 0,
          maxTotalSize: 1 * 1024 * 1024,
          maxFileCount: 10,
          fileExpirationCheckIntervalHours: 0,
        }

        // 500KB file should pass with 1MB limit
        const smallFile = createFile('small.pdf', 500 * 1024)
        const smallResult = validateFileUpload([smallFile], createEmptyValidationContext(), smallSizeConfig)
        expect(smallResult.valid).toBe(true)

        // 2MB file should fail with 1MB limit
        const largeFile = createFile('large.pdf', 2 * 1024 * 1024)
        const largeResult = validateFileUpload([largeFile], createEmptyValidationContext(), smallSizeConfig)
        expect(largeResult.valid).toBe(false)
        expect(largeResult.fileErrors[0].code).toBe('FILE_TOO_LARGE')
      })

      test('uses custom max file count from config', () => {
        const limitedConfig = {
          acceptedTypes: '.pdf,.txt',
          acceptedMimeTypes: ['application/pdf', 'text/plain'],
          maxTotalSizeMB: 100,
          maxFileSize: 100 * 1024 * 1024,
          maxIfcFileSize: 0,
          maxTotalSize: 100 * 1024 * 1024,
          maxFileCount: 3, // Only 3 files allowed
          fileExpirationCheckIntervalHours: 0,
        }

        // 3 files should pass
        const threeFiles = [createFile('a.pdf'), createFile('b.pdf'), createFile('c.pdf')]
        const passResult = validateFileUpload(threeFiles, createEmptyValidationContext(), limitedConfig)
        expect(passResult.valid).toBe(true)
        expect(passResult.validFiles).toHaveLength(3)

        // 4 files should fail
        const fourFiles = [createFile('a.pdf'), createFile('b.pdf'), createFile('c.pdf'), createFile('d.pdf')]
        const failResult = validateFileUpload(fourFiles, createEmptyValidationContext(), limitedConfig)
        expect(failResult.valid).toBe(false)
        expect(failResult.batchErrors[0].code).toBe('MAX_FILES_EXCEEDED')
      })

      test('uses custom total size limit from config', () => {
        const smallTotalConfig = {
          acceptedTypes: '.pdf,.txt',
          acceptedMimeTypes: ['application/pdf', 'text/plain'],
          maxTotalSizeMB: 1,
          maxFileSize: 100 * 1024 * 1024, // Individual files can be large
          maxIfcFileSize: 0,
          maxTotalSize: 1 * 1024 * 1024, // But total is limited to 1MB
          maxFileCount: 10,
          fileExpirationCheckIntervalHours: 0,
        }

        // Two 400KB files should pass (total 800KB < 1MB)
        const smallFiles = [createFile('a.pdf', 400 * 1024), createFile('b.pdf', 400 * 1024)]
        const passResult = validateFileUpload(smallFiles, createEmptyValidationContext(), smallTotalConfig)
        expect(passResult.valid).toBe(true)

        // Two 600KB files should fail (total 1.2MB > 1MB)
        const largeFiles = [createFile('a.pdf', 600 * 1024), createFile('b.pdf', 600 * 1024)]
        const failResult = validateFileUpload(largeFiles, createEmptyValidationContext(), smallTotalConfig)
        expect(failResult.valid).toBe(false)
        expect(failResult.batchErrors[0].code).toBe('TOTAL_SIZE_EXCEEDED')
      })

      test('validateFileUpload rejects files not in custom accepted types', () => {
        const customConfig = {
          acceptedTypes: '.csv,.json',
          acceptedMimeTypes: ['text/csv', 'application/json'],
          maxTotalSizeMB: 100,
          maxFileSize: 100 * 1024 * 1024,
          maxIfcFileSize: 0,
          maxTotalSize: 100 * 1024 * 1024,
          maxFileCount: 10,
          fileExpirationCheckIntervalHours: 0,
        }

        const files = [createFile('data.pdf')]
        const result = validateFileUpload(files, createEmptyValidationContext(), customConfig)

        expect(result.valid).toBe(false)
        expect(result.fileErrors[0].code).toBe('INVALID_TYPE')
        expect(result.fileErrors[0].message).toContain('.csv,.json')
      })
    })

    describe('image rejected due to missing VLM (flag on, capability off)', () => {
      const nonImageConfig = {
        acceptedTypes: '.pdf,.docx,.txt,.md',
        acceptedMimeTypes: ['application/pdf'],
        maxTotalSizeMB: 100,
        maxFileSize: 100 * 1024 * 1024,
        maxIfcFileSize: 0,
        maxTotalSize: 100 * 1024 * 1024,
        maxFileCount: 10,
        fileExpirationCheckIntervalHours: 0,
      }

      test('tags an image rejection with reason image-vlm-unavailable when blocked by VLM', () => {
        const config = { ...nonImageConfig, imageUploadBlockedReason: 'vlm-unavailable' as const }
        const result = validateFileUpload([createFile('photo.png')], createEmptyValidationContext(), config)

        expect(result.fileErrors[0].code).toBe('INVALID_TYPE')
        expect(result.fileErrors[0].reason).toBe('image-vlm-unavailable')
      })

      test('does NOT tag a non-image rejection even when images are VLM-blocked', () => {
        const config = { ...nonImageConfig, imageUploadBlockedReason: 'vlm-unavailable' as const }
        const result = validateFileUpload([createFile('malware.exe')], createEmptyValidationContext(), config)

        expect(result.fileErrors[0].code).toBe('INVALID_TYPE')
        expect(result.fileErrors[0].reason).toBeUndefined()
      })

      test('does NOT tag an image rejection when the block is not VLM-related', () => {
        // imageUploadBlockedReason null (e.g. flag off) → generic rejection, no
        // VLM-specific reason.
        const config = { ...nonImageConfig, imageUploadBlockedReason: null }
        const result = validateFileUpload([createFile('photo.png')], createEmptyValidationContext(), config)

        expect(result.fileErrors[0].code).toBe('INVALID_TYPE')
        expect(result.fileErrors[0].reason).toBeUndefined()
      })
    })
  })
})

describe('a building model is not measured against the document limit', () => {
  // `FILE_UPLOAD_MAX_SIZE_MB` is sized for PDFs (100 MB). An Einreichung IFC is
  // routinely 50–500 MB, so a real model was refused for being a large FILE,
  // with a message that named no limit the user could act on and said nothing
  // about IFC.
  const config = {
    acceptedTypes: '.pdf,.ifc',
    acceptedMimeTypes: ['application/pdf', 'application/octet-stream'],
    maxTotalSizeMB: 100,
    maxFileSize: 100 * 1024 * 1024,
    maxIfcFileSize: 250 * 1024 * 1024,
    maxTotalSize: 250 * 1024 * 1024,
    maxFileCount: 10,
    fileExpirationCheckIntervalHours: 0,
  }
  const file = (name: string, bytes: number): File => {
    const f = new File(['x'], name)
    Object.defineProperty(f, 'size', { value: bytes })
    return f
  }

  test('admits a 150 MB .ifc that exceeds the document limit', () => {
    const result = validateFileUpload([file('Lacknergasse-98.ifc', 150 * 1024 * 1024)], undefined, config)

    expect(result.fileErrors).toEqual([])
    expect(result.batchErrors).toEqual([])
    expect(result.validFiles).toHaveLength(1)
  })

  test('still refuses a .ifc past the IFC ceiling', () => {
    const result = validateFileUpload([file('federated.ifc', 300 * 1024 * 1024)], undefined, config)

    expect(result.fileErrors[0].code).toBe('FILE_TOO_LARGE')
  })

  test('leaves the document limit alone for everything else', () => {
    const result = validateFileUpload([file('Einreichplan.pdf', 150 * 1024 * 1024)], undefined, config)

    expect(result.fileErrors[0].code).toBe('FILE_TOO_LARGE')
  })

  test('a batch carrying a model gets the IFC total, not the document one', () => {
    // Otherwise the 150 MB model clears the per-file check and then fails a
    // 100 MB BATCH limit it could never satisfy.
    const batch = validateFileUpload([file('Lacknergasse-98.ifc', 150 * 1024 * 1024)], undefined, {
      ...config,
      maxTotalSize: 100 * 1024 * 1024,
    })

    expect(batch.batchErrors).toEqual([])
  })

  test('a batch of ordinary documents keeps the document total', () => {
    // The reason the ceiling is lifted per-batch instead of in the config:
    // three 40 MB PDFs must not start passing because IFC is enabled.
    const batch = validateFileUpload(
      [file('a.pdf', 40 * 1024 * 1024), file('b.pdf', 40 * 1024 * 1024), file('c.pdf', 40 * 1024 * 1024)],
      undefined,
      { ...config, maxTotalSize: 100 * 1024 * 1024 }
    )

    expect(batch.batchErrors[0].code).toBe('TOTAL_SIZE_EXCEEDED')
  })
})

describe('a model already in the session keeps the IFC ceiling', () => {
  // Reported from staging: with a 149.3 MB model in the session, the next
  // action reported `Total size would be 149.3 MB. Only 0 B available (100.0 MB
  // limit)`. The lift only looked at the NEW files, so a session already past
  // the document limit could never be added to again — and re-dropping the
  // model itself is rejected as a duplicate in pass 1, so it never reached the
  // list the lift was computed from.
  const config = {
    acceptedTypes: '.pdf,.ifc',
    acceptedMimeTypes: ['application/pdf', 'application/octet-stream'],
    maxTotalSizeMB: 100,
    maxFileSize: 100 * 1024 * 1024,
    maxIfcFileSize: 250 * 1024 * 1024,
    maxTotalSize: 100 * 1024 * 1024,
    maxFileCount: 10,
    fileExpirationCheckIntervalHours: 0,
  }
  const file = (name: string, bytes: number): File => {
    const f = new File(['x'], name)
    Object.defineProperty(f, 'size', { value: bytes })
    return f
  }
  const sessionWithModel = (): ValidationContext => ({
    collectionKind: 'chat-session',
    existingTotalSize: Math.round(149.3 * 1024 * 1024),
    existingFileCount: 1,
    existingFileNames: new Set(['2026-02-17_WB_Lacknergasse-98.ifc']),
  })

  test('adding a small document alongside it is not refused', () => {
    const result = validateFileUpload([file('Einreichplan.pdf', 2 * 1024 * 1024)], sessionWithModel(), config)

    expect(result.batchErrors).toEqual([])
    expect(result.validFiles).toHaveLength(1)
  })

  test('re-dropping the model reports the duplicate, not a phantom size failure', () => {
    const result = validateFileUpload(
      [file('2026-02-17_WB_Lacknergasse-98.ifc', Math.round(149.3 * 1024 * 1024))],
      sessionWithModel(),
      config
    )

    expect(result.fileErrors[0].code).toBe('DUPLICATE_FILE')
    expect(result.batchErrors).toEqual([])
  })

  test('the IFC ceiling still bounds the session', () => {
    // Lifted, not removed: 149.3 MB + 120 MB is past the 250 MB IFC ceiling.
    const result = validateFileUpload([file('zweiter-stand.ifc', 120 * 1024 * 1024)], sessionWithModel(), config)

    expect(result.batchErrors[0].code).toBe('TOTAL_SIZE_EXCEEDED')
  })
})

describe('a durable collection is not capped by what it already holds (issue #432)', () => {
  /*
    Reported by a user: "Dateiupload auf 10 Dateien begrenzt". A project's
    Dateiablage refused every upload once the project held ten documents —
    `Would have 11 files. Only 0 more allowed (10 max).` — and the same
    arithmetic on BYTES made a project un-uploadable for good at 100 MB.

    The cause was scope, not the numbers: a cap authored for a chat session's
    throwaway attachment set was being applied to a durable corpus, because
    both surfaces share `useFileUpload` and `loadFilesForSession` writes the
    project's PERSISTED documents into the same `trackedFiles` array. What
    actually bounds a durable corpus is the org storage quota (ADR-0042),
    enforced server-side.
  */
  const config = {
    acceptedTypes: '.pdf,.ifc',
    acceptedMimeTypes: ['application/pdf', 'application/octet-stream'],
    maxTotalSizeMB: 100,
    maxFileSize: 100 * 1024 * 1024,
    maxIfcFileSize: 250 * 1024 * 1024,
    maxTotalSize: 100 * 1024 * 1024,
    maxFileCount: 10,
    fileExpirationCheckIntervalHours: 0,
  }
  const file = (name: string, bytes = 1024): File => {
    const f = new File(['x'], name)
    Object.defineProperty(f, 'size', { value: bytes })
    return f
  }
  /** A project Dateiablage (or org Archiv) that already holds a real corpus. */
  const durableStore = (count: number, bytes: number): ValidationContext => ({
    collectionKind: 'durable',
    existingTotalSize: bytes,
    existingFileCount: count,
    existingFileNames: new Set(Array.from({ length: count }, (_, i) => `bestand-${i}.pdf`)),
  })

  test('accepts a new document into a project that already holds 10', () => {
    const result = validateFileUpload([file('Einreichplan.pdf')], durableStore(10, 1024 * 10), config)

    expect(result.batchErrors).toEqual([])
    expect(result.validFiles).toHaveLength(1)
    expect(result.canUpload).toBe(true)
  })

  test('accepts a new document into a project that already holds 100 MB', () => {
    const result = validateFileUpload(
      [file('Einreichplan.pdf', 2 * 1024 * 1024)],
      durableStore(3, 100 * 1024 * 1024),
      config
    )

    expect(result.batchErrors).toEqual([])
    expect(result.validFiles).toHaveLength(1)
  })

  test('still caps the INCOMING batch at the file count', () => {
    // Per-batch, not per-corpus: eleven at once is still eleven at once.
    const eleven = Array.from({ length: 11 }, (_, i) => file(`neu-${i}.pdf`))

    const result = validateFileUpload(eleven, durableStore(40, 500 * 1024 * 1024), config)

    expect(result.batchErrors).toHaveLength(1)
    expect(result.batchErrors[0].code).toBe('MAX_FILES_EXCEEDED')
    // Measured against the batch alone, so the message names 11 and not 51.
    expect(result.batchErrors[0].variant).toBe('batch')
    expect(result.batchErrors[0].values).toEqual({ total: 11, limit: 10 })
  })

  test('still caps the INCOMING batch at the total size', () => {
    const twoBig = [file('a.pdf', 60 * 1024 * 1024), file('b.pdf', 60 * 1024 * 1024)]

    const result = validateFileUpload(twoBig, durableStore(40, 500 * 1024 * 1024), config)

    expect(result.batchErrors).toHaveLength(1)
    expect(result.batchErrors[0].code).toBe('TOTAL_SIZE_EXCEEDED')
    expect(result.batchErrors[0].variant).toBe('batch')
  })

  test('keeps duplicate detection against the persisted documents', () => {
    // Still correct, and still useful: re-uploading a name the corpus already
    // has is almost always a mistake, and it is about identity, not volume.
    const result = validateFileUpload([file('bestand-3.pdf')], durableStore(10, 1024 * 10), config)

    expect(result.fileErrors).toHaveLength(1)
    expect(result.fileErrors[0].code).toBe('DUPLICATE_FILE')
  })

  test('a batch carrying a model still gets the IFC ceiling', () => {
    const result = validateFileUpload(
      [file('Lacknergasse-98.ifc', 150 * 1024 * 1024)],
      durableStore(10, 90 * 1024 * 1024),
      config
    )

    expect(result.batchErrors).toEqual([])
    expect(result.validFiles).toHaveLength(1)
  })

  test('a model already in the corpus does NOT lift the ceiling for a PDF batch', () => {
    // The session lift exists because the session's own bytes are in the total.
    // Here they are not, so three 40 MB PDFs must still fail the 100 MB batch
    // limit even though the Dateiablage happens to hold a model.
    const corpusWithModel: ValidationContext = {
      collectionKind: 'durable',
      existingTotalSize: 150 * 1024 * 1024,
      existingFileCount: 1,
      existingFileNames: new Set(['Lacknergasse-98.ifc']),
    }
    const threePdfs = [
      file('a.pdf', 40 * 1024 * 1024),
      file('b.pdf', 40 * 1024 * 1024),
      file('c.pdf', 40 * 1024 * 1024),
    ]

    const result = validateFileUpload(threePdfs, corpusWithModel, config)

    expect(result.batchErrors[0].code).toBe('TOTAL_SIZE_EXCEEDED')
  })
})

describe('batch errors carry what a translator needs', () => {
  /*
    The two batch messages were hardcoded English inside a validator with no
    translator, in a UI that is otherwise fully localized and whose users are
    German-speaking. The module keeps the English string as a fallback and
    additionally emits the variant plus the interpolation values — sizes
    already punctuated for the caller's locale, counts as plain numbers — so
    `useFileUpload` can render the sentence from `files.errors.*`. Same split
    as `reason: 'image-vlm-unavailable'` for the file-level VLM copy.
  */
  const config = {
    acceptedTypes: '.pdf',
    acceptedMimeTypes: ['application/pdf'],
    maxTotalSizeMB: 1,
    maxFileSize: 100 * 1024 * 1024,
    maxIfcFileSize: 0,
    maxTotalSize: 1_000_000,
    maxFileCount: 2,
    fileExpirationCheckIntervalHours: 0,
  }
  const file = (name: string, bytes = 1024): File => {
    const f = new File(['x'], name)
    Object.defineProperty(f, 'size', { value: bytes })
    return f
  }

  test('MAX_FILES_EXCEEDED, batch variant', () => {
    const result = validateFileUpload(
      [file('a.pdf'), file('b.pdf'), file('c.pdf')],
      createEmptyValidationContext('durable'),
      config
    )

    expect(result.batchErrors[0]).toMatchObject({
      code: 'MAX_FILES_EXCEEDED',
      variant: 'batch',
      values: { total: 3, limit: 2 },
    })
  })

  test('MAX_FILES_EXCEEDED, remaining variant, names the headroom', () => {
    const result = validateFileUpload([file('c.pdf'), file('d.pdf')], {
      collectionKind: 'chat-session',
      existingTotalSize: 10,
      existingFileCount: 1,
      existingFileNames: new Set(['a.pdf']),
    }, config)

    expect(result.batchErrors[0]).toMatchObject({
      code: 'MAX_FILES_EXCEEDED',
      variant: 'remaining',
      values: { total: 3, available: 1, limit: 2 },
    })
  })

  test('TOTAL_SIZE_EXCEEDED punctuates its sizes with the caller locale', () => {
    const german = validateFileUpload(
      [file('a.pdf', 1_500_000)],
      createEmptyValidationContext('durable'),
      config,
      'de'
    )
    const english = validateFileUpload(
      [file('a.pdf', 1_500_000)],
      createEmptyValidationContext('durable'),
      config,
      'en-US'
    )

    expect(german.batchErrors[0]).toMatchObject({
      code: 'TOTAL_SIZE_EXCEEDED',
      variant: 'batch',
      values: { total: '1,5 MB', limit: '1 MB' },
    })
    expect(english.batchErrors[0].values).toEqual({ total: '1.5 MB', limit: '1 MB' })
  })

  test('TOTAL_SIZE_EXCEEDED, remaining variant, names what is left', () => {
    const result = validateFileUpload(
      [file('b.pdf', 800_000)],
      {
        collectionKind: 'chat-session',
        existingTotalSize: 400_000,
        existingFileCount: 1,
        existingFileNames: new Set(['a.pdf']),
      },
      config,
      'en-US'
    )

    expect(result.batchErrors[0]).toMatchObject({
      code: 'TOTAL_SIZE_EXCEEDED',
      variant: 'remaining',
      values: { total: '1.2 MB', available: '600 kB', limit: '1 MB' },
    })
  })
})
