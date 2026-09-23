/**
 * What the picker shows where. Pinned: a folder shows its own subfolders and
 * documents; a search reaches down through the place, flat; „Zuletzt" is the
 * newest, „Ausgewählt" the chosen; the Archiv has no folders; a document in a
 * folder the listing does not know is shown at the root rather than lost.
 */

import { describe, expect, it } from 'vitest'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { contentsAt, folderCount, folderTrail, type PickerDocument } from './picker-model'

const folders: FolderItem[] = [
  { id: 'f-plans', parentId: null, name: 'Pläne', path: '/Pläne' },
  { id: 'f-eg', parentId: 'f-plans', name: 'EG', path: '/Pläne/EG' },
  { id: 'f-gut', parentId: null, name: 'Gutachten', path: '/Gutachten' },
]

const doc = (name: string, folderId: string | null, createdAt: string, shelf = 'project', fileSize = 1): PickerDocument => ({
  name,
  shelf,
  file: { folderId, createdAt, fileSize, contentType: null, pageCount: null, summary: null, tags: null },
})

const documents = [
  doc('Baubeschreibung.pdf', null, '2026-09-01T00:00:00Z'),
  doc('Grundriss EG.pdf', 'f-eg', '2026-09-05T00:00:00Z', 'project', 30),
  doc('Schnitt A.pdf', 'f-plans', '2026-09-03T00:00:00Z', 'project', 20),
  doc('Brandschutz.pdf', 'f-gut', '2026-09-04T00:00:00Z'),
  doc('Verloren.pdf', 'f-unknown', '2026-08-01T00:00:00Z'),
  doc('Leitfaden.pdf', null, '2026-09-06T00:00:00Z', 'archiv'),
]

const base = { documents, folders, selected: new Set<string>(), query: '', sort: { key: 'name' as const, direction: 'asc' as const }, locale: 'de' }
const names = (docs: PickerDocument[]) => docs.map((d) => d.name)

describe('contentsAt', () => {
  it('shows a folder its own subfolders and documents; an unknown folder falls to the root', () => {
    const root = contentsAt({ kind: 'shelf', shelf: 'project', folderId: null }, base)
    expect(root.folders.map((f) => f.name)).toEqual(['Gutachten', 'Pläne'])
    expect(names(root.documents)).toEqual(['Baubeschreibung.pdf', 'Verloren.pdf'])
    const plans = contentsAt({ kind: 'shelf', shelf: 'project', folderId: 'f-plans' }, base)
    expect(plans.folders.map((f) => f.name)).toEqual(['EG'])
    expect(names(plans.documents)).toEqual(['Schnitt A.pdf'])
  })

  it('searches through the place and everything beneath it, flat', () => {
    const found = contentsAt({ kind: 'shelf', shelf: 'project', folderId: 'f-plans' }, { ...base, query: 'pdf' })
    expect(found.folders).toEqual([])
    expect(names(found.documents)).toEqual(['Grundriss EG.pdf', 'Schnitt A.pdf'])
  })

  it('keeps the Archiv flat and apart from the project', () => {
    const archiv = contentsAt({ kind: 'shelf', shelf: 'archiv', folderId: null }, base)
    expect(archiv.folders).toEqual([])
    expect(names(archiv.documents)).toEqual(['Leitfaden.pdf'])
  })

  it('„Zuletzt" is the newest first, „Ausgewählt" what is chosen', () => {
    expect(names(contentsAt({ kind: 'recent' }, base).documents).slice(0, 2)).toEqual(['Leitfaden.pdf', 'Grundriss EG.pdf'])
    const chosen = contentsAt({ kind: 'selected' }, { ...base, selected: new Set(['schnitt a.pdf', 'leitfaden.pdf']) })
    expect(names(chosen.documents)).toEqual(['Leitfaden.pdf', 'Schnitt A.pdf'])
  })

  it('sorts by size and date, both ways', () => {
    const bySize = contentsAt({ kind: 'shelf', shelf: 'project', folderId: 'f-plans' }, { ...base, query: '.', sort: { key: 'size', direction: 'desc' } })
    expect(names(bySize.documents)).toEqual(['Grundriss EG.pdf', 'Schnitt A.pdf'])
  })
})

describe('folders', () => {
  it('walks the trail from the root and counts a folder with its subfolders', () => {
    expect(folderTrail('f-eg', folders).map((f) => f.name)).toEqual(['Pläne', 'EG'])
    expect(folderCount('f-plans', documents, folders)).toBe(2)
  })
})
