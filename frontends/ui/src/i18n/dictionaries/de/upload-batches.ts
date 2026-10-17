import type { en } from '../en'

/**
 * Was ein Upload gebracht hat, und alle Uploads eines Projekts (ADR-0086).
 *
 * Die Statuswörter („Zitierbar", „Wird gelesen", „Zurückgehalten",
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
      doneHeld: 'Alles bis auf die zurückgehaltenen Dateien ist gelesen. Piloti zeigt sie keinem Modell.',
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
      // Von der Namensprüfung gestoppt: im Browser (die Datei verließ den
      // Rechner nie), beim Server oder im E-Mail-Import (gespeichert wurde nichts).
      description:
        'Die Namensprüfung hat diese Dateien nicht hochgeladen, gespeichert wurde nichts davon. Ihr Büro stuft diese Begriffe in Datei- und Ordnernamen als sensibel ein.',
      listLabel: 'Nicht hochgeladene Dateien nach Begriff',
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
      openInFiles: 'In Dateien öffnen',
      openInArchiv: 'In der Büroablage öffnen',
      changedHint: 'Neue Fassung eines Dokuments, das schon hier lag. Die bisherige bleibt unter „Fassungen und Freigabe“ lesbar.',
      protectedHint: 'Liegt in einem Ordner mit eigenem Zugriff. Wer ihn öffnen und ändern darf, zeigt das Schloss am Ordner.',
      requestRelease: 'Prüfung anfragen',
      releaseRequested: 'Prüfung angefragt',
      releaseRequestedToast: 'Die Personen, die „{name}“ prüfen und zulassen dürfen, sind benachrichtigt.',
      releaseRequestNobody: 'Außer Ihnen darf niemand „{name}“ prüfen. Sie finden die Datei unter Organisation → Quarantäne.',
      releaseRequestError: 'Die Anfrage konnte nicht gesendet werden. Bitte versuchen Sie es erneut.',
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
