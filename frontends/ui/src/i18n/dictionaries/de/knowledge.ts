import type { en } from '../en'

/** Wissensbasis-Transparenzseite: was das RAG aktuell kennt. */
export const knowledge: typeof en.knowledge = {
  title: 'Wissensbasis',
  subtitle:
    'Alle Dokumente, auf die sich der Assistent stützen kann — der gemeinsame OIB-Richtlinien-Korpus plus die in diesem Projekt hochgeladenen Dateien. Nichts anderes wird verwendet.',
  summary: {
    documents: 'Dokumente',
    indexed: 'Indexiert',
    chunks: 'Durchsuchbare Abschnitte',
    attention: 'Benötigt Aufmerksamkeit',
    lastUpdated: 'Index zuletzt aktualisiert am {date}',
  },
  corpus: {
    title: 'OIB-Richtlinien-Korpus',
    description:
      'Die österreichischen OIB-Richtlinien, die alle Projekte teilen. Als „Indexiert“ markierte Dokumente sind für den Assistenten vollständig durchsuchbar.',
    empty: 'Keine Korpus-Dokumente gefunden. Die erste Ingestion läuft möglicherweise noch.',
    notSynced: 'Der Wissensindex wurde noch nicht aufgebaut. Dokumente erscheinen hier, sobald die erste Ingestion abgeschlossen ist.',
    columns: {
      document: 'Dokument',
      status: 'Status',
      chunks: 'Abschnitte',
      size: 'Größe',
      ingestedAt: 'Indexiert am',
    },
    chunkCount: '{count} Abschnitte',
    checksum: 'SHA-256-Prüfsumme: {hash}',
  },
  project: {
    title: 'Projektdokumente',
    description:
      'In diesem Projekt hochgeladene Dateien. Nach der Verarbeitung sind sie in den Chats dieses Projekts zusätzlich zum gemeinsamen Korpus durchsuchbar.',
    empty: 'Noch keine Projektdokumente. Unter „Dateien“ hochgeladene Dateien werden Teil des Wissens des Assistenten.',
    goToFiles: 'Dateien verwalten',
  },
  states: {
    ingested: 'Indexiert',
    stale: 'Veraltet',
    pending: 'Noch nicht indexiert',
    snapshot: 'Indexiert (Snapshot)',
    removed: 'Quelle entfernt',
    inconsistent: 'Index fehlt',
  },
  stateHints: {
    ingested: 'Für den Assistenten vollständig durchsuchbar.',
    stale: 'Die Datei wurde seit der Indexierung geändert; Antworten spiegeln bis zur nächsten Synchronisierung die vorherige Version wider.',
    pending: 'Auf der Festplatte vorhanden, aber noch nicht ingestiert — der Assistent kann sie erst nach der nächsten Synchronisierung verwenden.',
    snapshot: 'Aus einem vorgefertigten Index wiederhergestellt; vollständig durchsuchbar, aber die Quell-PDF liegt nicht auf diesem Server.',
    removed: 'Die Quelldatei wurde entfernt; indexierte Inhalte können bis zur Bereinigung weiterhin auffindbar sein.',
    inconsistent: 'Als ingestiert vermerkt, aber es wurden keine indexierten Inhalte gefunden. Synchronisierung erneut ausführen.',
  },
  origin: {
    uploaded: 'Hochgeladen',
  },
  viewer: {
    view: 'PDF ansehen',
    description: 'Originales Quelldokument.',
    openInTab: 'In neuem Tab öffnen',
    loading: 'Dokument wird geladen…',
    pageCount: '{count} Seiten',
    toPassage: 'Zur Fundstelle',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    highlightUnavailable:
      'Die Fundstelle kann in diesem Browser nicht markiert werden — das Dokument wird ohne Hervorhebung angezeigt.',
  },
  error: {
    title: 'Wissensbasis nicht verfügbar',
    description: 'Der Wissensstatus konnte nicht vom Backend geladen werden.',
    retry: 'Erneut versuchen',
  },
  loading: 'Wissensbasis wird geladen…',
}
