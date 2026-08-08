/**
 * A stand-in for the pdf.js runtime, for specs that render the PDF viewer.
 *
 * Shared rather than copied per spec because the interesting parts — the
 * viewport matrix and the shape of a text item — are exactly the contract the
 * viewer's geometry depends on. Two hand-maintained copies drift, and the
 * suite that still holds the stale one keeps passing against a pdf.js that no
 * longer exists.
 *
 * Usage, from a spec's `vi.mock` factory (which is hoisted, so the state object
 * must come from `vi.hoisted`):
 *
 *   const state = vi.hoisted(() => ({ fail: false, pages: [], destroyed: 0 }))
 *   vi.mock('../lib/pdfjs-runtime', () => fakePdfjsRuntime(state))
 */

/** The fields of a pdf.js `TextItem` the viewer reads. */
export interface FakeTextItem {
  str: string
  width: number
  height: number
  transform: number[]
}

export interface FakePdfState {
  /** When true, `loadPdfjs` rejects — the viewer's fallback path. */
  fail: boolean
  /** One entry per page, in order. */
  pages: Array<{ items: FakeTextItem[] }>
  /** Incremented when the loading task is destroyed. */
  destroyed: number
}

/** Page geometry the fake reports. A4-ish, and round enough to assert on. */
export const FAKE_PAGE_WIDTH = 600
export const FAKE_PAGE_HEIGHT = 800

/**
 * Frame width that makes fit-to-width resolve to a scale of exactly 1, so a
 * spec can assert page coordinates directly. Accounts for the viewer's gutter.
 */
export const FAKE_FRAME_WIDTH = FAKE_PAGE_WIDTH + 24

/** A 12pt run of text with its baseline at PDF-space (72, `baseline`). */
export const fakeTextRun = (str: string, baseline: number, width: number): FakeTextItem => ({
  str,
  width,
  height: 12,
  transform: [12, 0, 0, 12, 72, baseline],
})

/**
 * Build the module shape `vi.mock('../lib/pdfjs-runtime', …)` must return.
 * The viewport matrix is the one pdf.js builds for an unrotated page: x passes
 * through, y is flipped and shifted by the page height.
 */
export const fakePdfjsRuntime = (state: FakePdfState) => ({
  documentParameters: (url: string) => ({ url }),
  loadPdfjs: async () => {
    if (state.fail) throw new Error('worker unavailable')
    return {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: state.pages.length,
          getPage: (number: number) =>
            Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({
                width: FAKE_PAGE_WIDTH * scale,
                height: FAKE_PAGE_HEIGHT * scale,
                scale,
                transform: [scale, 0, 0, -scale, 0, FAKE_PAGE_HEIGHT * scale],
              }),
              render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
              cleanup: () => {},
              getTextContent: () =>
                Promise.resolve({ items: state.pages[number - 1]?.items ?? [] }),
            }),
        }),
        destroy: () => {
          state.destroyed += 1
          return Promise.resolve()
        },
      }),
    }
  },
})
