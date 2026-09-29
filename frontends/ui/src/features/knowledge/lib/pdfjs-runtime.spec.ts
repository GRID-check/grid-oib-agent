/**
 * `readPageTextItems` must read pdf.js's text stream the way Safari before 27
 * can: with a reader, never by async iteration.
 *
 * `page.getTextContent()` drained the same stream with `for await`, and on every
 * Safari that cannot iterate a `ReadableStream` it threw. The viewer took that
 * for a page with no text, so a cited passage was never marked while the page
 * rendered fine. The stream built here is a real `ReadableStream` with its async
 * iterator removed, which is that Safari's stream as far as this code can tell.
 * Against real pdf.js the helper is exercised by every spec that goes through
 * `@/test-utils/read-pdf`.
 */

import { describe, expect, it } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { readPageTextItems } from './pdfjs-runtime'

type TextStream = ReturnType<PDFPageProxy['streamTextContent']>

/** A text stream in pdf.js's chunk shape that cannot be async-iterated. */
const safariStream = (chunks: Array<{ items: unknown[] }>): TextStream => {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue({ ...chunk, styles: {}, lang: null })
      controller.close()
    },
  })
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined })
  return stream as unknown as TextStream
}

const run = (str: string) => ({
  str,
  dir: 'ltr',
  width: 40,
  height: 12,
  transform: [12, 0, 0, 12, 72, '700'],
  fontName: 'f1',
  hasEOL: false,
})

describe('readPageTextItems', () => {
  it('reads every chunk without iterating the stream', async () => {
    const page = {
      streamTextContent: () =>
        safariStream([{ items: [run('Die Sitztreppe')] }, { items: [run('im Innenhof')] }]),
    }

    // The guard guards itself: this stream really cannot be for-awaited.
    await expect(async () => {
      for await (const _chunk of page.streamTextContent() as unknown as AsyncIterable<unknown>) {
        // unreachable
      }
    }).rejects.toThrow(TypeError)

    const items = await readPageTextItems(page)

    expect(items.map((item) => item.str)).toEqual(['Die Sitztreppe', 'im Innenhof'])
    expect(items[0]?.transform).toEqual([12, 0, 0, 12, 72, 700])
  })

  it('drops marked-content entries, which carry structure and no text', async () => {
    const page = {
      streamTextContent: () =>
        safariStream([{ items: [{ type: 'beginMarkedContent', id: 'mc0' }, run('Absatz')] }]),
    }

    const items = await readPageTextItems(page)

    expect(items.map((item) => item.str)).toEqual(['Absatz'])
  })
})
