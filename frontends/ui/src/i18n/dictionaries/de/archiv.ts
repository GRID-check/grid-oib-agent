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
      searchPlaceholder: 'Archiv durchsuchen – Enter für semantische Suche …',
      run: 'Suchen',
      reset: 'Alle Dokumente anzeigen',
      banner: 'Semantische Suche: {count} Treffer für „{query}“',
      searching: 'Archiv wird nach „{query}“ durchsucht …',
      noResults: 'Keine semantischen Treffer für „{query}“',
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
  delete: {
    action: 'Aus Archiv löschen',
    confirm:
      'Dadurch wird das Dokument für die gesamte Organisation entfernt. Dies kann nicht rückgängig gemacht werden.',
    confirmAction: 'Löschen',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    success: '„{name}“ wurde aus dem Archiv entfernt',
    error: 'Das Dokument konnte nicht gelöscht werden',
  },
}
