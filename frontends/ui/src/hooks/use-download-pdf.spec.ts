import { renderHook, act, waitFor } from '@testing-library/react'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { useDownloadPdfRoute } from './use-download-pdf'

describe('useDownloadPdfRoute', () => {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    vi.clearAllMocks()

    // Mock URL methods
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    global.URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    global.URL.createObjectURL = originalCreateObjectURL
    global.URL.revokeObjectURL = originalRevokeObjectURL
    vi.restoreAllMocks()
  })

  test('returns initial state', () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.downloadPdf).toBeInstanceOf(Function)
  })

  test('sets isLoading to true while downloading', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    let resolvePromise: (value: unknown) => void
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve
    })

    vi.stubGlobal('fetch', vi.fn(() => pendingPromise))

    // Start download (don't await)
    act(() => {
      result.current.downloadPdf('# Test')
    })

    // Should be loading
    expect(result.current.isLoading).toBe(true)

    // Resolve the promise
    await act(async () => {
      resolvePromise!({
        ok: true,
        blob: () => Promise.resolve(new Blob(['pdf'], { type: 'application/pdf' })),
      })
    })

    // Should stop loading
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
  })

  test('downloads PDF successfully', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    const mockBlob = new Blob(['pdf content'], { type: 'application/pdf' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }))

    // Mock anchor element click - set up AFTER renderHook
    const mockClick = vi.fn()
    const mockAnchor = { href: '', download: '', click: mockClick }
    vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockAnchor as unknown as Node)
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockAnchor as unknown as Node)

    await act(async () => {
      await result.current.downloadPdf('# My Report')
    })

    // Verify fetch was called correctly
    expect(global.fetch).toHaveBeenCalledWith('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# My Report' }),
    })

    // Verify blob URL was created
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob)

    // Verify link was clicked
    expect(mockClick).toHaveBeenCalled()

    // Verify URL was revoked
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')

    // Verify state
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  test('sets download filename with current date when no title provided', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    const mockBlob = new Blob(['pdf content'], { type: 'application/pdf' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }))

    const mockAnchor = { href: '', download: '', click: vi.fn() }
    vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockAnchor as unknown as Node)
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockAnchor as unknown as Node)

    await act(async () => {
      await result.current.downloadPdf('# Test')
    })

    // Verify filename format: report-YYYY-MM-DD.pdf
    expect(mockAnchor.download).toMatch(/^report-\d{4}-\d{2}-\d{2}\.pdf$/)
  })

  test('uses sanitized title as filename when provided', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    const mockBlob = new Blob(['pdf content'], { type: 'application/pdf' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }))

    const mockAnchor = { href: '', download: '', click: vi.fn() }
    vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockAnchor as unknown as Node)
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockAnchor as unknown as Node)

    await act(async () => {
      await result.current.downloadPdf('# Test', 'Market Analysis Report')
    })

    expect(mockAnchor.download).toBe('market-analysis-report.pdf')
  })

  test('says something a reader can act on when the render fails', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ code: 'INTERNAL' }),
    }))

    await act(async () => {
      await result.current.downloadPdf('# Test')
    })

    // NOT `statusText`. „Bad Request" in front of a German reader who has just
    // waited twelve minutes for a report is the defect this replaced (#624).
    expect(result.current.error).toBe('The PDF could not be created. Please try again.')
    expect(result.current.isLoading).toBe(false)
  })

  test('names the document, not the transport, when the report is too long', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Payload Too Large',
      json: () => Promise.resolve({ code: 'REPORT_TOO_LONG' }),
    }))

    await act(async () => {
      await result.current.downloadPdf('# Test')
    })

    // The one refusal the reader can do something about, so it says what.
    expect(result.current.error).toContain('too large to export as a PDF')
    expect(result.current.error).toContain('Markdown')
  })

  test('handles network error', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    await act(async () => {
      await result.current.downloadPdf('# Test')
    })

    expect(result.current.error).toBe('The PDF could not be created. Please try again.')
    expect(result.current.isLoading).toBe(false)
  })

  test('handles non-Error exception', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('Unknown error'))

    await act(async () => {
      await result.current.downloadPdf('# Test')
    })

    expect(result.current.error).toBe('The PDF could not be created. Please try again.')
    expect(result.current.isLoading).toBe(false)
  })

  test('clears error on new download attempt', async () => {
    const { result } = renderHook(() => useDownloadPdfRoute())

    // First call fails
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Error',
      json: () => Promise.resolve({ code: 'INTERNAL' }),
    }))

    await act(async () => {
      await result.current.downloadPdf('# Test')
    })

    expect(result.current.error).toBe('The PDF could not be created. Please try again.')

    // Second call succeeds - need to mock document methods
    const mockBlob = new Blob(['pdf content'], { type: 'application/pdf' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }))

    const mockAnchor = { href: '', download: '', click: vi.fn() }
    vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockAnchor as unknown as Node)
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockAnchor as unknown as Node)

    await act(async () => {
      await result.current.downloadPdf('# Test 2')
    })

    // Error should be cleared
    expect(result.current.error).toBeNull()
  })
})
