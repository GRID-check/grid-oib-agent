import { renderHook, act } from '@testing-library/react'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { useFileDragDrop } from './use-file-drag-drop'

// Mock the validation module
vi.mock('../validation', () => ({
  checkDraggedFilesSupported: vi.fn(() => true),
}))

// Mock useAppConfig
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

import { checkDraggedFilesSupported } from '../validation'

/**
 * A drag carrying files from the desktop.
 *
 * `types: ['Files']` is not decoration — it is the fact this hook discriminates
 * on, and the browser sets it for every drag that carries real files and for no
 * drag started inside the page. The fixture omitted it, which is how the hook
 * came to answer for in-app drags too: nothing here could tell the two apart, so
 * nothing here noticed that the hook could not either.
 */
function createMockDragEvent(files: File[] = [], items: DataTransferItem[] = []): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types: ['Files'],
      files,
      items: items.length > 0 ? items : files.map(() => ({ kind: 'file', type: 'application/pdf' })),
    },
  } as unknown as React.DragEvent
}

/** A drag started inside the page — a document being moved into a folder. */
function createInternalDragEvent(type = 'application/x-grid-document-id'): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types: [type],
      files: [],
      items: [{ kind: 'string', type }],
    },
  } as unknown as React.DragEvent
}

describe('useFileDragDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkDraggedFilesSupported).mockReturnValue(true)
  })

  test('returns initial state with isDragging false', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    expect(result.current.isDragging).toBe(false)
    expect(result.current.isUnsupportedDrag).toBe(false)
    expect(result.current.dragHandlers).toBeDefined()
    expect(result.current.dragHandlers.onDragEnter).toBeInstanceOf(Function)
    expect(result.current.dragHandlers.onDragLeave).toBeInstanceOf(Function)
    expect(result.current.dragHandlers.onDragOver).toBeInstanceOf(Function)
    expect(result.current.dragHandlers.onDrop).toBeInstanceOf(Function)
  })

  test('sets isDragging to true on dragEnter with files', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const mockEvent = createMockDragEvent(
      [new File(['content'], 'test.pdf', { type: 'application/pdf' })],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )

    act(() => {
      result.current.dragHandlers.onDragEnter(mockEvent)
    })

    expect(result.current.isDragging).toBe(true)
    expect(mockEvent.preventDefault).toHaveBeenCalled()
    expect(mockEvent.stopPropagation).toHaveBeenCalled()
  })

  test('sets isUnsupportedDrag when files are unsupported', () => {
    vi.mocked(checkDraggedFilesSupported).mockReturnValue(false)

    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const mockEvent = createMockDragEvent(
      [new File(['content'], 'test.exe', { type: 'application/x-msdownload' })],
      [{ kind: 'file', type: 'application/x-msdownload' } as DataTransferItem]
    )

    act(() => {
      result.current.dragHandlers.onDragEnter(mockEvent)
    })

    expect(result.current.isDragging).toBe(true)
    expect(result.current.isUnsupportedDrag).toBe(true)
  })

  test('resets isDragging on dragLeave when counter reaches zero', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const enterEvent = createMockDragEvent(
      [new File(['content'], 'test.pdf', { type: 'application/pdf' })],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )

    // Enter once
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    expect(result.current.isDragging).toBe(true)

    // Leave once
    const leaveEvent = createMockDragEvent()
    act(() => {
      result.current.dragHandlers.onDragLeave(leaveEvent)
    })
    expect(result.current.isDragging).toBe(false)
  })

  test('keeps isDragging true with nested drag enter/leave', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const enterEvent = createMockDragEvent(
      [new File(['content'], 'test.pdf', { type: 'application/pdf' })],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )
    const leaveEvent = createMockDragEvent()

    // Enter parent
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    // Enter child
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    expect(result.current.isDragging).toBe(true)

    // Leave child
    act(() => {
      result.current.dragHandlers.onDragLeave(leaveEvent)
    })
    // Should still be dragging (counter = 1)
    expect(result.current.isDragging).toBe(true)

    // Leave parent
    act(() => {
      result.current.dragHandlers.onDragLeave(leaveEvent)
    })
    // Now should be false (counter = 0)
    expect(result.current.isDragging).toBe(false)
  })

  test('calls onDrop with files and resets state', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const enterEvent = createMockDragEvent(
      [file],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )
    const dropEvent = createMockDragEvent([file])

    // Enter to set dragging state
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    expect(result.current.isDragging).toBe(true)

    // Drop
    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).toHaveBeenCalledWith([file])
    expect(result.current.isDragging).toBe(false)
    expect(result.current.isUnsupportedDrag).toBe(false)
    expect(dropEvent.preventDefault).toHaveBeenCalled()
    expect(dropEvent.stopPropagation).toHaveBeenCalled()
  })

  test('does not call onDrop with empty files', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const dropEvent = createMockDragEvent([])

    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).not.toHaveBeenCalled()
  })

  test('does not trigger drag events when disabled', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop, disabled: true }))

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const enterEvent = createMockDragEvent(
      [file],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )

    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })

    // Event handlers still called but state doesn't change
    expect(result.current.isDragging).toBe(false)
  })

  test('does not call onDrop when disabled', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop, disabled: true }))

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const dropEvent = createMockDragEvent([file])

    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).not.toHaveBeenCalled()
  })

  test('onDragOver prevents default', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const overEvent = createMockDragEvent()

    act(() => {
      result.current.dragHandlers.onDragOver(overEvent)
    })

    expect(overEvent.preventDefault).toHaveBeenCalled()
    expect(overEvent.stopPropagation).toHaveBeenCalled()
  })

  test('handles multiple files on drop', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const files = [
      new File(['content1'], 'test1.pdf', { type: 'application/pdf' }),
      new File(['content2'], 'test2.pdf', { type: 'application/pdf' }),
      new File(['content3'], 'test3.txt', { type: 'text/plain' }),
    ]
    const dropEvent = createMockDragEvent(files)

    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).toHaveBeenCalledWith(files)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE UPLOAD SURFACE MUST NOT ANSWER FOR A MOVE.
 *
 * Dragging a document at a folder raised the full-surface "drop files to upload
 * to this project" overlay over the folder it was aimed at, because this hook
 * reacted to any drag with items on it — and an in-app drag has one, our own
 * MIME type. The move underneath still worked; nothing on screen said so.
 */
