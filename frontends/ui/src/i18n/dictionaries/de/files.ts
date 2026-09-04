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
    // Der Bericht, den Piloti geschrieben hat: die Datei liegt im Projekt, ist
    // aber bewusst nicht in der Wissensbasis. „Abgelegt“ sagt genau das – kein
    // Erfolg („Zitierbar“ wäre ein Versprechen, das die Suche nicht einlöst)
    // und kein Fehler. Dasselbe Wort wie im Toast nach dem Lauf.
    stored: 'Abgelegt',
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
    gone: 'Dieses Dokument ist nicht mehr verfügbar. Es wurde möglicherweise gelöscht, oder Sie haben keinen Zugriff mehr darauf.',
    goneAction: 'Nicht mehr danach fragen',
    goneCleared: 'Frage bezieht sich nicht mehr auf diese Datei.',
    goneUndo: 'Rückgängig',
    tryAgain: 'Erneut versuchen',
    noInlinePreview:
      'Für diesen Dateityp gibt es keine Inline-Vorschau. Laden Sie sie herunter, um das vollständige Dokument anzusehen.',
    textTruncated:
      'Es wird nur der Anfang dieser Datei angezeigt. Laden Sie sie herunter, um den vollständigen Inhalt zu lesen.',
    status: 'Status',
    properties: 'Eigenschaften',
    summaryMore: 'Vollständige Zusammenfassung',
    summaryLess: 'Weniger anzeigen',
    type: 'Typ',
    size: 'Größe',
    originPath: 'Herkunft',
    originPathCopied: 'Pfad kopiert',
    originPathCopyFailed: 'Pfad konnte nicht kopiert werden',
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
      structured: {
        toggle: 'Strukturierte Daten',
        composition: 'Bauteilaufbau {component}',
        states: 'Bestand / Neu',
        relations: 'Beziehungen',
        annotations: 'Beschriftungen',
        project: 'Projekt',
        credits: 'Angaben',
        slogans: 'Schlagzeilen',
        strategies: 'Strategien',
        processSteps: 'Prozess',
        provenance: 'Quelle',
        confidenceValue: 'Konfidenz {level}',
        categories: {
          space: 'Räume und Nutzungen',
          circulation: 'Erschließung',
          structure: 'Tragwerk',
          envelope: 'Gebäudehülle',
          services: 'Gebäudetechnik',
          building_physics: 'Bauphysik',
          finish: 'Oberflächen',
          landscape: 'Freiraum',
          material: 'Materialien',
          object: 'Objekte',
          part: 'Bestandteile',
          person: 'Personen und Rollen',
          place: 'Orte',
          other: 'Weiteres',
        },
        state: {
          existing: 'Bestand',
          new: 'neu',
          demolished: 'rückgebaut',
          reused: 'weiterverwendet',
          transformed: 'transformiert',
        },
        source: {
          text: 'beschrifteter Text',
          visual: 'aus der Zeichnung erkannt',
          inferred: 'abgeleitet',
        },
        confidence: {
          high: 'hoch',
          medium: 'mittel',
          low: 'niedrig',
        },
      },
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
    resizePeek: 'Breite der Dateivorschau ändern',
    peekIndexingHint: 'Piloti kann diese Datei erst nach der Indizierung zitieren.',
    peekFailedHint: 'Indizierung fehlgeschlagen — Piloti kann diese Datei nicht zitieren.',
    peekFailedAction: 'Details',
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
    clearFilters: 'Filter zurücksetzen',
    resetSearch: 'Suche zurücksetzen',
    recentlyUploaded: 'Zuletzt hochgeladen',
    semantic: {
      searchPlaceholder: 'Dateien durchsuchen – Enter für semantische Suche …',
      run: 'Suchen',
      reset: 'Alle Dateien anzeigen',
      noResults: 'Keine semantischen Treffer für „{query}“',
      failed: 'Die Suche konnte nicht ausgeführt werden',
      failedDescription:
        'Auf dem Weg zum Index ist etwas schiefgegangen. Ihre Dateien sind unverändert — versuchen Sie dieselbe Suche erneut oder kehren Sie zu allen Dateien zurück.',
      retry: 'Erneut versuchen',
      noResultsDescription:
        'Nichts in diesem Projekt entsprach dem Sinn Ihrer Anfrage. Versuchen Sie eine andere Formulierung oder löschen Sie die Suche, um alle Dateien zu durchsuchen.',
      page: 'Seite {page}',
      relevance: '{percent}% Relevanz',
    },
  },
  folders: {
    rename: 'Umbenennen …',
    renameLabel: 'Ordner „{name}“ umbenennen',
    renaming: 'Wird umbenannt …',
    delete: 'Löschen …',
    actions: 'Ordneraktionen',
    actionsFor: 'Aktionen für Ordner „{name}“',
    heading: 'Ordner',
    namePlaceholder: 'Ordnername',
    newFolderName: 'Name des neuen Ordners',
    creating: 'Ordner wird erstellt …',
    allFiles: 'Alle Dateien',
    // Der Weg nach oben, benannt – die Brotkrumenleiste sagt, WO man ist, und
    // das ist eine Karte. Drei Ebenen tief ist der übergeordnete Ordner ein
    // abgeschnittenes Wort mitten in einer scrollenden Zeile.
    backTo: 'Zurück zu {name}',
    newFolder: 'Neuer Ordner',
    items: '{count} Element(e)',
    openFolder: 'Ordner „{name}“ öffnen',
    breadcrumb: 'Ordnerpfad',
    movedFolder: '„{name}“ nach „{parent}“ verschoben.',
    moveFolderError: 'Der Ordner konnte nicht verschoben werden. Bitte erneut versuchen.',
  },
  workspace: {
    renameFolderError: 'Der Ordner konnte nicht umbenannt werden. Bitte versuchen Sie es erneut.',
    deleteFolderError: 'Der Ordner konnte nicht gelöscht werden. Bitte versuchen Sie es erneut.',
    deleteFolderConfirm: 'Ordner „{name}“ löschen?',
    deleteFolderConfirmWithContents:
      'Ordner „{name}“ löschen?\n\nDie {documents} Dokument(e) und {folders} Unterordner werden nicht gelöscht — sie werden nach „{parent}“ verschoben.',
    deleteFolderDone: '„{name}“ gelöscht.',
    deleteFolderMoved: 'Ordner gelöscht. {count} Dokument(e) nach „{parent}“ verschoben.',
    corpusSubtitle: 'Projektwissen – diese Dokumente untermauern Pilotis Antworten',
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
    },
  },
  // Detailansicht des Explorers – Spaltenüberschriften der sortierbaren Liste.
  list: {
    columns: {
      relevance: 'Relevanz',
      name: 'Name',
      status: 'Status',
      pages: 'Seiten',
      size: 'Größe',
      added: 'Hinzugefügt',
    },
  },
  actions: {
    reingest: 'Erneut einlesen',
    move: 'In Ordner verschieben',
    moved: '„{name}“ nach {folder} verschoben',
    moveError: 'Das Dokument konnte nicht verschoben werden. Bitte versuchen Sie es erneut.',
    reingesting: 'Wird erneut gestartet …',
    reingestError:
      'Die Verarbeitung konnte nicht erneut gestartet werden. Bitte versuchen Sie es erneut.',
    label: 'Dateiaktionen für „{name}“',
    menuLabel: 'Dateiaktionen',
    download: 'Herunterladen',
    rename: 'Umbenennen…',
    delete: 'Löschen…',
  },
  rename: {
    title: 'Dokument umbenennen',
    description:
      'Ändert den Namen, der in Piloti überall angezeigt wird — auch in Zitaten. Die Datei selbst und alles daraus Indexierte bleiben unverändert.',
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
    action: 'Dokument löschen',
    title: '„{name}“ löschen?',
    confirm:
      'Dadurch wird das Dokument aus diesem Projekt entfernt. Dies kann nicht rückgängig gemacht werden.',
    confirmAction: 'Löschen',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    success: '„{name}“ wurde aus dem Projekt entfernt',
    error: 'Das Dokument konnte nicht gelöscht werden',
  },
  /**
   * Der Ordner-Upload-Plan — der Dialog, den ein abgelegter Ordnerbaum öffnet,
   * bevor sich etwas bewegt. Siehe die englische Fassung für das Warum.
   */
  folderUpload: {
    title: '„{name}“ hochladen?',
    titleGeneric: 'Diesen Ordner hochladen?',
    destination: 'Die Ordnerstruktur wird in „{folder}“ nachgebildet.',
    destinationMerged: 'Der Inhalt kommt direkt in „{folder}“ — die Ordner darin werden zugeordnet.',
    planning: 'Wird mit dem Bestand verglichen…',
    counts: {
      new: 'neue Dokumente',
      update: 'vorhanden, geändert',
      unchanged: 'unverändert, übersprungen',
      foldersCreated: 'Ordner angelegt',
      foldersMatched: '{count} zugeordnet',
    },
    updatePrompt: '{count} vorhandene(s) Dokument(e) aktualisieren',
    updateExplain:
      'Name, Zitate und Zuweisungen bleiben — ersetzt wird nur die Datei dahinter.',
    refiled: '{count} davon liegen derzeit woanders und wandern dorthin, wo dieser Ordner sie ablegt.',
    collisions: '{count} Dateien teilen sich einen Namen mit einer anderen Datei in diesem Upload',
    collisionsExplain:
      'Ein Projekt hält pro Dateiname ein Dokument, deshalb werden diese nicht hochgeladen. Benennen Sie sie um und legen Sie sie erneut ab.',
    showAll: 'Alle {count} Dateien anzeigen',
    action: {
      new: 'Neu',
      update: 'Aktualisieren',
      unchanged: 'Unverändert',
      collision: 'Konflikt',
      skipped: 'Übersprungen',
    },
    confirm: '{count} Datei(en) hochladen',
    nothingToDo: 'Nichts hochzuladen',
    cancel: 'Abbrechen',
    done: '{uploaded} Datei(en) hochgeladen, {skipped} unverändert.',
    foldersError: 'Die Ordner für diesen Upload konnten nicht angelegt werden. Es wurde nichts hochgeladen.',
  },
  upload: {
    uploading: 'Wird hochgeladen …',
    upload: 'Hochladen',
    uploadFolder: 'Ordner hochladen',
    uploadFiles: 'Dateien auswählen',
  },
  errors: {
    validation: {
      duplicateInBatch: '„{name}“ ist mehrfach in dieser Auswahl',
      duplicateExisting: '„{name}“ wurde bereits hinzugefügt',
      invalidType: '„{name}“ ist kein unterstützter Dateityp. Zulässig: {accepted}',
      fileTooLarge: '„{name}“ hat {size} — das Limit liegt bei {limit}',
      totalSizeExceeded: 'Das ergäbe {total}; frei sind nur {available} von {limit}',
      totalSizeExceededFirst: '{total} überschreiten das Limit von {limit}',
      maxFilesExceeded:
        'Das wären {total} Dateien; es passen nur noch {available} ({limit} maximal)',
      maxFilesExceededFirst: '{total} Dateien überschreiten das Limit von {limit}',
      several: '{count} Dateien haben Probleme',
    },
    someUploadsFailed:
      '{failed} von {total} Dokumenten konnten nicht hochgeladen werden. Erster Grund: {reason}',
    uploadingSkipped:
      'Es werden {uploading} {fileLabel} hochgeladen, {skipped} übersprungen ({summary})',
    cannotRetryServerFile:
      'Vom Server geladene Dateien können nicht erneut versucht werden. Bitte laden Sie die Datei erneut hoch.',
    imageVlmUnavailable:
      'Bilder können hier nicht hochgeladen werden: In dieser Umgebung ist keine Bilderkennung eingerichtet.',
    fileSingular: 'Datei',
    filePlural: 'Dateien',
  },
  /**
   * Das Filter-/Sortiermenü der Dateien-Kopfzeile.
   *
   * Ersetzt die offene Filterleiste: Die Kopfzeile trug bereits Ansichtsumschalter,
   * Suchfeld und Upload-Button und hatte keinen Platz mehr für weitere Filter. Die
   * Zahl am Button ist der Preis dafür – ein verborgener Filter, den niemand sieht,
   * ist schlimmer als eine volle Leiste.
   */
  filters: {
    label: 'Filter',
    labelActive: 'Filter ({count} aktiv)',
    reset: 'Filter zurücksetzen',
    // Was der Leserin fehlt, wenn Typ oder Status die Ebene geleert haben: die
    // Tatsache, dass ein Filter und nicht ein leerer Ordner der Grund ist.
    emptyTitle: 'Keine Datei passt zu diesen Filtern',
    emptyDescription:
      'In diesem Ordner liegen Dokumente, aber keines entspricht der aktuellen Auswahl. Setzen Sie die Filter zurück, um wieder alles zu sehen.',
    sortLabel: 'Sortierung',
    ascending: 'Aufsteigend',
    descending: 'Absteigend',
    statusLabel: 'Status',
    // Die drei Fragen, die tatsächlich gestellt werden – nicht die zehn
    // Pipeline-Zustände, die sich nur darin unterscheiden, welche Stufe sie
    // gemeldet hat.
    status: {
      failed: 'Fehlgeschlagen',
      processing: 'In Arbeit',
      ready: 'Zitierfähig',
    },
    originLabel: 'Herkunft',
    kindLabel: 'Dateityp',
    kind: {
      floorplan: 'Grundriss',
      section: 'Schnitt / Ansicht',
      siteplan: 'Lageplan',
      notice: 'Bescheid',
      photo: 'Foto',
      model: '3D-Modell (IFC)',
      document: 'Dokument',
    },
  },
  // Herkunft – wer die Datei geschrieben hat. Bewusst eine eigene Gruppe und
  // NICHT Teil von `assignment`: Ein Gesicht sagt, wer verantwortlich ist,
  // dieser Text sagt, wer sie erstellt hat. Ein von Piloti erstellter Bericht
  // ist eine ganz normale unvergebene Datei – in der Fußzeile steht daneben
  // weiterhin „Unvergeben“.
  authorship: {
    byPiloti: 'Von Piloti erstellt',
    filter: 'Von Piloti',
    /**
     * Die Frage, die dieser Filter bisher unbeantwortet ließ: WELCHE Dateien
     * das wären. Ohne diesen Leerzustand zeigte ein leeres Ergebnis „Dieser
     * Ordner ist leer" über einem Ordner voller Dokumente.
     */
    emptyTitle: 'Piloti hat hier noch nichts abgelegt',
    emptyDescription:
      'Hier erscheinen die Dateien, die Piloti selbst erstellt hat: abgelegte Rechercheberichte und Diagramme. Hochgeladene Dokumente zählen nicht dazu, auch wenn Piloti sie gelesen hat.',
    // Warum „Piloti dazu fragen“ deaktiviert ist – deaktiviert, nicht
    // versteckt, wie beim noch nicht zitierbaren Dokument. Der Unterschied:
    // Hier gibt es kein „noch nicht“. Der Bericht wurde absichtlich nicht
    // indexiert, damit Piloti den eigenen Text nicht als Beleg zitiert.
    notInKnowledge: 'Von Piloti erstellt — nicht in der Wissensbasis',
  },
  assignment: {
    unassigned: 'Unvergeben',
    assign: 'Zuweisen',
    edit: 'Bearbeiten',
    assignToMe: 'Mir zuweisen',
    filterAll: 'Alle',
    filterMine: 'Meine',
    filterUnassigned: 'Unvergeben',
    emptyUnassigned: 'Alle Dateien haben jemanden',
    emptyMine: 'Ihnen ist noch nichts zugewiesen',
    emptyDescription:
      'Ein anderer Filter zeigt Ihnen wieder alle Dateien dieses Ordners.',
    responsible: 'Verantwortlich',
    ask: 'Piloti dazu fragen',
    askDisabled: 'Sobald die Datei zitierbar ist',
    askColleague: 'Kollegin fragen',
    copyLink: 'Link kopieren',
    linkCopied: 'Link kopiert',
    alsoAssign: 'Auch zuweisen',
    send: 'Senden',
    to: 'An',
    message: 'Nachricht',
    starterKeyPoints: 'Was sind die Kernaussagen?',
    starterOib: 'Welche OIB-Stellen gelten hier?',
    starterKeyPointsNamed: 'Was sind die Kernaussagen in „{name}“?',
    starterOibNamed: 'Welche OIB-Stellen gelten für „{name}“?',
    askingAbout: 'Frage zu {name}',
    askingAboutPrefix: 'Frage zu',
    thisFile: 'dieser Datei',
    showFile: 'Datei anzeigen',
    expandFile: 'Größer öffnen',
    resizeFile: 'Dateiansicht verbreitern',
    welcomeAbout:
      'Dieser Chat dreht sich um {name}. Fragen Sie danach — die Antwort zitiert die Unterlage und das Recht.',
    subjectHint:
      'Piloti sucht in dieser Unterlage. Andere Projektakten und das Büroarchiv bleiben außen vor.',
    subjectClear: 'Nicht mehr auf diese Datei beschränken',
    loadingPeople: 'Personen werden geladen…',
    noPeople: 'Noch niemand in diesem Projekt',
    peopleLoadError: 'Personen konnten nicht geladen werden',
    assignError: '„{name}“ konnte nicht als zuständig eingetragen werden',
    unassignError: '„{name}“ konnte nicht entfernt werden',
    tryAgain: 'Erneut versuchen',
  },
}
