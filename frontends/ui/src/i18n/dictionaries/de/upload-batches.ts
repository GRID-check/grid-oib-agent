import type { en } from '../en'

/**
 * Was ein Upload gebracht hat, und alle Uploads eines Projekts (ADR-0085).
 *
 * Die Statuswörter („Zitierbar", „Wird gelesen", „In Quarantäne",
 * „Fehlgeschlagen", „Abgelegt") stehen NICHT hier: Die Übersicht liest sie aus
 * `files.status.*`, damit eine Zahl und das Badge daneben einen Zustand nicht
 * zweimal verschieden benennen.
 */
export const uploadBatches: typeof en.uploadBatches = {
  summary: {
    title: 'Was angekommen ist',
    loading: 'Übersicht wird geladen…',
    // Wohin der Upload ging, wenn sich der Projektname nicht lesen lässt.
    place: {
      project: 'Projekt',
      archiv: 'Büroablage',
      session: 'Chat',
    },
    open: {
      project: 'Dateien öffnen',
      archiv: 'Büroablage öffnen',
      session: 'Chat öffnen',
    },
    state: {
      sending: 'Der Upload läuft noch.',
      reading: 'Piloti liest noch. Diese Übersicht aktualisiert sich von selbst.',
      done: 'Alles ist gelesen.',
    },
    counts: {
      label: 'Auf einen Blick',
      unchanged: 'Unverändert',
      excluded: 'Nicht hochgeladen',
      changed: 'Geändert',
      protected: 'Geschützt',
    },
    uploadFailed:
      '{count, plural, one {# Datei kam nicht an. Laden Sie sie erneut hoch.} other {# Dateien kamen nicht an. Laden Sie sie erneut hoch.}}',
    types: {
      title: 'Dokumenttypen',
    },
    excluded: {
      title: 'Nicht hochgeladen',
      description:
        'Diese Dateien haben Ihren Rechner nie verlassen. Ihr Büro stuft diese Begriffe in Datei- und Ordnernamen als sensibel ein.',
      listLabel: 'Zurückgehaltene Dateien nach Begriff',
    },
    files: {
      title: 'Dateien',
      root: {
        project: 'Projektordner',
        archiv: 'Büroablage',
        session: 'Chat',
      },
      empty: 'Keine Datei dieses Uploads ist bei Piloti angekommen.',
      pages: '{count, plural, one {# Seite} other {# Seiten}}',
      reasonsLabel: 'Warum sie zurückgehalten wird',
      openInFiles: 'In Dateien öffnen',
      openInArchiv: 'In der Büroablage öffnen',
      changedHint: 'Neue Fassung eines Dokuments, das schon hier lag. Die bisherige bleibt unter Versionen erhalten.',
      protectedHint: 'Liegt in einem Ordner mit eigenem Zugriff. Wer ihn öffnen und ändern darf, zeigt das Schloss am Ordner.',
    },
    notFound: {
      title: 'Übersicht nicht gefunden',
      description: 'Diese Übersicht gibt es nicht mehr oder sie gehört jemand anderem.',
    },
    error: {
      title: 'Die Übersicht konnte nicht geladen werden',
      description: 'Prüfen Sie die Verbindung und versuchen Sie es erneut.',
    },
  },
  history: {
    title: 'Uploads',
    description:
      'Wer wann wie viele Dateien hochgeladen hat. Die Übersicht Datei für Datei sieht jede Person nur für ihre eigenen Uploads.',
    you: 'Sie',
    files: '{count, plural, one {# Datei} other {# Dateien}}',
    open: 'Übersicht',
    openLabel: 'Übersicht Ihres Uploads vom {date} öffnen',
    countsLabel: 'Ergebnis',
    empty: {
      title: 'Noch keine Uploads',
      description: 'Uploads in dieses Projekt erscheinen hier, mit dem, was aus jeder Datei geworden ist.',
    },
    error: 'Der Verlauf der Uploads konnte nicht geladen werden.',
    more: 'Ältere Uploads laden',
    moreError: 'Die älteren Uploads konnten nicht geladen werden. Versuchen Sie es erneut.',
  },
}
