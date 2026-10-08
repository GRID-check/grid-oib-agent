/** Organisationsweites Archiv: der projektübergreifende Dokumentenspeicher (ADR-0024). */
export const archiv = {
  title: 'Archiv',
  subtitle: 'Gemeinsame Dokumente, die jedem Projekt Ihrer Organisation zur Verfügung stehen',
  backToApp: 'Zurück zu den Projekten',
  backToProject: 'Zurück zum Projekt',
  backToNamedProject: 'Zurück zu {name}',
  // What only the Büroarchiv card says: the gold kind chip and where it came from.
  library: {
    provenance: 'Aus „{source}“',
    kind: {
      floorplan: 'Grundriss',
      section: 'Schnitt / Ansicht',
      siteplan: 'Lageplan',
      notice: 'Bescheid',
      photo: 'Foto',
      // `model` fehlte, obwohl `inferDocumentKind` es für jede `.ifc` liefert —
      // die Karte zeigte den rohen Schlüssel. Ein Gebäude ist kein Dokument,
      // und die Bezeichnung sagt das.
      model: 'Gebäudemodell',
      sheet: 'Tabelle',
      text: 'Notiz',
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
  },
  actions: {
    label: 'Dateiaktionen für „{name}“',
    reingest: 'Erneut lesen',
    reingesting: 'Wird erneut gestartet …',
    reingestError: 'Das erneute Lesen konnte nicht gestartet werden. Bitte versuchen Sie es noch einmal.',
    reingestRunning: 'Wird bereits gelesen',
    reingestAlreadyDone: 'Ist bereits fertig',
    reingestConfirmTitle: '„{name}“ erneut lesen?',
    reingestConfirmDescription:
      'Piloti liest die Datei noch einmal vollständig, zum Beispiel damit Bilder in Word- und PowerPoint-Dateien erfasst werden. Bis die neue Fassung fertig ist, stützen sich Antworten weiter auf die bisherige.',
    reingestConfirmAction: 'Erneut lesen',
    menuLabel: 'Dateiaktionen',
    download: 'Herunterladen',
    open: 'Öffnen',
    ask: 'Danach fragen',
    copyOriginPath: 'Herkunftspfad kopieren',
    moved: '„{name}“ nach {folder} verschoben',
    moveError: 'Das Dokument konnte nicht verschoben werden. Bitte versuchen Sie es erneut.',
    move: 'In Ordner verschieben',
    rename: 'Umbenennen…',
    delete: 'Löschen…',
  },
  rename: {
    title: 'Dokument umbenennen',
    description:
      'Ändert den Namen, der in Piloti überall angezeigt wird — auch in Zitaten. Die Datei selbst und alles daraus Gelesene bleiben unverändert.',
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
    legalHold: 'Das Dokument unterliegt einer rechtlichen Sperre und kann nicht gelöscht werden',
  },
}
