import type { en } from '../en'

/** Wissensbasis-Transparenzseite: was das RAG aktuell kennt. */
export const knowledge: typeof en.knowledge = {
  title: 'Wissensbasis',
  subtitle:
    'Alle Dokumente, auf die sich der Assistent stützen kann — die gemeinsamen OIB-Richtlinien plus die in diesem Projekt hochgeladenen Dateien. Nichts anderes wird verwendet.',
  summary: {
    documents: 'Dokumente',
    indexed: 'Indexiert',
    chunks: 'Durchsuchbare Abschnitte',
    attention: 'Benötigt Aufmerksamkeit',
    lastUpdated: 'Index zuletzt aktualisiert am {date}',
  },
  corpus: {
    title: 'Gemeinsame OIB-Richtlinien',
    description:
      'Die österreichischen OIB-Richtlinien, die alle Projekte teilen. Als „Indexiert“ markierte Dokumente sind für den Assistenten vollständig durchsuchbar.',
    empty: 'Keine Richtlinien-Dokumente gefunden. Die erste Verarbeitung läuft möglicherweise noch.',
    notSynced: 'Die Wissensbasis wurde noch nicht aufgebaut. Dokumente erscheinen hier, sobald die erste Verarbeitung abgeschlossen ist.',
    columns: {
      document: 'Dokument',
      status: 'Status',
      chunks: 'Abschnitte',
      size: 'Größe',
      ingestedAt: 'Indexiert am',
    },
    chunkCount: '{count, plural, one {# Abschnitt} other {# Abschnitte}}',
    checksum: 'SHA-256-Prüfsumme: {hash}',
  },
  project: {
    title: 'Projektdokumente',
    description:
      'In diesem Projekt hochgeladene Dateien. Nach der Verarbeitung sind sie in den Chats dieses Projekts zusätzlich zu den gemeinsamen Richtlinien durchsuchbar.',
    empty: 'Noch keine Projektdokumente. Unter „Dateien“ hochgeladene Dateien werden Teil des Wissens des Assistenten.',
    goToFiles: 'Dateien verwalten',
  },
  states: {
    ingested: 'Indexiert',
    stale: 'Veraltet',
    pending: 'Noch nicht indexiert',
    snapshot: 'Indexiert (ohne Original)',
    removed: 'Quelle entfernt',
    inconsistent: 'Index fehlt',
  },
  stateHints: {
    ingested: 'Für den Assistenten vollständig durchsuchbar.',
    stale: 'Die Datei wurde seit der Indexierung geändert; Antworten spiegeln bis zur nächsten Synchronisierung die vorherige Version wider.',
    pending: 'Hochgeladen, aber noch nicht verarbeitet — der Assistent kann sie erst nach der nächsten Synchronisierung verwenden.',
    snapshot: 'Aus einem vorbereiteten Bestand übernommen; vollständig durchsuchbar, aber die Quell-PDF liegt nicht auf diesem Server.',
    removed: 'Die Quelldatei wurde entfernt; indexierte Inhalte können bis zur Bereinigung weiterhin auffindbar sein.',
    inconsistent: 'Als verarbeitet vermerkt, aber es wurden keine durchsuchbaren Inhalte gefunden. Synchronisierung erneut ausführen.',
  },
  origin: {
    uploaded: 'Hochgeladen',
  },
  viewer: {
    view: 'PDF ansehen',
    description: 'Originales Quelldokument.',
    openInTab: 'In neuem Tab öffnen',
    loading: 'Dokument wird geladen…',
    pageCount: '{count, plural, one {# Seite} other {# Seiten}}',
    pagePosition: 'Seite {page} von {count}',
    toPassage: 'Zur Fundstelle',
    passageNotFound: 'Fundstelle im Dokument nicht gefunden',
    copyQuote: 'Als Zitat kopieren',
    quoteCopied: 'Zitat kopiert',
    copyFailed: 'Kopieren nicht möglich',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    highlightUnavailable:
      'Die Fundstelle kann in diesem Browser nicht markiert werden — das Dokument wird ohne Hervorhebung angezeigt.',
  },
  // Der RIS-Leser: eine Rechtsquelle wird IN Piloti gelesen statt im Browser-Tab.
  risViewer: {
    // „Lesefassung", nicht „Originaldokument": maßgeblich bleibt die
    // Veröffentlichung im RIS, und der Link daneben führt dorthin.
    description: 'Lesefassung aus dem RIS.',
    openAtRis: 'Im RIS öffnen',
    loading: 'Rechtsquelle wird geladen…',
    failed:
      'Diese Rechtsquelle lässt sich gerade nicht in Piloti anzeigen. Über „Im RIS öffnen" erreichen Sie das Dokument weiterhin.',
    busy: 'Zu viele Anfragen kurz hintereinander. Bitte einen Moment warten und die Quelle erneut öffnen.',
    truncated: 'Gekürzt — der vollständige Text steht im RIS.',
  },
  error: {
    title: 'Wissensbasis nicht verfügbar',
    description: 'Der Wissensstatus konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
  },
  loading: 'Wissensbasis wird geladen…',
}
