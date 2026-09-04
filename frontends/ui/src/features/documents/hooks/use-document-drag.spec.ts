import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  DOCUMENT_DRAG_TYPE,
  FOLDER_DRAG_TYPE,
  documentDragProps,
  draggedFolderId,
  folderDragProps,
  isExternalFileDrag,
  useFolderDropTarget,
} from './use-document-drag'

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

describe('folderDragProps', () => {
  it('carries the folder id twice, and the second one is the point', () => {
    const props = folderDragProps('folder-1')
    const dt = transfer([])
    props.onDragStart({ dataTransfer: dt, stopPropagation: vi.fn() } as unknown as React.DragEvent)

    // Read on drop, where `getData` is allowed.
    expect(dt.setData).toHaveBeenCalledWith(FOLDER_DRAG_TYPE, 'folder-1')
    // Read DURING the drag, where it is not: a type is visible, its data is
    // not, and a folder has to refuse itself before it highlights.
    expect(dt.setData).toHaveBeenCalledWith(`${FOLDER_DRAG_TYPE}:folder-1`, '')
  })

  it('reads the id back off the type list', () => {
    expect(draggedFolderId(transfer([FOLDER_DRAG_TYPE, `${FOLDER_DRAG_TYPE}:folder-9`]))).toBe(
      'folder-9',
    )
    expect(draggedFolderId(transfer([DOCUMENT_DRAG_TYPE]))).toBeNull()
  })
})

/**
 * The drop target, which is where the two gestures meet: it must take a
 * document from anywhere, take a folder only when the caller allows it, and
 * take nothing at all from the desktop — that last one is the upload, and the
 * workspace answers for it.
 */
describe('useFolderDropTarget', () => {
  const dragEvent = (dt: DataTransfer, currentTarget?: unknown) =>
    ({
      dataTransfer: dt,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: currentTarget ?? { contains: () => false },
      relatedTarget: null,
    }) as unknown as React.DragEvent

  const setup = (options: Partial<Parameters<typeof useFolderDropTarget>[0]> = {}) => {
    const onDropDocument = vi.fn()
    const onDropFolder = vi.fn()
    const { result } = renderHook(() =>
      useFolderDropTarget({
        folderId: 'target',
        onDropDocument,
        ...options,
      }),
    )
    return { result, onDropDocument, onDropFolder }
  }

  it('takes a document and reports where it lands', () => {
    const { result, onDropDocument } = setup()
    const dt = transfer([DOCUMENT_DRAG_TYPE], { [DOCUMENT_DRAG_TYPE]: 'doc-1' })

    act(() => result.current.dropProps.onDrop(dragEvent(dt)))
    expect(onDropDocument).toHaveBeenCalledWith('doc-1', 'target')
  })

  it('refuses an upload — that drop belongs to the workspace', () => {
    const { result, onDropDocument } = setup()
    const event = dragEvent(transfer(['Files']))

    act(() => result.current.dropProps.onDragOver(event))
    expect(result.current.isOver).toBe(false)
    act(() => result.current.dropProps.onDrop(event))
    expect(onDropDocument).not.toHaveBeenCalled()
    // Not claimed: the overlay above needs this event to reach it.
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not take folders at all when the surface cannot move them', () => {
    // The Archiv: flat, so a folder drag has nowhere to go and must not even
    // highlight.
    const { result } = setup()
    act(() =>
      result.current.dropProps.onDragOver(
        dragEvent(transfer([FOLDER_DRAG_TYPE, `${FOLDER_DRAG_TYPE}:folder-1`])),
      ),
    )
    expect(result.current.isOver).toBe(false)
  })

  it('highlights for a folder the caller accepts, and not for one it refuses', () => {
    const onDropFolder = vi.fn()
    const canAcceptFolder = (dragged: string) => dragged === 'ok'
    const { result } = renderHook(() =>
      useFolderDropTarget({
        folderId: 'target',
        onDropDocument: vi.fn(),
        onDropFolder,
        canAcceptFolder,
      }),
    )

    act(() =>
      result.current.dropProps.onDragOver(
        dragEvent(transfer([FOLDER_DRAG_TYPE, `${FOLDER_DRAG_TYPE}:nope`])),
      ),
    )
    expect(result.current.isOver).toBe(false)

    act(() =>
      result.current.dropProps.onDragOver(
        dragEvent(transfer([FOLDER_DRAG_TYPE, `${FOLDER_DRAG_TYPE}:ok`])),
      ),
    )
    expect(result.current.isOver).toBe(true)

    act(() =>
      result.current.dropProps.onDrop(
        dragEvent(
          transfer([FOLDER_DRAG_TYPE, `${FOLDER_DRAG_TYPE}:ok`], { [FOLDER_DRAG_TYPE]: 'ok' }),
        ),
      ),
    )
    expect(onDropFolder).toHaveBeenCalledWith('ok', 'target')
  })

  it('refuses a folder drag whose id it cannot read', () => {
    // Without the id it cannot rule out a folder being dropped into itself, and
    // offering that move is worse than not offering the gesture.
    const { result } = renderHook(() =>
      useFolderDropTarget({
        folderId: 'target',
        onDropDocument: vi.fn(),
        onDropFolder: vi.fn(),
      }),
    )
    act(() => result.current.dropProps.onDragOver(dragEvent(transfer([FOLDER_DRAG_TYPE]))))
    expect(result.current.isOver).toBe(false)
  })

  it('keeps the highlight when the pointer crosses the tile’s own children', () => {
    // `dragleave` fires on every internal boundary — the button, the label, the
    // count — and each one used to switch the highlight off and back on, so a
    // folder under the finger flickered for the whole drag.
    const { result } = setup()
    const dt = transfer([DOCUMENT_DRAG_TYPE])
    act(() => result.current.dropProps.onDragOver(dragEvent(dt)))
    expect(result.current.isOver).toBe(true)

    // Real nodes, because the guard asks a real question of them: is where the
    // pointer went still inside the element it left?
    const tile = document.createElement('div')
    const label = document.createElement('span')
    tile.append(label)

    act(() =>
      result.current.dropProps.onDragLeave({
        stopPropagation: vi.fn(),
        currentTarget: tile,
        relatedTarget: label,
      } as unknown as React.DragEvent),
    )
    expect(result.current.isOver).toBe(true)
  })

  it('drops the highlight when the pointer genuinely leaves', () => {
    const { result } = setup()
    act(() => result.current.dropProps.onDragOver(dragEvent(transfer([DOCUMENT_DRAG_TYPE]))))
    expect(result.current.isOver).toBe(true)

    act(() =>
      result.current.dropProps.onDragLeave({
        stopPropagation: vi.fn(),
        currentTarget: document.createElement('div'),
        relatedTarget: document.createElement('span'),
      } as unknown as React.DragEvent),
    )
    expect(result.current.isOver).toBe(false)
  })
})
