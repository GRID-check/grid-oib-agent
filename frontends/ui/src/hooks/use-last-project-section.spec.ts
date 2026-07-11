import { describe, test, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  LAST_SECTION_STORAGE_KEY,
  buildProjectHref,
  sectionFromPathname,
  readLastProjectSection,
  writeLastProjectSection,
  pruneProjectSections,
  useRecordProjectSection,
  useResumeProjectHref,
} from './use-last-project-section'

// Drive usePathname per test so we can simulate navigation between sections.
let mockPathname = '/'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

const PID = 'proj-1'

describe('use-last-project-section', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockPathname = '/'
  })

  describe('sectionFromPathname', () => {
    test('maps the project root to overview', () => {
      expect(sectionFromPathname(`/app/projects/${PID}`, PID)).toBe('overview')
      expect(sectionFromPathname(`/app/projects/${PID}/`, PID)).toBe('overview')
    })

    test('maps known section segments', () => {
      expect(sectionFromPathname(`/app/projects/${PID}/chat`, PID)).toBe('chat')
      expect(sectionFromPathname(`/app/projects/${PID}/files`, PID)).toBe('files')
      expect(sectionFromPathname(`/app/projects/${PID}/research/x`, PID)).toBe('research')
      expect(sectionFromPathname(`/app/projects/${PID}/intake`, PID)).toBe('intake')
    })

    test('ignores unknown segments and other projects', () => {
      expect(sectionFromPathname(`/app/projects/${PID}/mystery`, PID)).toBeNull()
      expect(sectionFromPathname(`/app/projects/other/chat`, PID)).toBeNull()
      expect(sectionFromPathname('/app/projects', PID)).toBeNull()
    })
  })

  describe('buildProjectHref', () => {
    test('overview and null resolve to the bare project root', () => {
      expect(buildProjectHref(PID, null)).toBe(`/app/projects/${PID}`)
      expect(buildProjectHref(PID, 'overview')).toBe(`/app/projects/${PID}`)
    })

    test('a section resolves to its route', () => {
      expect(buildProjectHref(PID, 'files')).toBe(`/app/projects/${PID}/files`)
    })
  })

  describe('read/write', () => {
    test('round-trips a stored section', () => {
      expect(readLastProjectSection(PID)).toBeNull()
      writeLastProjectSection(PID, 'research')
      expect(readLastProjectSection(PID)).toBe('research')
    })

    test('keeps sections independent per project', () => {
      writeLastProjectSection('a', 'chat')
      writeLastProjectSection('b', 'files')
      expect(readLastProjectSection('a')).toBe('chat')
      expect(readLastProjectSection('b')).toBe('files')
    })

    test('ignores a corrupt / non-section stored value', () => {
      window.localStorage.setItem(LAST_SECTION_STORAGE_KEY, JSON.stringify({ [PID]: 'bogus' }))
      expect(readLastProjectSection(PID)).toBeNull()
    })

    test('survives corrupt JSON in storage', () => {
      window.localStorage.setItem(LAST_SECTION_STORAGE_KEY, 'not json')
      expect(readLastProjectSection(PID)).toBeNull()
    })
  })

  describe('pruneProjectSections', () => {
    test('drops entries for projects no longer present', () => {
      writeLastProjectSection('keep', 'chat')
      writeLastProjectSection('gone', 'files')
      pruneProjectSections(['keep'])
      expect(readLastProjectSection('keep')).toBe('chat')
      expect(readLastProjectSection('gone')).toBeNull()
    })

    test('is a no-op when nothing is stale', () => {
      writeLastProjectSection('a', 'chat')
      pruneProjectSections(['a', 'b'])
      expect(readLastProjectSection('a')).toBe('chat')
    })
  })

  describe('useRecordProjectSection', () => {
    test('records the section for the current pathname', () => {
      mockPathname = `/app/projects/${PID}/files`
      renderHook(() => useRecordProjectSection(PID))
      expect(readLastProjectSection(PID)).toBe('files')
    })

    test('an explicit Overview visit updates the stored section (no trap)', () => {
      writeLastProjectSection(PID, 'files')
      mockPathname = `/app/projects/${PID}`
      renderHook(() => useRecordProjectSection(PID))
      expect(readLastProjectSection(PID)).toBe('overview')
    })

    test('records the new section when navigation lands elsewhere', () => {
      mockPathname = `/app/projects/${PID}/chat`
      const { rerender } = renderHook(() => useRecordProjectSection(PID))
      expect(readLastProjectSection(PID)).toBe('chat')

      mockPathname = `/app/projects/${PID}/research`
      rerender()
      expect(readLastProjectSection(PID)).toBe('research')
    })

    test('does not record when the pathname is outside the project', () => {
      mockPathname = '/app/projects'
      renderHook(() => useRecordProjectSection(PID))
      expect(readLastProjectSection(PID)).toBeNull()
    })
  })

  describe('useResumeProjectHref', () => {
    test('resolves to the stored section after mount', () => {
      writeLastProjectSection(PID, 'files')
      const { result } = renderHook(() => useResumeProjectHref(PID))
      expect(result.current).toBe(`/app/projects/${PID}/files`)
    })

    test('falls back to the project root when nothing is stored', () => {
      const { result } = renderHook(() => useResumeProjectHref(PID))
      expect(result.current).toBe(`/app/projects/${PID}`)
    })

    test('an overview memory resolves to the project root', () => {
      writeLastProjectSection(PID, 'overview')
      const { result } = renderHook(() => useResumeProjectHref(PID))
      expect(result.current).toBe(`/app/projects/${PID}`)
    })
  })
})
