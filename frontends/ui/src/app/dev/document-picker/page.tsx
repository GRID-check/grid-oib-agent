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
import { I18nProvider } from '@/i18n'

const FOLDERS: FolderItem[] = [
  { id: 'f-einreichung', parentId: null, name: '03 Einreichung', path: '/03 Einreichung' },
  { id: 'f-plaene', parentId: 'f-einreichung', name: 'Pläne', path: '/03 Einreichung/Pläne' },
  { id: 'f-gutachten', parentId: null, name: '05 Gutachten', path: '/05 Gutachten' },
  { id: 'f-modelle', parentId: null, name: '07 Modelle', path: '/07 Modelle' },
]

const file = (folderId: string | null, day: number, kb: number, pages: number | null, summary: string | null = null) => ({
  folderId,
  createdAt: `2026-09-${String(day).padStart(2, '0')}T09:30:00Z`,
  fileSize: kb * 1024,
  contentType: null,
  pageCount: pages,
  summary,
  tags: null,
})

const DEV_PICKER_DOCUMENTS: PickerDocument[] = [
  { name: 'Baubeschreibung.pdf', shelf: 'project', file: file(null, 2, 840, 14) },
  { name: 'Raumbuch.xlsx', shelf: 'project', file: file(null, 11, 96, null) },
  { name: 'Fotodoku_Bestand.jpg', title: 'Fotodokumentation Bestand', shelf: 'project', file: file(null, 4, 3200, null) },
  {
    name: 'Grundriss_EG.pdf',
    title: 'Grundriss EG',
    shelf: 'project',
    file: file('f-plaene', 18, 2300, 1, 'Erdgeschoss mit Stiegenhaus, zwei Wohnungen und Müllraum; Maßstab 1:100.'),
  },
  { name: 'Grundriss_OG1.pdf', title: 'Grundriss 1. OG', shelf: 'project', file: file('f-plaene', 18, 2100, 1) },
  { name: 'Schnitt_A-A.pdf', title: 'Schnitt A–A', shelf: 'project', file: file('f-plaene', 19, 1200, 1) },
  { name: 'Lageplan.pdf', shelf: 'project', file: file('f-einreichung', 16, 900, 1) },
  { name: 'Baubescheid_2025.pdf', title: 'Baubescheid 2025', shelf: 'project', file: file('f-einreichung', 20, 310, 6) },
  {
    name: 'Brandschutzkonzept_v2.pdf',
    title: 'Brandschutzkonzept v2',
    shelf: 'project',
    file: file('f-gutachten', 21, 1800, 32, 'Brandschutzkonzept für GK 4 mit Fluchtwegen, Brandabschnitten und Rauchableitung.'),
  },
  { name: 'Brandschutzkonzept_v1.pdf', title: 'Brandschutzkonzept v1 (überholt)', shelf: 'project', file: file('f-gutachten', 3, 1700, 29) },
  { name: 'Architekturmodell.ifc', title: 'Architekturmodell', shelf: 'project', file: file('f-modelle', 22, 48000, null) },
  { name: 'OIB-RL 2 Leitfaden.pdf', title: 'Leitfaden OIB 2', shelf: 'archiv', file: file(null, 1, 1500, 48) },
  { name: 'Musterstellungnahme.docx', title: 'Musterstellungnahme Brandschutz', shelf: 'archiv', file: file(null, 7, 64, 5) },
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
          title="Schwerpunkte wählen"
          description="Diese Unterlagen liest die Recherche zuerst und vollständig. Alle anderen bleiben verfügbar."
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
