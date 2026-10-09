import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useLayoutStore } from '@/features/layout/store'
import type { ThemeMode } from '@/features/layout'
import { LAYOUT_STORE_KEY, THEME_BOOT_SCRIPT } from './theme-boot'

// The boot script runs before any bundle, so it restates the store's persist
// key and envelope instead of importing them. These specs write through the
// REAL store and then run the script string, which is what holds the two
// together: rename the key or change the envelope and the dark first paint
// breaks here, not on a reader's phone.

const runBootScript = (): void => {
  // The script is a self-contained string shipped into <head>; evaluating it is
  // exactly what the browser does with it.
  new Function(THEME_BOOT_SCRIPT)()
}

const stubOsPreference = (prefersDark: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
      media: query,
    }))
  )
}

const persistTheme = (theme: ThemeMode): void => {
  useLayoutStore.getState().setTheme(theme)
}

const isDark = (): boolean => document.documentElement.classList.contains('dark')

describe('THEME_BOOT_SCRIPT', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  test('reads the key the layout store actually persists under', () => {
    persistTheme('dark')
    expect(localStorage.getItem(LAYOUT_STORE_KEY)).toContain('"theme":"dark"')
  })

  test('an explicit dark choice wins over a light OS', () => {
    stubOsPreference(false)
    persistTheme('dark')
    runBootScript()
    expect(isDark()).toBe(true)
  })

  test('an explicit light choice wins over a dark OS', () => {
    stubOsPreference(true)
    document.documentElement.classList.add('dark')
    persistTheme('light')
    runBootScript()
    expect(isDark()).toBe(false)
  })

  test('system follows the OS', () => {
    stubOsPreference(true)
    persistTheme('system')
    runBootScript()
    expect(isDark()).toBe(true)
  })

  test('a first visit (nothing stored) follows the OS', () => {
    stubOsPreference(true)
    runBootScript()
    expect(isDark()).toBe(true)
  })

  test('a corrupt entry falls back to the OS instead of throwing', () => {
    stubOsPreference(true)
    localStorage.setItem(LAYOUT_STORE_KEY, '{not json')
    expect(runBootScript).not.toThrow()
    expect(isDark()).toBe(true)
  })

  test('storage that throws (private mode) falls back to the OS', () => {
    stubOsPreference(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(runBootScript).not.toThrow()
    expect(isDark()).toBe(true)
    vi.restoreAllMocks()
  })

  test('without matchMedia, system resolves to light rather than throwing', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(runBootScript).not.toThrow()
    expect(isDark()).toBe(false)
  })
})
