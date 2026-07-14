import type { en } from '../en'

/** files namespace — populated during component i18n. */
export const files: typeof en.files = {
  uploadZone: {
    clickToUpload: 'Zum Hochladen klicken',
    orDragAndDrop: ' oder per Drag-and-drop ablegen',
    maxSize: 'Bis zu {size} MB',
    accepts: 'Zulässig: {types}',
  },
  activeUploads: {
    heading: 'Uploads',
    uploadFailed: 'Upload fehlgeschlagen',
  },
  status: {
    ready: 'Bereit',
    processing: 'Wird verarbeitet',
    uploading: 'Wird hochgeladen',
    failed: 'Fehlgeschlagen',
    unknown: 'Unbekannt',
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
    type: 'Typ',
    size: 'Größe',
    summary: 'Zusammenfassung',
    pages: 'Seiten',
    chunks: 'Passagen',
    contents: 'Inhalte',
    contentTypeNames: {
      text: 'Text',
      table: 'Tabellen',
      chart: 'Diagramme',
      image: 'Bilder',
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
      'Fügen Sie die Pläne, Genehmigungen und Berichte Ihres Gebäudes hinzu. Grid liest sie, um jede Antwort in den eigenen Dokumenten Ihres Projekts zu verankern – nicht in allgemeinen Hinweisen.',
    searchPlaceholder: 'Dateien durchsuchen …',
    searchLabel: 'Dateien durchsuchen',
    noMatch: 'Keine Dateien entsprechen „{query}“',
    noMatchDescription:
      'Versuchen Sie einen anderen Namen oder löschen Sie die Suche, um alle Dateien zu sehen.',
    clearSearch: 'Suche zurücksetzen',
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
    corpusSubtitle: 'Projektkorpus – diese Dokumente untermauern Grids Antworten',
    uploadDocuments: 'Dokumente hochladen',
    uploadProblem: 'Upload-Problem',
    dismissError: 'Fehler ausblenden',
    createFolderError: 'Ordner konnte nicht erstellt werden. Bitte versuchen Sie es erneut.',
    foldersLoadError: 'Ordner konnten nicht geladen werden.',
    documentsLoadError: 'Dokumente konnten nicht geladen werden.',
    tryAgain: 'Erneut versuchen',
    dropToUpload: 'Dateien hier ablegen, um sie in dieses Projekt hochzuladen',
    dropUnsupported: 'Einige Dateien haben einen nicht unterstützten Typ',
  },
  upload: {
    uploading: 'Wird hochgeladen …',
    upload: 'Hochladen',
  },
  errors: {
    uploadingSkipped:
      'Es werden {uploading} {fileLabel} hochgeladen, {skipped} übersprungen ({summary})',
    cannotRetryServerFile:
      'Vom Server geladene Dateien können nicht erneut versucht werden. Bitte laden Sie die Datei erneut hoch.',
    fileSingular: 'Datei',
    filePlural: 'Dateien',
  },
}
