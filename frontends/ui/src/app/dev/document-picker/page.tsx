'use client'

/**
 * Dev preview for the document picker — the REAL `DocumentPickerDialog`, over
 * a project with folders, an Archiv and a few documents a caller rules out,
 * so every place, view and state can be clicked through. Fetch-free; not
 * linked from anywhere; 404s outside development. Pinned to German, the
 * product's primary language, so a capture carries the copy that ships.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'

import { Button } from '@/components/ui/button'
import {
  DocumentPickerDialog,
  type PickerDocument,
} from '@/features/documents/components/document-picker/DocumentPickerDialog'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { toLibraryDocument } from '@/features/documents/hooks/use-document-library'
import { I18nProvider } from '@/i18n'

const FOLDERS: FolderItem[] = [
  { id: 'f-einreichung', parentId: null, name: '03 Einreichung', path: '/03 Einreichung' },
  { id: 'f-plaene', parentId: 'f-einreichung', name: 'Pläne', path: '/03 Einreichung/Pläne' },
  { id: 'f-gutachten', parentId: null, name: '05 Gutachten', path: '/05 Gutachten' },
  { id: 'f-modelle', parentId: null, name: '07 Modelle', path: '/07 Modelle' },
]

const TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  ifc: 'application/x-step',
}

/** One listing row, projected exactly as the live listing projects it. */
const doc = (
  filename: string,
  shelf: 'project' | 'archiv',
  {
    title,
    folderId = null,
    day,
    kb,
    pages = null,
    summary = null,
  }: { title?: string; folderId?: string | null; day: number; kb: number; pages?: number | null; summary?: string | null }
): PickerDocument =>
  toLibraryDocument(
    {
      id: `dev-${filename}`,
      filename,
      displayName: title ?? null,
      fileSize: kb * 1024,
      contentType: TYPE[filename.split('.').pop() ?? ''] ?? null,
      status: 'ready',
      folderId,
      createdAt: `2026-09-${String(day).padStart(2, '0')}T09:30:00Z`,
      pageCount: pages,
      summary,
    },
    shelf
  )

const DEV_PICKER_DOCUMENTS: PickerDocument[] = [
  doc('Baubeschreibung.pdf', 'project', { day: 2, kb: 840, pages: 14 }),
  doc('Raumbuch.xlsx', 'project', { day: 11, kb: 96 }),
  doc('Fotodoku_Bestand.jpg', 'project', { title: 'Fotodokumentation Bestand', day: 4, kb: 3200 }),
  doc('Grundriss_EG.pdf', 'project', {
    title: 'Grundriss EG',
    folderId: 'f-plaene',
    day: 18,
    kb: 2300,
    pages: 1,
    summary: 'Erdgeschoss mit Stiegenhaus, zwei Wohnungen und Müllraum; Maßstab 1:100.',
  }),
  doc('Grundriss_OG1.pdf', 'project', { title: 'Grundriss 1. OG', folderId: 'f-plaene', day: 18, kb: 2100, pages: 1 }),
  doc('Schnitt_A-A.pdf', 'project', { title: 'Schnitt A–A', folderId: 'f-plaene', day: 19, kb: 1200, pages: 1 }),
  doc('Lageplan.pdf', 'project', { folderId: 'f-einreichung', day: 16, kb: 900, pages: 1 }),
  doc('Baubescheid_2025.pdf', 'project', { title: 'Baubescheid 2025', folderId: 'f-einreichung', day: 20, kb: 310, pages: 6 }),
  doc('Brandschutzkonzept_v2.pdf', 'project', {
    title: 'Brandschutzkonzept v2',
    folderId: 'f-gutachten',
    day: 21,
    kb: 1800,
    pages: 32,
    summary: 'Brandschutzkonzept für GK 4 mit Fluchtwegen, Brandabschnitten und Rauchableitung.',
  }),
  doc('Brandschutzkonzept_v1.pdf', 'project', {
    title: 'Brandschutzkonzept v1 (überholt)',
    folderId: 'f-gutachten',
    day: 3,
    kb: 1700,
    pages: 29,
  }),
  doc('Architekturmodell.ifc', 'project', { title: 'Architekturmodell', folderId: 'f-modelle', day: 22, kb: 48000 }),
  doc('OIB-RL 2 Leitfaden.pdf', 'archiv', { title: 'Leitfaden OIB 2', day: 1, kb: 1500, pages: 48 }),
  doc('Musterstellungnahme.docx', 'archiv', { title: 'Musterstellungnahme Brandschutz', day: 7, kb: 64, pages: 5 }),
]

export default function DocumentPickerPreviewPage() {
  const [open, setOpen] = useState(true)
  const [chosen, setChosen] = useState<string[]>(['Grundriss_EG.pdf'])
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6 text-foreground md:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Dokumentauswahl</h1>
        <p className="text-sm text-muted-foreground">Gewählt: {chosen.join(', ') || '—'}</p>
        <div>
          <Button size="sm" onClick={() => setOpen(true)} data-testid="dev-open-picker">
            Auswahl öffnen
          </Button>
        </div>
        <DocumentPickerDialog
          open={open}
          onOpenChange={setOpen}
          title="Welche Unterlagen soll Piloti zuerst lesen?"
          description="Die gewählten liest die Recherche vollständig, bevor sie weitersucht. Alle anderen bleiben verfügbar."
          documents={DEV_PICKER_DOCUMENTS}
          folders={FOLDERS}
          initialSelected={chosen}
          disabledReason={(doc) => (doc.name === 'Brandschutzkonzept_v1.pdf' ? 'Ausgeschlossen' : null)}
          confirmLabel="Übernehmen"
          onConfirm={(docs) => setChosen(docs.map((doc) => doc.name))}
        />
      </main>
    </I18nProvider>
  )
}
