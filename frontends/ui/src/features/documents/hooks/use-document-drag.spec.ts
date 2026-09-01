/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_DRAG_TYPE, documentDragProps, isExternalFileDrag } from './use-document-drag'

const transfer = (types: string[], data: Record<string, string> = {}) =>
  ({
    types,
    getData: (key: string) => data[key] ?? '',
    setData: vi.fn(),
  }) as unknown as DataTransfer

describe('telling an internal drag from an upload', () => {
  /**
   * The workspace already listens for drags — dropping files from the desktop
   * is how you upload — so a file dragged INSIDE the page must not raise the
   * upload overlay. The test is a fact the browser guarantees rather than a
   * flag we set: `types` contains `Files` only for a drag carrying real files.
   */
  it('recognises a desktop file drag', () => {
    expect(isExternalFileDrag(transfer(['Files']))).toBe(true)
  })

  it('does not mistake an in-app document drag for one', () => {
    expect(isExternalFileDrag(transfer([DOCUMENT_DRAG_TYPE]))).toBe(false)
  })

  it('treats a missing dataTransfer as not-an-upload rather than throwing', () => {
    expect(isExternalFileDrag(null)).toBe(false)
  })
})

describe('documentDragProps', () => {
  it('carries the document id under our own MIME type', () => {
    // A custom type, not `text/plain`: a paragraph dragged from another tab
    // must not be able to look like a document.
    const props = documentDragProps('doc-1')
    const dt = transfer([])
    props.onDragStart({ dataTransfer: dt } as unknown as React.DragEvent)

    expect(dt.setData).toHaveBeenCalledWith(DOCUMENT_DRAG_TYPE, 'doc-1')
    expect(dt.effectAllowed).toBe('move')
  })
})
