import '@testing-library/jest-dom/vitest'
import crypto from 'crypto'
import { createElement } from 'react'
import { beforeAll, afterEach, afterAll, vi } from 'vitest'
import { server } from '../../src/mocks/server'
import { resetDatabase } from '../../src/mocks/database'

// Default mock for AuthKit components so tests that import `@/adapters/auth`
// (or anything transitively pulling in `@workos-inc/authkit-nextjs/components`)
// do not need to mock authentication state unless they care about it. This also
// avoids resolving `next/cache` inside the AuthKit ESM bundle, which Vitest's
// transformer cannot handle because Next only ships `next/cache.js`.
vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  AuthKitProvider: ({ children }: { children: React.ReactNode }) => children,
  SignInButton: ({ children }: { children: React.ReactNode }) => children,
  useAuth: vi.fn(() => ({
    user: null,
    organizationId: undefined,
    loading: false,
    getAuth: vi.fn(),
    signOut: vi.fn(),
  })),
  useAccessToken: vi.fn(() => ({
    accessToken: undefined,
    loading: false,
    error: undefined,
    getAccessToken: vi.fn(),
  })),
}))

// Prevent external-svg-loader timer from firing after test environment teardown.
// The library schedules a setTimeout that accesses `document`, which no longer
// exists once happy-dom cleans up, causing "ReferenceError: document is not defined".
vi.mock('external-svg-loader', () => ({}))

const createSvgIcon = (props: Record<string, unknown>, testId: string) => {
  const {
    className,
    role,
    width,
    height,
    style,
    color,
    'aria-label': ariaLabel,
    'aria-hidden': ariaHidden,
  } = props

  return createElement('svg', {
    className,
    role,
    width,
    height,
    style,
    color,
    'aria-label': ariaLabel,
    'aria-hidden': ariaHidden,
    'data-testid': testId,
  })
}

vi.mock('@nv-brand-assets/react-icons', () => ({
  NvidiaGUIIcon: (props: Record<string, unknown>) =>
    createSvgIcon(props, 'mock-nvidia-gui-icon'),
}))
vi.mock('@nv-brand-assets/react-marketing-icons', () => ({
  NvidiaMarketingIcon: (props: Record<string, unknown>) =>
    createSvgIcon(props, 'mock-nvidia-marketing-icon'),
}))

// @ts-expect-error - Setting NODE_ENV for tests
process.env.NODE_ENV = 'test'

// Crypto polyfill
Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: (arr: unknown[]) => crypto.randomBytes(arr.length),
  },
})

// Storage mocks — Node.js 22+ exposes a broken built-in localStorage when
// `--localstorage-file` is passed without a valid path, overriding happy-dom's
// implementation.  Provide explicit in-memory mocks for both storages.
function createStorageMock() {
  let storage: Record<string, string> = {}

  return {
    clear: () => (storage = {}),
    getItem: (key: string) => (key in storage ? storage[key] : null),
    getAll: () => storage,
    key: (index: number) => Object.keys(storage)[index] ?? null,
    get length() {
      return Object.keys(storage).length
    },
    removeItem: (key: string) => {
      delete storage[key]
    },
    setItem: (key: string, value: string) => {
      storage[key] = String(value)
    },
  }
}

const localStorageMock = createStorageMock()
const sessionStorageMock = createStorageMock()

// Browser API mocks for happy-dom
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MutationObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(global, 'localStorage', { value: localStorageMock, configurable: true })
Object.defineProperty(global, 'sessionStorage', { value: sessionStorageMock, configurable: true })
global.ResizeObserver = ResizeObserver

// Node can expose a partial `localStorage` (e.g. missing `removeItem`) when a path
// triggers web storage before happy-dom is ready. Chat/documents tests need full Storage.
if (typeof globalThis.localStorage?.removeItem !== 'function') {
  const mem: Record<string, string> = {}
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => (key in mem ? mem[key] : null),
      setItem: (key: string, value: string) => {
        mem[key] = value
      },
      removeItem: (key: string) => {
        delete mem[key]
      },
      clear: () => {
        for (const k of Object.keys(mem)) delete mem[k]
      },
      key: (index: number) => Object.keys(mem)[index] ?? null,
      get length() {
        return Object.keys(mem).length
      },
    } as Storage,
    configurable: true,
  })
}
// @ts-expect-error - Partial mock
global.IntersectionObserver = IntersectionObserver
// @ts-expect-error - Partial mock
global.MutationObserver = MutationObserver

// Force a deterministic locale for locale-sensitive formatting so tests behave
// the same regardless of the host OS locale (e.g. CI runners vs. developer
// machines). Some call sites pass an empty array (`[]`) to mean "default"
// locale; treat that as en-US as well.
const originalDateToLocaleString = Date.prototype.toLocaleString
const originalDateToLocaleDateString = Date.prototype.toLocaleDateString
const originalDateToLocaleTimeString = Date.prototype.toLocaleTimeString
const originalNumberToLocaleString = Number.prototype.toLocaleString

function toEffectiveLocales(locales?: string | string[] | undefined) {
  if (!locales) return 'en-US'
  if (Array.isArray(locales) && locales.length === 0) return 'en-US'
  return locales
}

Date.prototype.toLocaleString = function (
  locales?: string | string[] | undefined,
  options?: Intl.DateTimeFormatOptions | undefined,
) {
  return originalDateToLocaleString.call(this, toEffectiveLocales(locales), options)
}

Date.prototype.toLocaleDateString = function (
  locales?: string | string[] | undefined,
  options?: Intl.DateTimeFormatOptions | undefined,
) {
  return originalDateToLocaleDateString.call(
    this,
    toEffectiveLocales(locales),
    options,
  )
}

Date.prototype.toLocaleTimeString = function (
  locales?: string | string[] | undefined,
  options?: Intl.DateTimeFormatOptions | undefined,
) {
  return originalDateToLocaleTimeString.call(
    this,
    toEffectiveLocales(locales),
    options,
  )
}

Number.prototype.toLocaleString = function (
  locales?: string | string[] | undefined,
  options?: Intl.NumberFormatOptions | undefined,
) {
  return originalNumberToLocaleString.call(this, toEffectiveLocales(locales), options)
}

// MSW server lifecycle
beforeAll(() => {
  localStorageMock.clear()
  sessionStorageMock.clear()
  return server.listen({ onUnhandledRequest: 'bypass' })
})

afterEach(() => {
  server.resetHandlers()
  resetDatabase()
})

afterAll(() => server.close())
