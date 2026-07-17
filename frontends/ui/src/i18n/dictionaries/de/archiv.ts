/** Organisationsweites Archiv: der projektübergreifende Dokumentenspeicher (ADR-0024). */
export const archiv = {
  title: 'Archiv',
  subtitle: 'Gemeinsame Dokumente, die jedem Projekt Ihrer Organisation zur Verfügung stehen',
  backToApp: 'Zurück zu den Projekten',
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
    provenance: 'Aus: {source}',
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
    confirm: 'Dadurch wird das Dokument für die gesamte Organisation entfernt. Dies kann nicht rückgängig gemacht werden.',
    confirmAction: 'Löschen',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    success: '„{name}“ wurde aus dem Archiv entfernt',
    error: 'Das Dokument konnte nicht gelöscht werden',
  },
}
