/** Organisationsweites Archiv: der projektübergreifende Dokumentenspeicher (ADR-0024). */
export const archiv = {
  title: 'Archiv',
  subtitle: 'Gemeinsame Dokumente, die jedem Projekt Ihrer Organisation zur Verfügung stehen',
  backToApp: 'Zurück zu den Projekten',
  backToProject: 'Zurück zum Projekt',
  backToNamedProject: 'Zurück zu {name}',
  library: {
    searchPlaceholder: 'Archiv durchsuchen…',
    searchLabel: 'Archivdokumente durchsuchen',
    resetSearch: 'Suche zurücksetzen',
    categoriesLabel: 'Nach Kategorie filtern',
    allCategories: 'Alle',
    emptyTitle: 'Das Archiv ist leer',
    emptyDescription:
      'Hier abgelegte Dokumente werden zu Bürowissen und stehen jedem Projekt Ihrer Organisation zur Verfügung.',
    noMatchTitle: 'Keine passenden Dokumente',
    noMatchDescription: 'Kein Archivdokument entspricht Ihrer Suche oder der gewählten Kategorie.',
    clearFilters: 'Filter zurücksetzen',
    provenance: 'Aus „{source}“',
    semantic: {
      run: 'Suchen',
      reset: 'Alle Dokumente anzeigen',
      banner: 'Semantische Suche: {count} Treffer für „{query}“',
      searching: 'Archiv wird nach „{query}“ durchsucht …',
      noResults: 'Keine semantischen Treffer für „{query}“',
      failed: 'Die Suche konnte nicht ausgeführt werden',
      failedDescription:
        'Auf dem Weg zum Index ist etwas schiefgegangen. Das Archiv ist unverändert — versuchen Sie dieselbe Suche erneut oder kehren Sie zu allen Dokumenten zurück.',
      retry: 'Erneut versuchen',
      failedBanner: 'Semantische Suche nach „{query}“ konnte nicht ausgeführt werden',
      noResultsDescription:
        'Nichts im Archiv entsprach dem Sinn Ihrer Anfrage. Versuchen Sie eine andere Formulierung oder löschen Sie die Suche, um alle Dokumente zu durchsuchen.',
    },
    kind: {
      floorplan: 'Grundriss',
      section: 'Schnitt',
      siteplan: 'Lageplan',
      notice: 'Bescheid',
      photo: 'Foto',
      document: 'Dokument',
    },
  },
  toast: {
    // Sobald die asynchrone Verarbeitung abgeschlossen ist und das Dokument
    // organisationsweit zitierbar wird.
    ingestionComplete: '„{name}“ ist jetzt im Büroarchiv – zitierbar',
  },
  workspace: {
    dropToUpload: 'Dateien hier ablegen, um sie ins Archiv aufzunehmen',
    dropUnsupported: 'Einige Dateien haben einen nicht unterstützten Typ',
    uploadProblem: 'Upload-Problem',
    dismissError: 'Fehler ausblenden',
    loadError: 'Das Archiv konnte nicht geladen werden.',
    tryAgain: 'Erneut versuchen',
  },
  actions: {
    label: 'Dateiaktionen für „{name}“',
    reingest: 'Erneut einlesen',
    reingesting: 'Wird erneut gestartet …',
    reingestError: 'Die Verarbeitung konnte nicht erneut gestartet werden. Bitte versuchen Sie es erneut.',
    menuLabel: 'Dateiaktionen',
    download: 'Herunterladen',
    rename: 'Umbenennen…',
    delete: 'Löschen…',
  },
  rename: {
    title: 'Dokument umbenennen',
    description:
      'Ändert den Namen, der in Grid überall angezeigt wird — auch in Zitaten. Die Datei selbst und alles daraus Indexierte bleiben unverändert.',
    label: 'Name',
    hint: 'Die Dateiendung bleibt erhalten.',
    save: 'Umbenennen',
    saving: 'Wird gespeichert…',
    cancel: 'Abbrechen',
    restore: 'Ursprünglichen Namen wiederherstellen',
    success: 'Heißt jetzt „{name}“',
    restored: 'Wieder „{name}“',
    error: 'Das Dokument konnte nicht umbenannt werden',
    errors: {
      empty: 'Bitte einen Namen eingeben.',
      tooLong: 'Dieser Name ist zu lang.',
      invalidCharacters: 'Ein Name darf keine Schrägstriche oder Zeilenumbrüche enthalten.',
    },
  },
  delete: {
    action: 'Aus Archiv löschen',
    title: '„{name}“ löschen?',
    confirm:
      'Dadurch wird das Dokument für die gesamte Organisation entfernt. Dies kann nicht rückgängig gemacht werden.',
    confirmAction: 'Löschen',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    success: '„{name}“ wurde aus dem Archiv entfernt',
    error: 'Das Dokument konnte nicht gelöscht werden',
  },
}