describe('useFileDragDrop — an in-app drag is not an upload', () => {
  test('ignores a document drag entirely', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    act(() => result.current.dragHandlers.onDragEnter(createInternalDragEvent()))

    expect(result.current.isDragging).toBe(false)
    expect(result.current.isUnsupportedDrag).toBe(false)
  })

  test('ignores a folder drag entirely', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    act(() =>
      result.current.dragHandlers.onDragEnter(
        createInternalDragEvent('application/x-grid-folder-id'),
      ),
    )

    expect(result.current.isDragging).toBe(false)
  })

  test('leaves the drop to the folder under the pointer', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))
    const event = createInternalDragEvent()

    act(() => result.current.dragHandlers.onDrop(event))

    expect(onDrop).not.toHaveBeenCalled()
    // Not claimed as a drop target either: `preventDefault` here would make the
    // whole workspace accept a move, so a document released between two folder
    // tiles would look accepted and do nothing.
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  test('an uncounted leave cannot strand the overlay on the next real upload', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    // A move crosses the workspace and leaves it. Neither event is this hook's.
    act(() => result.current.dragHandlers.onDragLeave(createInternalDragEvent()))
    act(() => result.current.dragHandlers.onDragLeave(createInternalDragEvent()))

    // Then a genuine upload arrives. If the leaves above had been subtracted,
    // the counter would be at -2 and one leave would never bring it back to 0.
    act(() => result.current.dragHandlers.onDragEnter(createMockDragEvent([new File(['x'], 'a.pdf')])))
    expect(result.current.isDragging).toBe(true)
    act(() => result.current.dragHandlers.onDragLeave(createMockDragEvent([new File(['x'], 'a.pdf')])))
    expect(result.current.isDragging).toBe(false)
  })
})
