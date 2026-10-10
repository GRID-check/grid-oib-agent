/**
 * The corpus behind `/dev/folder-brief`: one Austrian architecture project,
 * "Wohnbau Seestadt Nord", as the listing would carry it.
 *
 * Every status the brief sorts is present once or more: mostly completed, three
 * in flight, one pending, four failed (two in `Pläne`, two in `Details`), one
 * held by the content screen, one agent report at rest, and five photos of the
 * site that Piloti read but could not place in a document type (three carry
 * what the camera wrote). Two earlier Fassungen sit in `03_Einreichung/alt`,
 * named with their index, so the brief has revision series to name.
 *
 * Tags come ONLY from `lib/documents/tag-vocabulary.ts`. Unknown values are null,
 * not guesses: a document still being read has no tags yet, a failed one's are
 * absent, and a quarantined one's content is never described.
 */

import type { FileItem, FolderItem } from '@/features/documents/file-types'
import type { DocumentAuthor } from '@/lib/documents/document-authors'
import type { PhotoCapture } from '@/lib/documents/photo-capture'
import type { DocumentTypeTag, DisciplineTag } from '@/lib/documents/tag-vocabulary'

type ContentType = 'text' | 'table' | 'image' | 'chart' | 'drawing'

interface DocSpec {
  id: string
  filename: string
  folderId: string | null
  status: string
  createdAt: string
  fileSize: number
  contentType?: string
  pageCount?: number | null
  chunkCount?: number | null
  contentTypes?: readonly ContentType[] | null
  tags?: readonly (DocumentTypeTag | DisciplineTag)[] | null
  summary?: string | null
  errorMessage?: string | null
  authoredBy?: DocumentAuthor
  /** Piloti's open keywords beside the tags. */
  topics?: readonly string[] | null
  /** What the camera wrote, for a photo. */
  capture?: PhotoCapture | null
}

const PDF = 'application/pdf'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const JPEG = 'image/jpeg'

/** A listing row, with every FileItem field present: unknowns are null, never absent. */
function doc(spec: DocSpec): FileItem {
  return {
    id: spec.id,
    filename: spec.filename,
    displayName: null,
    fileSize: spec.fileSize,
    contentType: spec.contentType ?? PDF,
    status: spec.status,
    folderId: spec.folderId,
    createdAt: spec.createdAt,
    errorMessage: spec.errorMessage ?? null,
    summary: spec.summary ?? null,
    pageCount: spec.pageCount ?? null,
    chunkCount: spec.chunkCount ?? null,
    contentTypes: spec.contentTypes ? [...spec.contentTypes] : null,
    tags: spec.tags ? [...spec.tags] : null,
    topics: spec.topics ? [...spec.topics] : null,
    capture: spec.capture ?? null,
    authoredBy: spec.authoredBy ?? 'user',
  }
}

export const PROJECT_NAME = 'Wohnbau Seestadt Nord'

/** Folder ids are readable on purpose: the preview page names them in its sections. */
export const FOLDERS: FolderItem[] = [
  { id: 'f-01', parentId: null, name: '01_Grundlagen', path: '01_Grundlagen' },
  { id: 'f-02', parentId: null, name: '02_Entwurf', path: '02_Entwurf' },
  { id: 'f-03', parentId: null, name: '03_Einreichung', path: '03_Einreichung' },
  { id: 'f-03-plaene', parentId: 'f-03', name: 'Pläne', path: '03_Einreichung/Pläne' },
  { id: 'f-03-gutachten', parentId: 'f-03', name: 'Gutachten', path: '03_Einreichung/Gutachten' },
  { id: 'f-03-alt', parentId: 'f-03', name: 'alt', path: '03_Einreichung/alt' },
  { id: 'f-03-bescheide', parentId: 'f-03', name: 'Bescheide', path: '03_Einreichung/Bescheide' },
  { id: 'f-04', parentId: null, name: '04_Ausführung', path: '04_Ausführung' },
  { id: 'f-04-details', parentId: 'f-04', name: 'Details', path: '04_Ausführung/Details' },
  { id: 'f-04-fotos', parentId: 'f-04', name: 'Fotos Baustelle', path: '04_Ausführung/Fotos Baustelle' },
  { id: 'f-05', parentId: null, name: '05_Korrespondenz', path: '05_Korrespondenz' },
]

