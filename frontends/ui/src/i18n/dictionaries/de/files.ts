import type { en } from '../en'

/** files namespace — populated during component i18n. */
export const files: typeof en.files = {
  uploadZone: {
    clickToUpload: 'Zum Hochladen klicken',
    orDragAndDrop: ' oder per Drag-and-drop ablegen',
    maxSize: 'Bis zu {size} MB',
    accepts: 'Zulässig: {types}',
    dragOrBrowse: 'Dateien hierher ziehen oder auswählen',
    maxSizeShort: 'max. {size} MB',
  },
  // Die Upload-Leiste. Die Formulierungen folgen der Regel der Oberfläche:
  // Eine Zahl steht nur dort, wo tatsächlich gemessen wurde. „Wird gelesen“
  // beschreibt, was das Backend mit einem Dokument tut – dafür gibt es keine
  // Restzeit, also sagt der Text das, statt eine zu suggerieren.
  uploads: {
    region: 'Uploads',
    heading: {
      transferringOne: '1 Dokument wird hochgeladen',
      transferringOther: '{count} Dokumente werden hochgeladen',
      processingOne: 'Piloti liest 1 Dokument',
      processingOther: 'Piloti liest {count} Dokumente',
      doneOne: '1 Dokument hinzugefügt',
      doneOther: '{count} Dokumente hinzugefügt',
      mixed: '{ready} hinzugefügt · {failed} fehlgeschlagen',
      failedOne: '1 Dokument konnte nicht hinzugefügt werden',
      failedOther: '{count} Dokumente konnten nicht hinzugefügt werden',
      canceled: 'Upload abgebrochen',
    },
    detail: {
      bytes: '{done} von {total}',
      eta: 'noch {time}',
      queued: '{count} in Warteschlange',
      processing: 'Wird indexiert – keine Restzeit, Sie können weiterarbeiten',
      elapsed: 'seit {time}',
      settled: '{total} übertragen',
    },
    row: {
      queued: 'Wartet',
      uploading: 'Wird gesendet',
      processing: 'Wird gelesen',
      ready: 'Zitierbar',
      canceled: 'Abgebrochen',
      failed: 'Fehlgeschlagen',
    },
    actions: {
      expand: 'Dateien anzeigen',
      collapse: 'Dateien ausblenden',
      cancelAll: 'Alle abbrechen',
      cancel: 'Upload von {name} abbrechen',
      retryAll: 'Fehlgeschlagene wiederholen',
      dismiss: '{name} ausblenden',
      dismissAll: 'Ausblenden',
    },
  },
  status: {
    // "Zitierbar" (nicht bloß "Bereit") beantwortet die entscheidende Frage:
    // Das Dokument ist jetzt in Pilotis Wissen und kann zitiert werden.
    ready: 'Zitierbar',
    processing: 'Wird verarbeitet',
    uploading: 'Wird hochgeladen',
    failed: 'Fehlgeschlagen',
    unknown: 'Unbekannt',
  },
  toast: {
    // Sobald die asynchrone Verarbeitung abgeschlossen ist und das Dokument
    // zitierbar wird – die bislang fehlende Bestätigung des Abschlusses.
    ingestionComplete: '„{name}“ ist jetzt in Pilotis Wissen – zitierbar',
    modelReady: '„{name}“ ist eingelesen – Sie können jetzt Fragen zum Gebäude stellen',
  },
  // Karten-Thumbnail-Fallbacks: ein warmer Platzhalter-Chip, wenn kein Thumbnail
  // existiert, und ein ehrliches „konnte nicht geladen werden“ bei einem echten
  // Fehler (nie ein Bild-kaputt-Look). `image` ist der generische Chip ohne
  // Dateiendung.
  thumbnail: {
    image: 'Bild',
    unavailable: 'Vorschau nicht verfügbar',
  },
  preview: {
    closePreview: 'Vorschau schließen',
    expandPreview: 'Große Vorschau öffnen',
    loadFailed:
      'Die Vorschau konnte nicht geladen werden. Sie können die Datei unten trotzdem herunterladen.',
    tryAgain: 'Erneut versuchen',
    noInlinePreview:
      'Für diesen Dateityp gibt es keine Inline-Vorschau. Laden Sie sie herunter, um das vollständige Dokument anzusehen.',
    status: 'Status',
    properties: 'Eigenschaften',
    summaryMore: 'Vollständige Zusammenfassung',
    summaryLess: 'Weniger anzeigen',
    type: 'Typ',
    size: 'Größe',
    tags: 'Schlagwörter',
    noTags: 'Keine Schlagwörter',
    tagsSaveError: 'Schlagwörter konnten nicht gespeichert werden. Bitte erneut versuchen.',
    addTagPlaceholder: 'Schlagwort hinzufügen',
    addTagLabel: 'Schlagwort hinzufügen',
    removeTag: 'Schlagwort {tag} entfernen',
    suggestionsLabel: 'Schlagwort-Vorschläge',
    noTagMatch: 'Kein passendes Schlagwort – bitte einen der Vorschläge wählen.',
    indexed: {
      title: 'Von Piloti indexiert',
      documentType: 'Dokumenttyp',
      project: 'Projekt',
      updated: 'Aktualisiert',
      caption:
        'Beim Hochladen automatisch erkannt – Ihre Korrekturen verbessern künftige Antworten.',
    },
    pages: 'Seiten',
    chunks: 'Passagen',
    contents: 'Inhalte',
    contentTypeNames: {
      text: 'Text',
      table: 'Tabellen',
      chart: 'Diagramme',
      image: 'Bilder',
      drawing: 'Zeichnungen',
    },
    visualDetails: {
      title: 'Detaillierte Informationen',
      loading: 'Beschreibungen werden geladen …',
      empty: 'Keine visuellen Beschreibungen verfügbar.',
      page: 'Seite {page}',
      scale: 'Maßstab {scale}',
    },
    unknownType: 'Unbekannt',
    download: 'Herunterladen',
    downloadFailed: 'Der Download konnte nicht gestartet werden. Bitte versuchen Sie es erneut.',
    ingestionFailed: 'Verarbeitung fehlgeschlagen',
    ingestionFailedGeneric: 'Dieses Dokument konnte nicht für die Suche verarbeitet werden.',
    retryIngestion: 'Verarbeitung erneut starten',
    retryingIngestion: 'Wird erneut gestartet …',
    retryIngestionError:
      'Die Verarbeitung konnte nicht erneut gestartet werden. Bitte versuchen Sie es erneut.',
    dialogLabel: 'Dateivorschau: {name}',
  },
  browser: {
    folderEmptyTitle: 'Dieser Ordner ist leer',
    folderEmptyDescription:
      'Laden Sie hier Dokumente hoch oder wählen Sie einen anderen Ordner in der Seitenleiste.',
    noDocumentsTitle: 'Noch keine Dokumente',
    noDocumentsDescription:
      'Fügen Sie die Pläne, Genehmigungen und Berichte Ihres Gebäudes hinzu. Piloti liest sie, um jede Antwort in den eigenen Dokumenten Ihres Projekts zu verankern – nicht in allgemeinen Hinweisen.',
    searchPlaceholder: 'Dateien durchsuchen …',
    searchLabel: 'Dateien durchsuchen',
    noMatch: 'Keine Dateien entsprechen „{query}“',
    noMatchDescription:
      'Versuchen Sie einen anderen Namen, ein Schlagwort oder eine Beschreibung – oder löschen Sie die Suche, um alle Dateien zu sehen.',
    clearSearch: 'Suche löschen',
    resetSearch: 'Suche zurücksetzen',
    recentlyUploaded: 'Zuletzt hochgeladen',
    semantic: {
      searchPlaceholder: 'Dateien durchsuchen – Enter für semantische Suche …',
      run: 'Suchen',
      reset: 'Alle Dateien anzeigen',
      banner: 'Semantische Suche: {count} Treffer für „{query}“',
      searching: 'Korpus wird nach „{query}“ durchsucht …',
      noResults: 'Keine semantischen Treffer für „{query}“',
      noResultsDescription:
        'Nichts in diesem Projekt entsprach dem Sinn Ihrer Anfrage. Versuchen Sie eine andere Formulierung oder löschen Sie die Suche, um alle Dateien zu durchsuchen.',
      page: 'Seite {page}',
      relevance: '{percent}% Relevanz',
    },
  },
  folders: {
    heading: 'Ordner',
    namePlaceholder: 'Ordnername',
    newFolderName: 'Name des neuen Ordners',
    creating: 'Ordner wird erstellt …',
    addSubfolderIn: 'Unterordner in {name} hinzufügen',
    addSubfolder: 'Unterordner hinzufügen',
    allFiles: 'Alle Dateien',
    newFolder: 'Neuer Ordner',
  },
  workspace: {
    corpusSubtitle: 'Projektkorpus – diese Dokumente untermauern Pilotis Antworten',
    uploadDocuments: 'Dokumente hochladen',
    uploadProblem: 'Upload-Problem',
    dismissError: 'Fehler ausblenden',
    createFolderError: 'Ordner konnte nicht erstellt werden. Bitte versuchen Sie es erneut.',
    foldersLoadError: 'Ordner konnten nicht geladen werden.',
    documentsLoadError: 'Dokumente konnten nicht geladen werden.',
    tryAgain: 'Erneut versuchen',
    dropToUpload: 'Dateien hier ablegen, um sie in dieses Projekt hochzuladen',
    dropUnsupported: 'Einige Dateien haben einen nicht unterstützten Typ',
    view: {
      label: 'Ansicht',
      cards: 'Kacheln',
      list: 'Liste',
      tree: 'Ordner',
    },
  },
  // Detailansicht des Explorers – Spaltenüberschriften der sortierbaren Liste.
  list: {
    columns: {
      name: 'Name',
      status: 'Status',
      pages: 'Seiten',
      size: 'Größe',
      added: 'Hinzugefügt',
    },
  },
  delete: {
    action: 'Dokument löschen',
    confirm: 'Dadurch wird das Dokument aus diesem Projekt entfernt. Dies kann nicht rückgängig gemacht werden.',
    confirmAction: 'Löschen',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    success: '„{name}“ wurde aus dem Projekt entfernt',
    error: 'Das Dokument konnte nicht gelöscht werden',
  },
  upload: {
    uploading: 'Wird hochgeladen …',
    upload: 'Hochladen',
  },
  errors: {
    someUploadsFailed:
      '{failed} von {total} Dokumenten konnten nicht hochgeladen werden. Erster Grund: {reason}',
    uploadingSkipped:
      'Es werden {uploading} {fileLabel} hochgeladen, {skipped} übersprungen ({summary})',
    cannotRetryServerFile:
      'Vom Server geladene Dateien können nicht erneut versucht werden. Bitte laden Sie die Datei erneut hoch.',
    imageVlmUnavailable:
      'Das Hochladen von Bildern erfordert ein konfiguriertes Vision-Modell (VLM) in dieser Umgebung.',
    fileSingular: 'Datei',
    filePlural: 'Dateien',
  },
}
