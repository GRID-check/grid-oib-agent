import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '@/shared/context'
import { Providers } from './providers'

const layoutState = {
  theme: 'dark',
  fetchDataSources: vi.fn(),
  availableDataSources: [] as Array<{ id: string }>,
  setEnabledDataSources: vi.fn(),
}

const chatState = {
  currentConversation: null as { id: string; enabledDataSourceIds?: string[] } | null,
  reconnectToActiveJob: vi.fn(),
  cleanupOrphanedStartingBanners: vi.fn(),
  isDeepResearchStreaming: false,
  loadServerConversations: vi.fn(),
}

vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  AuthKitProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/layout', () => ({
  useLayoutStore: (selector: (state: typeof layoutState) => unknown) => selector(layoutState),
}))

vi.mock('@/features/chat/store', () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
    }
  ),
}))

const baseConfig: AppConfig = {
  authRequired: true,
  fileUpload: {
    acceptedTypes: '.pdf',
    acceptedMimeTypes: ['application/pdf'],
    maxTotalSizeMB: 100,
    maxFileSize: 100 * 1024 * 1024,
    maxTotalSize: 100 * 1024 * 1024,
    maxFileCount: 10,
    fileExpirationCheckIntervalHours: 0,
  },
}

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders children inside AuthKitProvider', () => {
    const { container } = render(
      <Providers config={baseConfig}>
        <div data-testid="content">content</div>
      </Providers>
    )

    expect(container.querySelector('[data-testid="content"]')).toBeInTheDocument()
  })

  test('does not create duplicate interval timers in providers tree', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    render(
      <Providers config={baseConfig}>
        <div>content</div>
      </Providers>
    )

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })
})