export const FILES: FileItem[] = [
  // 01_Grundlagen: every document read and typed. The "all read" section.
  doc({
    id: 'd-01-01', filename: 'Flächenwidmungsplan_Auszug_Seestadt.pdf', folderId: 'f-01',
    status: 'completed', createdAt: '2026-07-08T09:12:00Z', fileSize: 1_820_000,
    pageCount: 2, chunkCount: 9, contentTypes: ['drawing', 'text'], tags: ['Flächenwidmungsplan'],
    summary: 'Auszug aus dem Flächenwidmungsplan der Seestadt Aspern mit der Widmung für das Baugrundstück GST 1182.',
  }),
  doc({
    id: 'd-01-02', filename: 'Bebauungsplan_BPL-47_Auszug.pdf', folderId: 'f-01',
    status: 'completed', createdAt: '2026-07-08T09:14:00Z', fileSize: 940_000,
    pageCount: 3, chunkCount: 12, contentTypes: ['drawing', 'text'], tags: ['Bebauungsplan'],
    summary: 'Bebauungsplan mit Bauklassen, Bauflucht und zulässiger Gebäudehöhe für den Bauplatz.',
  }),
  doc({
    id: 'd-01-03', filename: 'Grundstücksdaten_GST-1182.pdf', folderId: 'f-01',
    status: 'completed', createdAt: '2026-07-09T14:02:00Z', fileSize: 310_000,
    pageCount: 4, chunkCount: 7, contentTypes: ['table', 'text'], tags: ['Sonstiges'],
    summary: 'Grundbuchauszug und Flächenangaben zum Grundstück GST-Nr. 1182, KG Aspern.',
  }),
  doc({
    id: 'd-01-04', filename: 'OIB-Richtlinie_2_Brandschutz_2023.pdf', folderId: 'f-01',
    status: 'completed', createdAt: '2026-07-10T08:30:00Z', fileSize: 4_600_000,
    pageCount: 58, chunkCount: 140, contentTypes: ['text', 'table'], tags: ['Norm/Richtlinie', 'Brandschutz'],
    summary: 'Auszug der OIB-Richtlinie 2 zu Brandschutz mit den Anforderungen an die Gebäudeklasse 4.',
  }),
  doc({
    id: 'd-01-05', filename: 'ÖNORM_B_1800_Flächenermittlung.pdf', folderId: 'f-01',
    status: 'completed', createdAt: '2026-07-10T08:45:00Z', fileSize: 1_200_000,
    pageCount: 22, chunkCount: 61, contentTypes: ['text', 'table'], tags: ['Norm/Richtlinie'],
    summary: 'Regelwerk zur Ermittlung von Netto- und Bruttogeschossflächen nach ÖNORM B 1800.',
  }),
  doc({
    id: 'd-01-06', filename: 'Geotechnischer_Bericht_Seestadt.pdf', folderId: 'f-01',
    status: 'completed', createdAt: '2026-07-15T11:20:00Z', fileSize: 7_900_000,
    pageCount: 46, chunkCount: 118, contentTypes: ['text', 'table', 'chart'], tags: ['Gutachten', 'Standsicherheit'],
    summary: 'Baugrunderkundung mit vier Bohrungen, Grundwasserstand und Empfehlung zur Gründung.',
  }),

  // 02_Entwurf: the design stage. One in flight, one agent report at rest.
  doc({
    id: 'd-02-01', filename: 'Entwurfsbeschreibung_Wohnbau_Nord_v2.pdf', folderId: 'f-02',
    status: 'completed', createdAt: '2026-08-03T10:00:00Z', fileSize: 2_400_000,
    pageCount: 38, chunkCount: 96, contentTypes: ['text', 'table'], tags: ['Sonstiges'],
    summary: 'Entwurfsbeschreibung mit Nutzungskonzept, Wohnungsmix und Erschließung für 64 Wohneinheiten.',
  }),
  doc({
    id: 'd-02-02', filename: 'Massenermittlung_Entwurf_Stand_2026-08.xlsx', folderId: 'f-02',
    status: 'completed', contentType: XLSX, createdAt: '2026-08-05T16:40:00Z', fileSize: 412_000,
    chunkCount: 22, contentTypes: ['table'], tags: ['Sonstiges'],
    summary: 'Ermittlung der Wohnnutzfläche und Bruttogeschossfläche je Stiege und Geschoß.',
  }),
  doc({
    id: 'd-02-03', filename: 'Schnitt_A-A_Entwurf.pdf', folderId: 'f-02',
    status: 'completed', createdAt: '2026-08-05T16:55:00Z', fileSize: 1_100_000,
    pageCount: 1, chunkCount: 6, contentTypes: ['drawing', 'text'], tags: ['Schnitt', 'Energieeinsparung/Wärmeschutz'],
    summary: 'Gebäudeschnitt A-A mit Geschoßhöhen, Dämmebene und Anschluss an das Erdreich.',
  }),
  doc({
    id: 'd-02-04', filename: 'Ansicht_Nord_Entwurf.pdf', folderId: 'f-02',
    status: 'completed', createdAt: '2026-08-05T17:10:00Z', fileSize: 880_000,
    pageCount: 1, chunkCount: 5, contentTypes: ['drawing'], tags: ['Ansicht'],
    summary: 'Nordansicht mit Fensterachsen, Loggien und der Fassadengliederung über vier Geschoße.',
  }),
  doc({
    id: 'd-02-05', filename: 'Raumbuch_Entwurf_Stand_2026-07.pdf', folderId: 'f-02',
    status: 'processing', createdAt: '2026-07-28T12:00:00Z', fileSize: 1_600_000,
  }),
  doc({
    id: 'd-02-06', filename: 'Kurzbericht_Flächenvergleich_KI.pdf', folderId: 'f-02',
    status: 'stored', authoredBy: 'agent', createdAt: '2026-09-22T07:15:00Z', fileSize: 260_000,
    summary: 'Vergleich der Wohnflächen aus Entwurf und Massenermittlung, von Piloti als Bericht abgelegt.',
  }),

  // 03_Einreichung: the filing. Direct documents, then three subfolders.
  doc({
    id: 'd-03-01', filename: 'Einreichformular_BAU-1.pdf', folderId: 'f-03',
    status: 'completed', createdAt: '2026-09-08T09:00:00Z', fileSize: 540_000,
    pageCount: 5, chunkCount: 22, contentTypes: ['text', 'table'], tags: ['Sonstiges'],
    summary: 'Ausgefülltes Einreichformular mit Bauwerber, Planverfasser und Angaben zur Gebäudeklasse.',
  }),

  // 03_Einreichung/Pläne: two failures.
  doc({
    id: 'd-03-02', filename: 'EG_Grundriss_Index_C_2026-08-14.pdf', folderId: 'f-03-plaene',
    status: 'completed', createdAt: '2026-08-14T15:30:00Z', fileSize: 3_200_000,
    pageCount: 1, chunkCount: 12, contentTypes: ['drawing', 'text'], tags: ['Grundriss', 'Brandschutz'],
    summary: 'Grundriss Erdgeschoß Index C mit Fluchtwegen, Brandabschnitten und Stellplatzzufahrt.',
    topics: ['Fluchtweg', 'Brandabschnitt', 'Stellplatzzufahrt'],
  }),
  doc({
    id: 'd-03-03', filename: 'Regelgeschoss_Grundriss_Index_B.pdf', folderId: 'f-03-plaene',
    status: 'completed', createdAt: '2026-08-14T15:45:00Z', fileSize: 2_900_000,
    pageCount: 1, chunkCount: 11, contentTypes: ['drawing'], tags: ['Grundriss'],
    summary: 'Regelgeschoß mit acht Wohnungen, Erschließungskern und Wohnungstrennwänden.',
    topics: ['Wohnungstrennwand', 'Erschließungskern'],
  }),
  doc({
    id: 'd-03-04', filename: 'Schnitt_B-B_Index_B.pdf', folderId: 'f-03-plaene',
    status: 'completed', createdAt: '2026-08-14T16:00:00Z', fileSize: 1_400_000,
    pageCount: 1, chunkCount: 6, contentTypes: ['drawing'], tags: ['Schnitt'],
    summary: 'Gebäudeschnitt B-B durch das Stiegenhaus mit Lichtkuppel und Rauchabzug.',
    topics: ['Rauchabzug', 'Stiegenhaus'],
  }),
  doc({
    id: 'd-03-05', filename: 'Ansicht_Ost_Index_B.pdf', folderId: 'f-03-plaene',
    status: 'completed', createdAt: '2026-08-14T16:10:00Z', fileSize: 1_300_000,
    pageCount: 1, chunkCount: 5, contentTypes: ['drawing'], tags: ['Ansicht'],
    summary: 'Ostansicht mit Loggien, Fensterachsen und Anschlusshöhen zum Nachbargrundstück.',
  }),
  doc({
    id: 'd-03-06', filename: 'Brandschutzplan_EG-2OG_v2.pdf', folderId: 'f-03-plaene',
    status: 'failed', createdAt: '2026-08-20T10:05:00Z', fileSize: 4_800_000,
    errorMessage: 'Zeitüberschreitung beim Lesen auf Seite 2 von 3',
  }),
  doc({
    id: 'd-03-07', filename: 'Fluchtwegplan_EG-2OG.pdf', folderId: 'f-03-plaene',
    status: 'failed', createdAt: '2026-08-21T08:40:00Z', fileSize: 1_900_000,
    errorMessage: 'Datei ist beschädigt: Querverweistabelle fehlt',
  }),
  doc({
    id: 'd-03-08', filename: 'Stellplatzplan_UG_Index_A.pdf', folderId: 'f-03-plaene',
    status: 'completed', createdAt: '2026-07-30T13:25:00Z', fileSize: 980_000,
    pageCount: 1, chunkCount: 4, contentTypes: ['drawing'], tags: ['Grundriss'],
    summary: 'Tiefgaragenplan mit 38 Stellplätzen, Rampe und Brandabschnittsgrenzen.',
  }),

  // 03_Einreichung/alt: the earlier Fassungen an office keeps, named with their index.
  doc({
    id: 'd-03-alt-1', filename: 'EG_Grundriss_Index_B_2026-07-02.pdf', folderId: 'f-03-alt',
    status: 'completed', createdAt: '2026-07-02T09:10:00Z', fileSize: 3_050_000,
    pageCount: 1, chunkCount: 12, contentTypes: ['drawing', 'text'], tags: ['Grundriss', 'Brandschutz'],
    summary: 'Grundriss Erdgeschoß Index B mit Fluchtwegen und Brandabschnitten, noch ohne Stellplatzzufahrt.',
    topics: ['Fluchtweg', 'Brandabschnitt'],
  }),
  doc({
    id: 'd-03-alt-2', filename: 'Schnitt_B-B_Index_A.pdf', folderId: 'f-03-alt',
    status: 'completed', createdAt: '2026-06-18T11:30:00Z', fileSize: 1_350_000,
    pageCount: 1, chunkCount: 6, contentTypes: ['drawing'], tags: ['Schnitt'],
    summary: 'Gebäudeschnitt B-B durch das Stiegenhaus, Rauchabzug noch als Fenster.',
  }),

  // 03_Einreichung/Gutachten: one in flight.
  doc({
    id: 'd-03-09', filename: 'Brandschutzkonzept_v3.pdf', folderId: 'f-03-gutachten',
    status: 'completed', createdAt: '2026-09-02T11:00:00Z', fileSize: 9_700_000,
    pageCount: 84, chunkCount: 262, contentTypes: ['text', 'table', 'drawing'], tags: ['Gutachten', 'Brandschutz'],
    summary: 'Brandschutzkonzept für den Wohnbau Nord (GK 4) mit Fluchtweg-, Abschnitts- und Rauchfreihaltungsnachweis.',
    topics: ['Fluchtweg', 'Rauchabzug', 'Brandabschnitt'],
  }),
  doc({
    id: 'd-03-10', filename: 'Schallschutzgutachten_Seestadt.pdf', folderId: 'f-03-gutachten',
    status: 'completed', createdAt: '2026-08-28T14:20:00Z', fileSize: 3_300_000,
    pageCount: 27, chunkCount: 84, contentTypes: ['text', 'table', 'chart'], tags: ['Gutachten', 'Schallschutz'],
    summary: 'Trittschall- und Luftschallnachweis für Wohnungstrennwände und Außenbauteile.',
  }),
  doc({
    id: 'd-03-11', filename: 'Standsicherheitsnachweis_Statik_v1.pdf', folderId: 'f-03-gutachten',
    status: 'completed', createdAt: '2026-08-25T09:50:00Z', fileSize: 6_100_000,
    pageCount: 63, chunkCount: 190, contentTypes: ['text', 'table', 'drawing'], tags: ['Gutachten', 'Standsicherheit'],
    summary: 'Statischer Nachweis der Decken, Stiegen und Wandscheiben mit Lastannahmen nach ÖNORM EN 1991.',
  }),
  doc({
    id: 'd-03-12', filename: 'Energieausweis_Entwurf_HWB.pdf', folderId: 'f-03-gutachten',
    status: 'processing', createdAt: '2026-10-06T08:10:00Z', fileSize: 1_000_000,
  }),

  // 03_Einreichung/Bescheide: all three read.
  doc({
    id: 'd-03-13', filename: 'Baubescheid_MA37.pdf', folderId: 'f-03-bescheide',
    status: 'completed', createdAt: '2026-09-30T12:00:00Z', fileSize: 1_100_000,
    pageCount: 9, chunkCount: 31, contentTypes: ['text', 'table'], tags: ['Bescheid'],
    summary: 'Baubewilligung der MA 37 für den Neubau von 64 Wohnungen mit 14 Auflagen.',
  }),
  doc({
    id: 'd-03-14', filename: 'Auflagenbescheid_Brandschutz_MA68.pdf', folderId: 'f-03-bescheide',
    status: 'completed', createdAt: '2026-10-01T09:30:00Z', fileSize: 640_000,
    pageCount: 4, chunkCount: 15, contentTypes: ['text'], tags: ['Bescheid', 'Brandschutz'],
    summary: 'Auflagen der Feuerwehr zu Löschwasserversorgung, Feuerwehrzufahrt und Rauchabzug.',
  }),
  doc({
    id: 'd-03-15', filename: 'Baubewilligung_Nachtrag_2026-09.pdf', folderId: 'f-03-bescheide',
    status: 'completed', createdAt: '2026-09-16T10:45:00Z', fileSize: 420_000,
    pageCount: 3, chunkCount: 9, contentTypes: ['text'], tags: ['Bescheid'],
    summary: 'Nachtragsbewilligung für die Verlegung der Tiefgaragenrampe um 1,20 Meter.',
  }),

  // 04_Ausführung: direct documents.
  doc({
    id: 'd-04-01', filename: 'Bauzeitplan_KW38_2026.pdf', folderId: 'f-04',
    status: 'processing', createdAt: '2026-10-05T07:30:00Z', fileSize: 2_200_000,
  }),
  doc({
    id: 'd-04-02', filename: 'Ausführungsplan_Stiege_A.pdf', folderId: 'f-04',
    status: 'completed', createdAt: '2026-09-12T15:00:00Z', fileSize: 2_700_000,
    pageCount: 2, chunkCount: 10, contentTypes: ['drawing', 'text'], tags: ['Detail', 'Standsicherheit'],
    summary: 'Ausführungsplan der Stiege A mit Podesten, Wangen und Auflagerpunkten.',
  }),

  // 04_Ausführung/Details: two failures.
  doc({
    id: 'd-04-03', filename: 'Detail_Attika_Anschluss_D-07.pdf', folderId: 'f-04-details',
    status: 'failed', createdAt: '2026-09-20T13:10:00Z', fileSize: 880_000,
    errorMessage: 'Keine Textebene gefunden, und die Texterkennung lieferte kein Ergebnis',
  }),
  doc({
    id: 'd-04-04', filename: 'Detail_Fensteranschluss_D-12.pdf', folderId: 'f-04-details',
    status: 'failed', createdAt: '2026-09-20T13:12:00Z', fileSize: 760_000,
    errorMessage: 'Zeitüberschreitung beim Lesen auf Seite 1 von 2',
  }),
  doc({
    id: 'd-04-05', filename: 'Detail_Sockel_Abdichtung_D-03.pdf', folderId: 'f-04-details',
    status: 'completed', createdAt: '2026-09-11T10:20:00Z', fileSize: 1_900_000,
    pageCount: 1, chunkCount: 5, contentTypes: ['drawing', 'text'], tags: ['Detail', 'Energieeinsparung/Wärmeschutz'],
    summary: 'Sockeldetail mit Abdichtung, Perimeterdämmung und Anschluss an die Bodenplatte.',
  }),
  doc({
    id: 'd-04-06', filename: 'Detail_Wandaufbau_Tiefgarage.pdf', folderId: 'f-04-details',
    status: 'completed', createdAt: '2026-09-11T10:40:00Z', fileSize: 1_500_000,
    pageCount: 2, chunkCount: 8, contentTypes: ['drawing', 'text'], tags: ['Detail', 'Brandschutz'],
    summary: 'Wandaufbau der Tiefgaragenwand mit Brandwand-Anschluss und Oberflächenschutz.',
    topics: ['Brandwand', 'Tiefgarage'],
  }),

  // 04_Ausführung/Fotos Baustelle: read, but no document type. The unplaced five.
  doc({
    id: 'd-04-07', filename: 'IMG_4031.jpg', folderId: 'f-04-fotos', contentType: JPEG,
    status: 'completed', createdAt: '2026-08-27T07:50:00Z', fileSize: 3_400_000,
    chunkCount: 1, contentTypes: ['image'], tags: [],
    summary: 'Foto der Baustelle: Bewehrung der Bodenplatte im Bereich der Stiege A.',
    capture: { capturedAt: '2026-08-27T07:48:12', camera: 'Apple iPhone 15 Pro', latitude: 48.2262, longitude: 16.5066 },
  }),
  doc({
    id: 'd-04-08', filename: 'IMG_4044.jpg', folderId: 'f-04-fotos', contentType: JPEG,
    status: 'completed', createdAt: '2026-08-27T08:05:00Z', fileSize: 3_100_000,
    chunkCount: 1, contentTypes: ['image'], tags: [],
    summary: 'Foto der Baustelle: Schalung der Decke über dem 1. Obergeschoß.',
    capture: { capturedAt: '2026-08-27T08:03:40', camera: 'Apple iPhone 15 Pro', latitude: 48.2263, longitude: 16.5069 },
  }),
  doc({
    id: 'd-04-09', filename: 'IMG_4057.jpg', folderId: 'f-04-fotos', contentType: JPEG,
    status: 'completed', createdAt: '2026-09-03T09:15:00Z', fileSize: 3_600_000,
    chunkCount: 1, contentTypes: ['image'], tags: [],
    summary: 'Foto der Baustelle: Rohbau des Regelgeschoßes, Blick nach Osten.',
    capture: { capturedAt: '2026-09-03T09:12:05', camera: 'Apple iPhone 15 Pro' },
  }),
  doc({
    id: 'd-04-10', filename: 'IMG_4069.jpg', folderId: 'f-04-fotos', contentType: JPEG,
    status: 'completed', createdAt: '2026-09-03T09:20:00Z', fileSize: 3_200_000,
    chunkCount: 1, contentTypes: ['image'], tags: [],
    summary: 'Foto der Baustelle: Montage der Fenster im 2. Obergeschoß.',
  }),
  doc({
    id: 'd-04-11', filename: 'IMG_4083.jpg', folderId: 'f-04-fotos', contentType: JPEG,
    status: 'completed', createdAt: '2026-09-18T14:35:00Z', fileSize: 3_800_000,
    chunkCount: 1, contentTypes: ['image'], tags: [],
    summary: 'Foto der Baustelle: Abdichtung des Sockels an der Nordseite.',
  }),

  // 05_Korrespondenz: the held one, the pending one, and the letters.
  doc({
    id: 'd-05-01', filename: 'Honorarnote_2026-09.pdf', folderId: 'f-05',
    status: 'quarantined', createdAt: '2026-10-02T08:00:00Z', fileSize: 230_000,
    errorMessage: 'quarantined:{"reasons":[{"kind":"iban","count":1,"pages":[2]}],"checked":"full"}',
  }),
  doc({
    id: 'd-05-02', filename: 'Schreiben_Bauleitung_2026-10-02.pdf', folderId: 'f-05',
    status: 'pending', createdAt: '2026-10-02T11:30:00Z', fileSize: 310_000,
  }),
  doc({
    id: 'd-05-03', filename: 'E-Mail_Statik_Rückfrage_2026-09-18.pdf', folderId: 'f-05',
    status: 'completed', createdAt: '2026-09-18T16:05:00Z', fileSize: 180_000,
    pageCount: 2, chunkCount: 7, contentTypes: ['text'], tags: ['Sonstiges', 'Standsicherheit'],
    summary: 'Rückfrage des Tragwerksplaners zu Stützenlasten im Untergeschoß und Bitte um Freigabe.',
  }),
  doc({
    id: 'd-05-04', filename: 'Protokoll_Jour_fixe_2026-09-30.pdf', folderId: 'f-05',
    status: 'completed', createdAt: '2026-09-30T17:20:00Z', fileSize: 260_000,
    pageCount: 4, chunkCount: 16, contentTypes: ['text', 'table'], tags: ['Sonstiges'],
    summary: 'Protokoll des Jour fixe vom 30. September mit Terminen, offenen Punkten und Verantwortlichen.',
  }),
  doc({
    id: 'd-05-05', filename: 'Mängelrüge_Fassade_2026-08-27.pdf', folderId: 'f-05',
    status: 'completed', createdAt: '2026-08-27T12:40:00Z', fileSize: 610_000,
    pageCount: 3, chunkCount: 10, contentTypes: ['text'], tags: ['Vertrag'],
    summary: 'Mängelrüge an den Fassadenbauer wegen Abweichungen bei der Lüftungsöffnung im Sockelbereich.',
  }),
  doc({
    id: 'd-05-06', filename: 'Angebot_Fenster_Lieferant_v2.pdf', folderId: 'f-05',
    status: 'completed', createdAt: '2026-08-19T10:10:00Z', fileSize: 1_400_000,
    pageCount: 12, chunkCount: 38, contentTypes: ['text', 'table'], tags: ['Vertrag', 'Energieeinsparung/Wärmeschutz'],
    summary: 'Angebot für Holz-Alu-Fenster mit Uw-Werten, Lieferzeiten und Montageleistung.',
  }),
  doc({
    id: 'd-05-07', filename: 'Bauleitung_Wochenbericht_KW40.pdf', folderId: 'f-05',
    status: 'completed', createdAt: '2026-10-04T15:00:00Z', fileSize: 340_000,
    pageCount: 3, chunkCount: 9, contentTypes: ['text', 'table'], tags: ['Sonstiges'],
    summary: 'Wochenbericht der Bauleitung mit Baufortschritt, Witterung und Personaleinsatz.',
  }),
]
