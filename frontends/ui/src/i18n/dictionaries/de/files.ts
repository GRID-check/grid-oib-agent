import type { en } from '../en'

/** files namespace — populated during component i18n. */
export const files: typeof en.files = {
  uploadZone: {
    clickToUpload: 'Zum Hochladen klicken',
    orDragAndDrop: ' oder per Drag-and-drop ablegen',
    maxSize: 'Bis zu {size} pro Datei',
    accepts: 'Zulässig: {types}',
    dragOrBrowse: 'Dateien hierher ziehen oder auswählen',
    maxSizeShort: 'max. {size} pro Datei',
  },
  // Die Upload-Leiste. Die Formulierungen folgen der Regel der Oberfläche:
  // Eine Zahl steht nur dort, wo tatsächlich gemessen wurde. „Wird gelesen“
  // beschreibt, was das Backend mit einem Dokument tut – dafür gibt es keine
  // Restzeit, also sagt der Text das, statt eine zu suggerieren.
  uploads: {
    region: 'Uploads',
    // Kein Fehler und nichts zu wiederholen: Das Dokument wird weiter gelesen,
    // die Leiste verfolgt es nur nicht mehr im Sekundentakt.
    stillReading: 'Das Lesen dauert länger als üblich und läuft im Hintergrund weiter.',
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
      // Von der Inhaltsprüfung zurückgehalten (ADR-0086): kein Fehler, nichts zu
      // wiederholen. Nie „freigeben“, das Wort gehört der Freigabe einer Fassung.
      heldOne: '1 Dokument zurückgehalten',
      heldOther: '{count} Dokumente zurückgehalten',
      mixedHeld: '{ready} hinzugefügt · {held} zurückgehalten',
      canceled: 'Upload abgebrochen',
    },
    detail: {
      bytes: '{done} von {total}',
      eta: 'noch {time}',
      queued: '{count} in Warteschlange',
      processing: 'Wird gelesen. Die Dauer lässt sich nicht vorhersagen, Sie können weiterarbeiten.',
      // Der Browser meldet keine Verbindung, während Bytes unterwegs sein sollten.
      // Der Transport wartet dann auf das Netz und sendet erneut (`xhr-upload`).
      offline: 'Keine Verbindung, wartet. Bitte die Seite geöffnet lassen.',
      elapsed: 'seit {time}',
      settled: '{total} übertragen',
    },
    row: {
      queued: 'Wartet',
      uploading: 'Wird gesendet',
      processing: 'Wird gelesen',
      ready: 'Zitierbar',
      unchanged: 'Unverändert – bereits vorhanden',
      // Die Inhaltsprüfung hat angeschlagen; darunter steht, was sie gefunden hat.
      held: 'Zurückgehalten',
      // Gespeichert, aber nicht gelesen: kein Erfolg, kein Fehler (wie `status.stored`).
      stored: 'Abgelegt',
      canceled: 'Abgebrochen',
      failed: 'Fehlgeschlagen',
    },
    actions: {
      expand: 'Dateien anzeigen',
      collapse: 'Dateien ausblenden',
      cancelAll: 'Alle abbrechen',
      cancel: 'Upload von {name} abbrechen',
      retryAll: 'Fehlgeschlagene wiederholen',
      retryFile: 'Erneut versuchen',
      dismiss: '{name} ausblenden',
      dismissAll: 'Ausblenden',
    },
  },
  status: {
    // "Zitierbar" (nicht bloß "Bereit") beantwortet die entscheidende Frage:
    // Das Dokument ist jetzt in Pilotis Wissen und kann zitiert werden.
    ready: 'Zitierbar',
    processing: 'Wird gelesen',
    uploading: 'Wird hochgeladen',
    failed: 'Fehlgeschlagen',
    // Der Bericht, den Piloti geschrieben hat: die Datei liegt im Projekt, ist
    // aber bewusst nicht in der Wissensbasis. „Abgelegt“ sagt genau das – kein
    // Erfolg („Zitierbar“ wäre ein Versprechen, das die Suche nicht einlöst)
    // und kein Fehler. Dasselbe Wort wie im Toast nach dem Lauf.
    stored: 'Abgelegt',
    // Die Inhaltsprüfung (ADR-0086) hat angeschlagen: Die Datei liegt im
    // Projekt, kein Modell hat sie gesehen, und jemand muss entscheiden.
    quarantined: 'Zurückgehalten',
    unknown: 'Unbekannt',
    // Nur die eigenen Uploads des Büros: Innerhalb eines Büros wird der Reihe
    // nach gelesen, zwischen Büros fair abgewechselt (ADR-0076).
    queuedAhead: '{count, plural, one {Wartet · # Datei davor} other {Wartet · # Dateien davor}}',
  },
  toast: {
    // Sobald die asynchrone Verarbeitung abgeschlossen ist und das Dokument
    // zitierbar wird – die bislang fehlende Bestätigung des Abschlusses.
    ingestionComplete: '„{name}“ ist jetzt in Pilotis Wissen – zitierbar',
    modelReady: '„{name}“ ist gelesen. Sie können jetzt Fragen zum Gebäude stellen.',
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
    // An office file is shown through a PDF the BFF makes from it (ADR-0070).
    renditionPending: 'PDF-Vorschau wird erstellt…',
    renditionNote: 'PDF-Vorschau · Original: {name}',
    noInlinePreview:
      'Für diesen Dateityp gibt es keine Inline-Vorschau. Laden Sie die Datei herunter, um das vollständige Dokument anzusehen.',
    textTruncated:
      'Es wird nur der Anfang dieser Datei angezeigt. Laden Sie die Datei herunter, um den vollständigen Inhalt zu lesen.',
    status: 'Status',
    properties: 'Eigenschaften',
    summaryMore: 'Vollständige Zusammenfassung',
    summaryLess: 'Weniger anzeigen',
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
    reading: {
      classifiedAs: 'Piloti hält es für',
      noType: 'Piloti hat keine Dokumentart erkannt.',
      correct: 'Korrigieren',
      assign: 'Zuordnen',
      done: 'Fertig',
      correctionKept: 'Ihre Zuordnung bleibt, auch wenn Piloti die Datei neu liest.',
      topics: 'Themen',
      addTopic: 'Thema hinzufügen',
      topicsSaveError: 'Die Themen konnten nicht gespeichert werden.',
      capturedAt: 'Aufgenommen am {when}',
      location: 'Standort',
    },
    /** Die Fassungsgeschichte eines Dokuments (document-fassungen.tsx). Nie „Plan“: der Name sagt nicht, was eine Datei ist. */
    fassung: {
      unlink: 'Verknüpfung lösen',
      timeline: 'Alle Fassungen dieses Dokuments',
      current: 'aktuell',
      open: 'Öffnen',
      compare: 'Vergleichen',
      changedSince: 'Was sich gegenüber {name} geändert hat:',
      changedSincePrevious: 'Was sich gegenüber der vorigen Fassung geändert hat:',
      changeHint:
        'Zusammenfassung von Piloti, aus beiden Fassungen gelesen. Maße und Werte prüfen Sie bitte im Dokument selbst.',
      suggestion: 'Ist das eine neuere Fassung von {name}?',
      basisTitleBlock: 'Plannummer und Index im Plankopf sprechen dafür.',
      basisName: 'Index und Datum im Dateinamen sprechen dafür.',
      basisContent: 'Piloti hat beide gelesen:',
      confirm: 'Ja, neuere Fassung',
      dismiss: 'Nein',
      askEditor: 'Bestätigen kann, wer diesen Ordner bearbeiten darf.',
      saveError: 'Die Verknüpfung konnte nicht gespeichert werden. Bitte erneut versuchen.',
      versions: {
        open: 'Öffnen',
        download: 'Herunterladen',
        compareText: 'Text mit Fassung {number} vergleichen',
      },
      // Der Abschnitt in der Seitenleiste (document-fassungen.tsx). Die Fassungen
      // sind durchnummeriert, die neueste zuerst, über gleichnamige Uploads und
      // verknüpfte Dokumente hinweg. Der Kopf sagt, wo die NEUESTE steht.
      rail: {
        number: 'Fassung {number}',
        dateTag: 'Stand {date}',
        stepOf: 'Schritt {step} von {total}: {stage}',
        next: {
          approve: 'Nächster Schritt: Freigabe durch {who}',
          approveYou: 'Nächster Schritt: Ihre Freigabe',
          approveOpen: 'Nächster Schritt: Freigabe',
          revise: 'Nächster Schritt: Überarbeitung durch {who}',
          reviseYou: 'Nächster Schritt: Ihre Überarbeitung',
          submit: 'Nächster Schritt: Einreichung zur Freigabe durch {who}',
          submitYou: 'Nächster Schritt: Ihre Einreichung zur Freigabe',
          publish: 'Nächster Schritt: Veröffentlichung',
          publishYou: 'Nächster Schritt: Ihre Veröffentlichung',
        },
        whoMore: '{names} oder {count} weitere',
        // Nur wenn der Name wirklich unbekannt ist. Nie „jemand“.
        someone: 'ein Teammitglied',
        answer: {
          this: 'Piloti antwortet aus dieser Fassung.',
          older: 'Piloti antwortet weiter aus Fassung {number}.',
          newer: 'Piloti antwortet aus der neueren Fassung {number}; diese bleibt lesbar, auch für Vergleiche.',
          notYet: 'Piloti antwortet erst daraus, wenn sie freigegeben ist.',
          notYetRead: 'Piloti antwortet daraus, sobald sie gelesen ist.',
          never: 'Piloti antwortet nicht daraus.',
        },
        // {name} kommt mit dem Datum: „Anna Berger · 14.08.2026“, untrennbar.
        act: '{act} von {name}',
        actAnonymous: '{act} am {date}',
        byYou: 'Ihnen',
        bySomeone: 'einem Teammitglied',
        rowMenu: 'Weitere Aktionen zu Fassung {number}',
        approveExplain:
          'Freigeben heißt: Das Büro steht für den Inhalt ein. Ab dann antwortet Piloti aus dieser Fassung.',
        changedSince: 'Geändert gegenüber Fassung {number}:',
        archive: 'Datei stilllegen …',
      },
    },
    indexed: {
      title: 'Von Piloti gelesen',
      documentType: 'Dokumenttyp',
      pending: 'Piloti liest das Dokument noch – Zusammenfassung und Merkmale erscheinen hier, sobald es fertig ist.',
    },
    contentTypeNames: {
      text: 'Text',
      table: 'Tabellen',
      chart: 'Diagramme',
      image: 'Bilder',
      drawing: 'Zeichnungen',
    },
    visualDetails: {
      title: 'Auf den Seiten',
      loading: 'Beschreibungen werden geladen …',
      failed: 'Die Beschreibungen konnten nicht geladen werden.',
      page: 'Seite {page}',
      scale: 'Maßstab {scale}',
      pageShort: 'S. {page}',
      showPage: 'Seite {page} im Dokument zeigen',
      showAll: 'Alle {count} zeigen',
      showFewer: 'Weniger zeigen',
      // The drawing types the vision pass names. A type not listed here is
      // humanized from its key, like the structured vocabulary below.
      segmentTypes: {
        floor_plan: 'Grundriss',
        section: 'Schnitt',
        elevation: 'Ansicht',
        detail: 'Detail',
        site_plan: 'Lageplan',
        perspective: 'Perspektive',
        axonometric: 'Axonometrie',
        drawing: 'Technische Zeichnung',
        map: 'Karte',
        photo: 'Foto oder Rendering',
        diagram: 'Diagramm',
        table: 'Tabelle',
        legend: 'Legende',
        screenshot: 'Bildschirmfoto',
        other: 'Sonstiges',
      },
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
    // Die Typ-Zeile nennt das Format, nie den MIME-Typ (der steht im Tooltip).
    formats: {
      pdf: 'PDF',
      word: 'Word-Dokument',
      excel: 'Excel-Tabelle',
      powerpoint: 'PowerPoint-Präsentation',
      odText: 'OpenDocument-Text',
      odSpreadsheet: 'OpenDocument-Tabelle',
      odPresentation: 'OpenDocument-Präsentation',
      rtf: 'Rich-Text-Dokument',
      csv: 'CSV-Tabelle',
      tsv: 'TSV-Tabelle',
      markdown: 'Markdown',
      plainText: 'Textdatei',
      ifc: 'IFC-Modell',
      email: 'E-Mail',
      image: 'Bild ({format})',
      extension: '{ext}-Datei',
      raw: '{type}',
    },
    download: 'Herunterladen',
    downloadFailed: 'Der Download konnte nicht gestartet werden. Bitte versuchen Sie es erneut.',
    ingestionFailed: 'Lesen fehlgeschlagen',
    heldTitle: 'Von der Inhaltsprüfung zurückgehalten',
    heldDecided: 'Über diese Datei hat schon jemand entschieden.',
    ingestionFailedPreviousVersionKept:
      'Die Suche und Piloti verwenden weiterhin die vorige Fassung. Der Download liefert die neue Datei.',
    retryIngestion: 'Erneut lesen',
    retryWouldFailAgain:
      'Diese Datei liefert beim erneuten Lesen dasselbe Ergebnis. Laden Sie eine neue Fassung hoch.',
    retryingIngestion: 'Wird erneut gestartet…',
    retryIngestionError:
      'Das erneute Lesen konnte nicht gestartet werden. Bitte versuchen Sie es noch einmal.',
    dialogLabel: 'Dateivorschau: {name}',
    // The two faces of the file beside the chat: the document, and what is known about it.
    peekViews: {
      label: 'Ansicht der Datei',
      document: 'Dokument',
      details: 'Details',
    },
    // The length, in the facts line under the name in the chat peek.
    pageCount: '{count, plural, one {# Seite} other {# Seiten}}',
    resizePeek: 'Breite der Dateivorschau ändern',
    peekIndexingHint: 'Piloti kann diese Datei erst zitieren, wenn sie gelesen ist.',
    peekFailedHint: 'Lesen fehlgeschlagen. Piloti kann diese Datei nicht zitieren.',
    peekFailedPreviousVersionHint:
      'Die neue Datei konnte nicht gelesen werden – Piloti zitiert weiterhin die vorige Fassung.',
    peekFailedAction: 'Details',
  },
  /**
   * Warum ein Dokument nicht gelesen werden konnte, nach der Kategorie, die
   * `features/documents/lib/ingest-failure.ts` dem gespeicherten Fehler gibt.
   * Der Rohtext steht hinter `details`.
   */
  ingestFailure: {
    rendition_failed:
      'Die PDF-Vorschau dieser Datei ließ sich nicht erzeugen. Erneut lesen oder die Datei als PDF hochladen.',
    download_failed:
      'Die hochgeladene Datei war im Speicher nicht erreichbar. Erneut lesen oder die Datei noch einmal hochladen.',
    interrupted: 'Das Lesen wurde durch einen Neustart des Dienstes unterbrochen. Erneut lesen, um es abzuschließen.',
    unreadable_pages:
      '{failed} von {total} Seiten ließen sich nicht lesen. Erneut lesen. Klappt es wieder nicht, ist die PDF vermutlich beschädigt.',
    vision_not_configured:
      'Für gescannte Seiten und Bilder braucht Piloti ein Bildmodell, und es ist keins eingerichtet. Bitte die Admins, eins zu konfigurieren.',
    dispatch_failed: 'Das Lesen ließ sich nicht starten. Bitte erneut lesen.',
    timeout: 'Das Lesen hat zu lange gedauert und wurde abgebrochen. Erneut lesen. Sehr große Dateien besser aufteilen.',
    empty: 'In dieser Datei war kein Text zu finden. Sie ist vielleicht passwortgeschützt, beschädigt oder leer.',
    deleted: 'Die Datei wurde gelöscht, während Piloti sie las.',
    quarantined:
      'Diese Datei enthält etwas, das Ihr Büro als sensibel eingestuft hat. Piloti hat sie keinem Modell gezeigt. Die Büro- oder Projektadministration prüft sie und entscheidet, ob sie bleibt oder gelöscht wird.',
    // Gefunden im Text, den das Bildmodell aus gescannten Seiten gelesen hat
    // (`after_transcription`): dieses Modell hat die Seiten gesehen, kein anderes.
    quarantinedAfterTranscription:
      'Diese Datei enthält etwas, das Ihr Büro als sensibel eingestuft hat, gefunden im Text gescannter Seiten. Diese Seiten hat ein Bildmodell gelesen, damit sie geprüft werden konnten; kein anderes Modell hat sie gesehen. Die Büro- oder Projektadministration prüft sie und entscheidet, ob sie bleibt oder gelöscht wird.',
    // Der Grund ist nicht gespeichert oder nicht lesbar: nichts behaupten, was
    // die Zeile darüber nicht belegt.
    quarantinedUnreadable:
      'Die Inhaltsprüfung hat diese Datei zurückgehalten. Der Grund ist nicht gespeichert oder nicht lesbar. Solange sie zurückgehalten ist, zeigt Piloti sie keinem Modell. Die Büro- oder Projektadministration prüft sie und entscheidet, ob sie bleibt oder gelöscht wird.',
    // Die Prüfregeln des Büros ließen sich nicht anwenden: die Datei wurde gar
    // nicht gelesen und wartet wie eine zurückgehaltene (ADR-0086).
    screening_unavailable:
      'Die Prüfung auf sensible Daten ließ sich nicht durchführen, daher hat Piloti diese Datei nicht gelesen und keinem Modell gezeigt. Erneut lesen, oder die Büro- oder Projektadministration entscheidet, ob sie bleibt.',
    unknown: 'Piloti konnte dieses Dokument nicht lesen, daher findet die Suche es nicht.',
    details: 'Details',
  },
  screening: {
    // Warum eine Datei zurückgehalten (Inhaltsprüfung, im Text) oder nicht
    // hochgeladen wurde (Namensprüfung, im Datei- oder Ordnernamen), ADR-0086.
    reasonTerm: '„{term}“ im Text',
    reasonIban: 'IBAN {sample}',
    reasonSvnr: 'Sozialversicherungsnummer {sample}',
    reasonCard: 'Kreditkartennummer {sample}',
    reasonPages: '{count, plural, one {Seite {pages}} other {Seiten {pages}}}',
    // Tabellenblätter und Textdateien haben keine Seiten: der Treffer hat dann
    // keinen Ort, den man aufschlagen könnte.
    reasonNoPages: 'ohne Seitenangabe',
    // Eine Regel, die dieser Stand der Anwendung nicht kennt (der Job kann
    // eine neue Art von Treffer zuerst melden).
    reasonOther: 'Eine Regel, die hier nicht näher beschrieben ist',
    // Wie die Inhaltsprüfung zu dem Treffer kam: wer die Regel festgelegt hat,
    // und was eine Zahl bestehen musste. So lässt sich eine echte Kontonummer
    // von einer Auftragsnummer unterscheiden, die nur so aussieht.
    basisTerm: 'Dieser Begriff steht auf der Liste, die Ihr Büro als sensibel eingestuft hat.',
    basisIban:
      'Die Zahl hat den Aufbau einer IBAN und ist rechnerisch gültig, also keine zufällige Ziffernfolge. Ihr Büro hat Kontonummern als sensibel eingestuft.',
    basisSvnr:
      'Die Zahl hat den Aufbau einer österreichischen Sozialversicherungsnummer und ist rechnerisch gültig. Ihr Büro hat sie als sensibel eingestuft.',
    basisCard:
      'Die Zahl hat den Aufbau einer Kartennummer und ist rechnerisch gültig. Ihr Büro hat Kartennummern als sensibel eingestuft.',
    basisOther: 'Die Inhaltsprüfung hat eine Regel angewandt, die hier nicht näher beschrieben ist.',
    omitted:
      '{count, plural, one {Ein weiterer Grund wird nicht aufgeführt.} other {# weitere Gründe werden nicht aufgeführt.}}',
    nameInFile: 'Dateiname enthält „{term}“',
    nameInFolder: 'Ordner „{segment}“ enthält „{term}“',
    // Gescannte Seiten werden seit ADR-0086 (2026-10-17) nach dem Lesen geprüft:
    // „nicht geprüft“ stimmte nicht mehr, „vorab“ schon.
    partial: 'Nicht alles ließ sich vorab prüfen: Gescannte Seiten, Bilder und Zeichnungen sieht zuerst ein Bildmodell.',
    unchecked: 'Der Inhalt ließ sich ohne Modell nicht lesen und wurde nur am Namen geprüft.',
    // Eine Fundstelle der Inhaltsprüfung, wie eine Quelle im Chat: die Seite,
    // und darauf markiert, was das Büro als sensibel eingetragen hat.
    findingsLabel: 'Fundstellen der Inhaltsprüfung',
    findingPage: 'S. {page}',
    showFinding: 'Fundstelle auf Seite {page} zeigen',
    morePages: 'Auch auf weiteren Seiten gefunden',
  },
  browser: {
    folderEmptyTitle: 'Dieser Ordner ist leer',
    folderEmptyDescription:
      'Laden Sie hier Dokumente hoch oder wählen Sie einen anderen Ordner in der Seitenleiste.',
    noDocumentsTitle: 'Noch keine Dokumente',
    noDocumentsDescription:
      'Laden Sie die Unterlagen Ihres Projekts hoch: Zeichnungen, Bescheide, Gutachten, Berichte. Piloti liest sie und zitiert daraus, statt aus allgemeinen Hinweisen zu antworten.',
    searchPlaceholder: 'Suchen …',
    searchLabel: 'Dateien durchsuchen',
    noMatch: 'Keine Dateien entsprechen „{query}“',
    noMatchDescription:
      'Versuchen Sie einen anderen Namen, ein Schlagwort oder eine Beschreibung – oder löschen Sie die Suche, um alle Dateien zu sehen.',
    clearSearch: 'Suche löschen',
    clearFilters: 'Filter zurücksetzen',
    resetSearch: 'Suche zurücksetzen',
    recentlyUploaded: 'Zuletzt hochgeladen',
    /** Leere Suche, wenn die Suche nur im Namen sucht (der Ordner wird seitenweise geladen, ADR-0102). */
    noMatchNamesDescription:
      'Gesucht wird im Dateinamen. Drücken Sie Enter, um auch im Inhalt zu suchen – oder löschen Sie die Suche, um alle Dateien zu sehen.',
    /** Ende der Liste eines großen Ordners: der Rest kommt beim Weiterscrollen. */
    loadMore: 'Weitere laden',
    loadingMore: 'Weitere Dokumente werden geladen …',
    loadMoreFailed: 'Weitere Dokumente konnten nicht geladen werden.',
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
    newInside: 'Neuer Ordner darin',
    open: 'Öffnen',
    move: 'In Ordner verschieben',
    items: '{count, plural, one {# Element} other {# Elemente}}',
    openFolder: 'Ordner „{name}“ öffnen',
    breadcrumb: 'Ordnerpfad',
    movedFolder: '„{name}“ nach „{parent}“ verschoben.',
    moveFolderError: 'Der Ordner konnte nicht verschoben werden. Bitte erneut versuchen.',
    /** Ordnerzugriff (ADR-0088, ADR-0097): einen Ordner auf Personen einschränken. */
    access: {
      menu: 'Zugriff …',
      /** Das Schloss am Ordner: Wer auf der Liste steht, sagt erst der Dialog. */
      ownList: 'Eigene Zugriffsrechte: nur die eingetragenen Personen',
      ownListEveryoneReads: 'Eigene Zugriffsrechte: alle Projektmitglieder lesen, bearbeiten nur die eingetragenen Personen',
      openRestricted: 'Ordner „{name}“ öffnen. {access}',
      title: 'Zugriff auf „{name}“',
      description: 'Wer in diesem Projekt den Ordner, seine Unterordner und deren Dokumente lesen und bearbeiten darf.',
      inherit: 'Wie der übergeordnete Ordner',
      inheritHint:
        'Der Ordner übernimmt den Zugriff des Ordners darüber. Ganz oben gilt das Projekt: Wer lesen darf, liest; wer bearbeiten darf, bearbeitet.',
      custom: 'Eigene Zugriffsrechte',
      customHint:
        'Nur die eingetragenen Personen kommen in den Ordner, jede mit „Lesen“ oder „Bearbeiten“. Wer nicht eingetragen ist, sieht ihn nicht, außer alle Projektmitglieder dürfen lesen. Organisations-Admins dürfen immer alles.',
      everyoneReads: 'Alle Projektmitglieder dürfen lesen',
      everyoneReadsHint: 'Die Liste bestimmt dann nur, wer bearbeiten darf.',
      people: 'Personen',
      unknownPerson: 'Person ohne Projektzugang',
      levelRead: 'Lesen',
      levelWrite: 'Bearbeiten',
      levelFor: 'Zugriff für {name}',
      remove: '{name} entfernen',
      add: 'Person hinzufügen …',
      pickOne: 'Fügen Sie mindestens eine Person hinzu oder lassen Sie alle Projektmitglieder lesen.',
      nesting: 'Ein Unterordner kann nur enger sein als sein übergeordneter Ordner, nie weiter.',
      ceiling: '„Bearbeiten“ gilt nur für Personen, die im Projekt bearbeiten dürfen; alle anderen lesen.',
      lockout:
        'Stehen Sie selbst nicht auf der Liste, verschwindet der Ordner nach dem Speichern auch für Sie, außer Sie sind Organisations-Admin.',
      lockoutEveryoneReads:
        'Stehen Sie selbst nicht mit „Bearbeiten“ auf der Liste, dürfen Sie den Ordner nach dem Speichern nur noch lesen, außer Sie sind Organisations-Admin.',
      moveNotice:
        'Ändert sich, wer lesen darf, verschiebt Piloti die Dokumente des Ordners und liest sie neu ein. Bei einem großen Ordner dauert das einige Minuten; so lange stehen die Dokumente auf „Wird gelesen“.',
      ifcNotice:
        'Ordner, die nicht alle Projektmitglieder lesen dürfen, können noch keine Gebäudemodelle (IFC) enthalten. Legen Sie IFC-Modelle in Ordner, die alle lesen dürfen.',
      /** Der 409 der IFC-Sperre (ADR-0087): einschränken, hochladen oder verschieben in einen eingeschränkten Ordner. */
      ifcRefused:
        'Gebäudemodelle (IFC) können noch nicht in einem Ordner liegen, den nicht alle lesen dürfen: Ihre Gebäudedaten schützt der Ordnerzugriff nicht. Legen Sie IFC-Modelle in Ordner, die alle lesen dürfen.',
      readOnlyBadge: 'Nur lesen',
      readOnlyHint: 'Sie dürfen diesen Ordner lesen, aber nichts hochladen, umbenennen, verschieben oder löschen.',
      readOnlyMenu: 'Nur lesen',
      readOnlyRefused: 'In diesem Ordner dürfen Sie nur lesen.',
      save: 'Zugriff speichern',
      saving: 'Wird gespeichert…',
      loadError: 'Die Zugriffsliste konnte nicht geladen werden.',
      savedCustom: '„{name}“ hat jetzt eigene Zugriffsrechte.',
      savedInherit: '„{name}“ übernimmt jetzt den Zugriff des übergeordneten Ordners.',
      moving: '{count, plural, one {# Dokument wird} other {# Dokumente werden}} verschoben und neu eingelesen.',
      failed:
        '{count, plural, one {# Dokument konnte} other {# Dokumente konnten}} noch nicht verschoben werden. Speichern Sie erneut, um es noch einmal zu versuchen.',
      saveError: 'Der Zugriff konnte nicht geändert werden. Bitte versuchen Sie es erneut.',
      forbidden: 'Nur Projekt-Admins können ändern, wer einen Ordner lesen und bearbeiten darf.',
    },
    describe: 'Beschreibung …',
    /** Was in einen Ordner gehört (Migration 0145): Piloti legt Uploads danach ab. */
    description: {
      title: 'Was gehört in „{name}“?',
      hint: 'Ein, zwei Sätze, was in diesem Ordner liegt. Alle, die den Ordner öffnen, lesen sie, und Piloti schlägt danach vor, wohin ein Upload gehört.',
      label: 'Beschreibung',
      placeholder: 'z. B. Bescheide und Stellungnahmen der Baubehörde',
      count: '{count} / {max} Zeichen',
      tooLong: 'Höchstens {max} Zeichen.',
      save: 'Speichern',
      saveError: 'Die Beschreibung konnte nicht gespeichert werden. Bitte erneut versuchen.',
      edit: 'Beschreibung bearbeiten',
      empty: 'Beschreiben, was hierher gehört',
    },
  },
  /**
   * Piloti's filing suggestion: the chip on a card, a list row and an upload
   * row, the popover it opens, and the filing bar that decides per folder.
   */
  filing: {
    label: 'Ablagevorschlag von Piloti',
    /** The chip's accessible name; it shows only the folder's last segment. */
    chip: 'Ablagevorschlag: {folder}',
    new: 'neu',
    /** Where a file at the top level of a shelf is now, struck through in the popover. */
    rootProject: 'Projektordner (oberste Ebene)',
    rootOffice: 'Büroablage (oberste Ebene)',
    /** Spoken before the two paths of the popover, which a screen reader cannot see struck through. */
    from: 'Liegt jetzt in',
    to: 'Würde verschoben nach',
    barHeading: '{count, plural, one {Piloti schlägt vor, # Datei abzulegen} other {Piloti schlägt vor, # Dateien abzulegen}}',
    fileCount: '{count, plural, one {# Datei} other {# Dateien}}',
    others: '{count, plural, one {mit # weiteren Datei} other {mit # weiteren Dateien}}',
    move: 'Verschieben',
    moveAll: 'Alle {count} verschieben',
    createAndMove: 'Anlegen und verschieben',
    keep: 'Belassen',
    moved: 'In „{folder}“ verschoben.',
    kept: 'Bleibt, wo es ist.',
    failed: 'Konnte nicht verschoben werden.',
    error: 'Das hat nicht geklappt. Bitte erneut versuchen.',
    readOnly: 'Verschieben dürfen nur Personen, die hier ablegen dürfen.',
  },
  /** The Papierkorb of a project (ADR-0088). */
  bin: {
    title: 'Papierkorb',
    subtitle:
      'Gelöschte Ordner mit ihren Unterordnern und Dokumenten. Bis zur endgültigen Löschung lassen sie sich mit ihren Zugriffsrechten wiederherstellen.',
    back: 'Zurück zu den Dateien',
    empty: 'Der Papierkorb ist leer.',
    emptyHint: 'Gelöschte Ordner erscheinen hier und lassen sich wiederherstellen.',
    deletedBy: 'Gelöscht von {name} am {date}',
    deletedOn: 'Gelöscht am {date}',
    contents:
      '{documents, plural, one {# Dokument} other {# Dokumente}} · {folders, plural, one {# Ordner} other {# Ordner}}',
    purgeOn: 'Wird am {date} endgültig gelöscht',
    purging: 'Wird gerade endgültig gelöscht',
    failed: 'Die endgültige Löschung ist angehalten. Ein Admin kümmert sich darum.',
    restore: 'Wiederherstellen',
    restored: '„{name}“ ist wiederhergestellt. Die Dokumente werden neu eingelesen.',
    restoredToRoot:
      '„{name}“ ist wiederhergestellt, und zwar direkt im Projekt: Sein übergeordneter Ordner ist gelöscht.',
    restoreNameTaken: 'Hier gibt es schon einen Ordner „{name}“. Benennen Sie ihn um und stellen Sie dann wieder her.',
    restoreReadOnly: 'Wiederherstellen kann, wer den Ordner bearbeiten durfte.',
    restoreError: 'Der Ordner konnte nicht wiederhergestellt werden. Bitte versuchen Sie es erneut.',
    purge: 'Endgültig löschen',
    purgeTitle: '„{name}“ endgültig löschen?',
    purgeDescription:
      'Der Ordner, seine Unterordner und {documents, plural, one {# Dokument} other {# Dokumente}} werden sofort gelöscht, mit allen Fassungen und Vorschauen. Das lässt sich nicht rückgängig machen. Was Piloti daraus abgeleitet hat, folgt der Einstellung Ihrer Organisation.',
    purged: '„{name}“ ist endgültig gelöscht.',
    held: 'Für diesen Ordner gilt eine Aufbewahrungspflicht. Er kann gerade nicht gelöscht werden.',
    purgeError: 'Der Ordner konnte nicht endgültig gelöscht werden. Bitte versuchen Sie es erneut.',
    cancel: 'Abbrechen',
    loadError: 'Der Papierkorb konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
  },
  workspace: {
    more: 'Mehr',
    renameFolderError: 'Der Ordner konnte nicht umbenannt werden. Bitte versuchen Sie es erneut.',
    deleteFolderError: 'Der Ordner konnte nicht gelöscht werden. Bitte versuchen Sie es erneut.',
    deleteFolderConfirm: 'Ordner „{name}“ löschen?',
    deleteFolderConfirmWithContents:
      'Ordner „{name}“ löschen?\n\nDie {documents} Dokument(e) und {folders} Unterordner werden nicht gelöscht — sie werden nach „{parent}“ verschoben.',
    deleteFolderDone: '„{name}“ gelöscht.',
    deleteFolderMoved: 'Ordner gelöscht. {count} Dokument(e) nach „{parent}“ verschoben.',
    binFolderConfirm:
      'Ordner „{name}“ in den Papierkorb verschieben?\n\nSeine Unterordner und Dokumente kommen mit. Im Papierkorb lässt er sich mit seinen Zugriffsrechten wiederherstellen, bis er endgültig gelöscht wird.',
    binFolderDone: '„{name}“ ist im Papierkorb. Wiederherstellbar bis {date}.',
    deleteFolderProtected:
      'Dieser Ordner enthält Inhalte, die Sie nicht löschen dürfen. Löschen kann ihn, wer alle seine Unterordner bearbeiten darf.',
    deleteFolderIndexDown:
      'Der Ordner wurde nicht gelöscht, weil der Suchindex nicht geantwortet hat. Bitte versuchen Sie es erneut.',
    openBin: 'Papierkorb',
    corpusSubtitle: 'Projektwissen: Dokumente, die Piloti liest und zitiert.',
    uploadDocuments: 'Dokumente hochladen',
    uploadProblem: 'Upload-Problem',
    dismissError: 'Fehler ausblenden',
    createFolderError: 'Ordner konnte nicht erstellt werden. Bitte versuchen Sie es erneut.',
    foldersLoadError: 'Ordner konnten nicht geladen werden.',
    documentsLoadError: 'Dokumente konnten nicht geladen werden.',
    listTruncated: 'Angezeigt werden die neuesten {count} Dokumente. Ältere fehlen in dieser Liste, in Suche, Filtern und beim Abgleich eines Ordner-Uploads.',
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
  selection: {
    start: 'Auswählen',
    done: 'Fertig',
    all: 'Alle',
    move: 'Verschieben',
    column: 'Auswahl',
    count: '{count} ausgewählt',
    moved: '{count, plural, one {# Datei nach „{folder}“ verschoben.} other {# Dateien nach „{folder}“ verschoben.}}',
    moveFailed: '{count, plural, one {# Datei konnte} other {# Dateien konnten}} nicht verschoben werden. Bitte versuchen Sie es erneut.',
  },
  picker: {
    titleOne: '„{name}“ verschieben nach …',
    titleMany: '{count, plural, one {# Datei verschieben nach …} other {# Dateien verschieben nach …}}',
    description: 'Wählen Sie den Ordner, in den die Dateien verschoben werden.',
    search: 'Ordner suchen',
    list: 'Ordner',
    empty: 'Kein Ordner passt zu „{query}“.',
    here: 'Hier',
    close: 'Schließen',
  },
  list: {
    columns: {
      relevance: 'Relevanz',
      name: 'Name',
      status: 'Status',
      // Der redaktionelle Stand (Freigabe), neben dem Verarbeitungsstatus: die
      // Spalte, die den Freigabe-Stand dort sichtbar macht, wo stapelweise
      // gearbeitet wird.
      approval: 'Freigabe',
      pages: 'Seiten',
      size: 'Größe',
      added: 'Hinzugefügt',
    },
  },
  actions: {
    reingest: 'Erneut lesen',
    move: 'In Ordner verschieben',
    moved: '„{name}“ nach {folder} verschoben',
    moveError: 'Das Dokument konnte nicht verschoben werden. Bitte versuchen Sie es erneut.',
    reingesting: 'Wird erneut gestartet …',
    reingestRunning: 'Wird bereits gelesen',
    reingestAlreadyDone: 'Ist bereits fertig',
    reingestWouldFailAgain:
      'Diese Datei liefert beim erneuten Lesen dasselbe Ergebnis. Laden Sie eine neue Fassung hoch.',
    reingestConfirmTitle: '„{name}“ erneut lesen?',
    reingestConfirmDescription:
      'Piloti liest die Datei noch einmal vollständig, zum Beispiel damit Bilder in Word- und PowerPoint-Dateien erfasst werden. Bis Piloti damit fertig ist, antwortet es weiter aus dem bisher Gelesenen.',
    reingestConfirmAction: 'Erneut lesen',
    reingestError:
      'Das erneute Lesen konnte nicht gestartet werden. Bitte versuchen Sie es noch einmal.',
    label: 'Dateiaktionen für „{name}“',
    menuLabel: 'Dateiaktionen',
    download: 'Herunterladen',
    open: 'Öffnen',
    ask: 'Danach fragen',
    select: 'Auswählen',
    copyOriginPath: 'Herkunftspfad kopieren',
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
    action: 'Dokument löschen',
    title: '„{name}“ löschen?',
    confirm:
      'Dadurch wird das Dokument aus diesem Projekt entfernt. Dies kann nicht rückgängig gemacht werden.',
    confirmAction: 'Löschen',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    success: '„{name}“ wurde aus dem Projekt entfernt',
    error: 'Das Dokument konnte nicht gelöscht werden',
    legalHold: 'Das Dokument unterliegt einer rechtlichen Sperre und kann nicht gelöscht werden',
  },
  /**
   * Ein auf ein Ablagefach gezogenes ZIP. Es wird im Browser entpackt und dann
   * wie der enthaltene Ordner behandelt (`folderUpload.*`); hier stehen nur die
   * Sätze für ein Archiv, das nichts ergeben hat.
   */
  zip: {
    reading: 'ZIP wird gelesen…',
    unreadable: '„{name}“ konnte nicht gelesen werden. Ist es ein gültiges ZIP ohne Passwort?',
    empty: '„{name}“ enthält keine Dateien.',
    tooManyFiles: '„{name}“ enthält mehr als {limit} Dateien, daher wurde nichts übernommen. Teilen Sie es in kleinere ZIPs auf.',
    tooLarge: '„{name}“ ist entpackt größer als {limit}, daher wurde nichts übernommen. Teilen Sie es in kleinere ZIPs auf.',
  },
  /**
   * Der Ordner-Upload-Plan — der Dialog, den ein abgelegter Ordnerbaum öffnet,
   * bevor sich etwas bewegt. Siehe die englische Fassung für das Warum.
   */
  folderUpload: {
    title: '„{name}“ hochladen?',
    titleGeneric: 'Diesen Ordner hochladen?',
    // Lose Dateien, von denen mindestens eine ein vorhandenes Dokument trifft.
    titleFiles: '{count, plural, one {# Datei hochladen?} other {# Dateien hochladen?}}',
    titleFilesGeneric: 'Dateien hochladen?',
    destinationFiles: 'Die Dateien kommen nach „{folder}“.',
    close: 'Schließen',
    compareError: 'Der Bestand konnte nicht verglichen werden. Es wurde nichts hochgeladen.',
    planChanged: 'Die Vorschau hat sich geändert. Es wurde nichts hochgeladen. Bitte prüfen Sie sie und bestätigen Sie erneut.',
    single: {
      newFassungTitle: 'Neue Fassung von „{name}“?',
      updateExplain:
        '„{name}“ liegt hier bereits unter diesem Namen. Die neue Datei wird die aktuelle Fassung; die bisherige bleibt unter „Fassungen und Freigabe“ lesbar.',
      fassungExplain:
        '„{file}“ setzt „{name}“ fort: Index oder Datum im Namen sind neuer. Die ältere Fassung bleibt lesbar, Piloti antwortet aus der neuen und hält fest, was sich geändert hat; die Verknüpfung lässt sich später lösen.',
      unclearTitle: 'Ist „{file}“ eine neue Fassung?',
      unclearExplain:
        'Nach dem Namen kommen mehrere Dokumente in Frage. Wählen Sie das, das diese Datei fortsetzt, oder laden Sie sie als eigenes Dokument hoch.',
      notNewerExplain:
        '„{file}“ ist nach seinem Namen nicht neuer als „{name}“. Als neue Fassung abgelegt, würde die Datei trotzdem zur aktuellen.',
      unchangedTitle: 'Unverändert – bereits vorhanden',
      unchangedExplain: '„{name}“ ist mit dieser Datei identisch. Es wird nichts hochgeladen.',
      refiled: 'Das Dokument liegt derzeit in einem anderen Ordner und wird nach „{folder}“ verschoben.',
      archived: 'Das Dokument ist archiviert. Die neue Fassung wird ihm hinzugefügt und erscheint erst wieder in der Liste, wenn es wiederhergestellt wird.',
      confirmFassung: 'Als neue Fassung ablegen',
      confirmSeparate: 'Als eigenes Dokument hochladen',
    },
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
    alreadyHereAs: 'hier als „{name}“',
    archivedMatch: 'archiviertes Dokument',
    refiled:
      '{count, plural, one {# davon liegt derzeit woanders und wandert dorthin, wo dieser Ordner es ablegt.} other {# davon liegen derzeit woanders und wandern dorthin, wo dieser Ordner sie ablegt.}}',
    moving:
      '{count, plural, one {# unverändertes Dokument liegt woanders und wird dorthin verschoben, wo dieser Ordner es ablegt.} other {# unveränderte Dokumente liegen woanders und werden dorthin verschoben, wo dieser Ordner sie ablegt.}}',
    duplicates:
      '{count, plural, one {# Datei liegt bereits unter einem anderen Namen im Projekt} other {# Dateien liegen bereits unter einem anderen Namen im Projekt}}',
    duplicatesExplain:
      'Ein Upload legte eine zweite Kopie an, statt etwas zu ersetzen — deshalb werden sie nicht gesendet. Benennen Sie das Dokument hier oder die Datei auf der Platte um, damit beide übereinstimmen.',
    collisions: '{count} Dateien teilen sich einen Namen mit einer anderen Datei in diesem Upload',
    collisionsExplain:
      'Ein Projekt hält pro Dateiname ein Dokument, deshalb werden diese nicht hochgeladen. Benennen Sie sie um und legen Sie sie erneut ab.',
    // Von der Namensprüfung nicht hochgeladen (ADR-0086): Die Dateien verlassen
    // den Rechner nicht, außer jemand lädt eine einzeln trotzdem hoch.
    // „Zurückgehalten“ gehört der Inhaltsprüfung.
    excluded: '{count, plural, one {# Datei nicht hochgeladen} other {# Dateien nicht hochgeladen}}',
    excludedExplain:
      'Ihr Büro hat diese Begriffe als sensibel eingestuft, deshalb werden die Dateien nicht hochgeladen: Sie verlassen Ihren Rechner nicht. Gehört eine davon doch nach Piloti, haken Sie sie an.',
    releaseFile: 'Trotzdem hochladen',
    // Dateien, die als neue Fassung eines vorhandenen Dokuments hereinkommen: mit
    // gleichem Namen (ADR-0054) oder über eine Namensreihe unter anderem Namen
    // (ADR-0099). Ein Begriff, gleich wie Piloti es erkannt hat (ADR-0099). Sagen
    // Sie Dokument, Datei, Fassung: ein Name mit Index sagt nicht, was eine Datei ist.
    fassung: {
      title: '{count, plural, one {# neue Fassung} other {# neue Fassungen}}',
      consequence:
        'Die ältere Fassung bleibt lesbar, Piloti antwortet aus der neuen und hält fest, was sich geändert hat; abgewählte Dateien kommen als eigene Dokumente hinein, und jede Verknüpfung lässt sich später lösen.',
      sameNameTitle:
        '{count, plural, one {# Datei mit gleichem Namen als neue Fassung} other {# Dateien mit gleichem Namen als neue Fassung}}',
      sameNameReason:
        'Gleicher Name wie ein Dokument hier: Name, Zitate und Zuweisungen bleiben, die bisherige Fassung bleibt unter „Fassungen und Freigabe“ lesbar. Abgewählt werden diese nicht hochgeladen.',
      masterAll: '{count, plural, one {Als neue Fassung} other {Alle # als neue Fassung}}',
      masterSome: '{ticked} von {count} als neue Fassung',
      masterNone: '{count, plural, one {Nicht als neue Fassung} other {Keine der # als neue Fassung}}',
      seriesReason: 'Namensreihe: Index oder Datum im Namen setzen ein Dokument hier fort.',
      ofPrefix: 'Fassung von',
      offer: 'Als neue Fassung von „{name}“ ablegen',
      unclearTitle: '{count, plural, one {# Datei braucht Ihre Auswahl} other {# Dateien brauchen Ihre Auswahl}}',
      unclearHint:
        'Nichts ist vorausgewählt. Wählen Sie ein Dokument oder haken Sie die Datei an, dann wird sie als neue Fassung abgelegt.',
      reasonNotNewer: 'Nicht neuer als die aktuelle Fassung „{name}“',
      reasonSeveral: 'Mehrere Dokumente kommen in Frage',
      pick: 'Dokument wählen…',
    },
    showAll: '{count, plural, one {Die Datei anzeigen} other {Alle # Dateien anzeigen}}',
    action: {
      new: 'Neu',
      fassung: 'Neue Fassung',
      unchanged: 'Unverändert',
      collision: 'Konflikt',
      duplicate: 'Schon vorhanden',
      skipped: 'Übersprungen',
      excluded: 'Nicht hochgeladen',
    },
    confirm: '{count, plural, one {# Datei hochladen} other {# Dateien hochladen}}',
    confirmWithFassungen: '{count, plural, one {# Datei hochladen} other {# Dateien hochladen}}, {fassungen} davon als neue Fassung',
    confirmMoveOnly: '{count, plural, one {# Dokument verschieben} other {# Dokumente verschieben}}',
    nothingToDo: 'Nichts hochzuladen',
    cancel: 'Abbrechen',
    done: '{uploaded, plural, one {# Datei hochgeladen} other {# Dateien hochgeladen}}, {skipped} unverändert.',
    doneMoved: '{uploaded, plural, one {# Datei hochgeladen} other {# Dateien hochgeladen}}, {skipped} unverändert, {moved} verschoben.',
    foldersError: 'Die Ordner für diesen Upload konnten nicht angelegt werden. Es wurde nichts hochgeladen.',
    applyError: 'Dieser Ordner konnte nicht vollständig hochgeladen werden. Prüfen Sie die Liste und versuchen Sie es erneut.',
  },
  mailImport: {
    action: 'Outlook-Archiv importieren',
    title: 'Outlook-Archiv importieren',
    description:
      'Wählen Sie eine .pst- oder .ost-Datei. Jede E-Mail wird ein Ordner unter „E-Mail-Import“ mit ihren Anhängen und einer Notiz mit Text und Kopfzeilen.',
    privacy:
      'Ein Outlook-Archiv enthält die Korrespondenz aller, die diesem Postfach geschrieben haben. Importieren Sie, was das Projekt braucht, nicht ein ganzes Postfach.',
    choose: 'Outlook-Archiv auswählen…',
    maxSize: 'Bis {size}.',
    // Nur für Touch: ein Archiv dieser Größe sendet man vom Schreibtisch, mit stabiler Leitung.
    desktopHint: 'Große Archive lassen sich am Schreibtisch am besten senden. Bricht die Verbindung ab, wählen Sie dieselbe Datei erneut und es geht dort weiter.',
    notAnArchive: '„{name}“ ist kein Outlook-Archiv (.pst oder .ost).',
    tooLarge: '„{name}“ ist größer als {size}.',
    sending: '{sent} von {total} gesendet…',
    sendingHint:
      'Sie können in Piloti inzwischen weiterarbeiten; lassen Sie nur diesen Tab offen, bis das Outlook-Archiv gesendet ist. Das Ablegen läuft danach im Hintergrund.',
    sendingLabel: '„{name}“ wird gesendet',
    joining: 'Gesendet. Piloti setzt das Outlook-Archiv zusammen…',
    sendErrors: {
      busy: 'Dieser Tab sendet noch ein anderes Outlook-Archiv. Warten Sie, bis es gesendet ist, und wählen Sie dann dieses.',
      alreadyRunning: 'Ein Import von Ihnen läuft in diesem Projekt noch. Setzen Sie ihn zuerst fort oder brechen Sie ihn ab.',
      cancelled: 'Der Import wurde abgebrochen, während er gesendet wurde.',
      quota: 'Der Speicher der Organisation ist voll, daher kann das Outlook-Archiv nicht importiert werden.',
      forbidden: 'Sie dürfen diesem Projekt keine Dokumente hinzufügen.',
      rejected: 'Piloti hat dieses Outlook-Archiv nicht angenommen. Prüfen Sie, ob es eine Outlook-.pst- oder -.ost-Datei ist.',
      connection:
        'Die Verbindung ist abgebrochen. Wählen Sie die Datei mit „Weiter senden“ erneut, um dort fortzusetzen, wo es aufgehört hat.',
      unknown: 'Das Outlook-Archiv konnte nicht gesendet werden. Versuchen Sie es mit „Weiter senden“ erneut.',
    },
    resume: 'Weiter senden',
    resumeNamed: '„{name}“ weiter senden',
    resumeHint: 'Wählen Sie „{name}“ erneut, um dort weiterzusenden, wo es abgebrochen ist.',
    resumeMismatch: 'Das ist nicht dieselbe Datei. Wählen Sie „{name}“ ({size}).',
    resumeChanged:
      '„{name}“ hat sich geändert, seit das Senden begonnen hat, daher passen seine Teile nicht mehr zusammen. Brechen Sie diesen Import ab und starten Sie einen neuen.',
    cancel: 'Abbrechen',
    cancelNamed: 'Import von „{name}“ abbrechen',
    cancelConfirm: {
      title: 'Diesen Import abbrechen?',
      description:
        'Was bisher abgelegt wurde, bleibt. Das Outlook-Archiv wird aus Piloti gelöscht; für den Rest müsste „{name}“ erneut gesendet werden.',
      confirm: 'Import abbrechen',
      keep: 'Weiter importieren',
    },
    cancelError: 'Der Import konnte nicht abgebrochen werden.',
    close: 'Schließen',
    history: 'Importe in diesem Projekt',
    empty: 'In dieses Projekt wurde noch kein Outlook-Archiv importiert.',
    loadError: 'Die Importe konnten nicht geladen werden.',
    openFolder: 'Ordner öffnen',
    openFolderNamed: 'Ordner von „{name}“ öffnen',
    importingLabel: '„{name}“ wird importiert',
    startedBy: 'Gestartet von {email}',
    progress: '{done} von {total} Einträgen',
    filed: '{mails, plural, one {# E-Mail} other {# E-Mails}}, {files, plural, one {# Anhang} other {# Anhänge}}',
    skipped: '{count, plural, one {# übersprungen} other {# übersprungen}}',
    skippedItem: '{file} in {mail}: {reason}',
    skippedMail: '{mail}: {reason}',
    status: {
      uploading: 'Wird gesendet',
      queued: 'Wartet',
      importing: 'Wird importiert',
      completed: 'Importiert',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
    errors: {
      unreadable: 'Die Datei konnte nicht als Outlook-Archiv gelesen werden. Exportieren Sie sie in Outlook erneut als .pst-Datei.',
      quota: 'Der Speicher der Organisation ist voll. Was bis dahin importiert war, bleibt.',
      access: 'Wer den Import gestartet hat, darf in diesem Projekt oder im Ordner „E-Mail-Import“ keine Dokumente ablegen.',
      requester_left: 'Wer den Import gestartet hat, ist nicht mehr Mitglied der Organisation.',
      stopped: 'Der Import wurde nach wiederholten Fehlern abgebrochen.',
      stalled: 'Der Import ist stehen geblieben, ohne fertig zu werden.',
      upload_expired: 'Das Outlook-Archiv wurde nicht innerhalb von zwei Tagen vollständig gesendet.',
    },
    reasons: {
      embedded_message: 'angehängte E-Mail',
      type: 'Dateityp nicht zugelassen',
      size: 'zu groß',
      unreadable: 'im Outlook-Archiv beschädigt',
      screened: 'von der Namensprüfung nicht hochgeladen',
      access: 'Ordner nur lesbar',
      name_taken: 'Name im Projekt schon vergeben',
    },
  },
  upload: {
    uploading: 'Wird hochgeladen …',
    upload: 'Hochladen',
    uploadFolder: 'Ordner hochladen',
    uploadFiles: 'Dateien auswählen',
  },
  errors: {
    projectClosed: 'Dieses Projekt ist abgeschlossen und schreibgeschützt. Wer es verwaltet, kann es oben im Hinweis oder in der Übersicht wieder öffnen.',
    // Die Meldungen des Transports sind englisch und für Logs; der Mensch auf der
    // Baustelle liest diese. Fehlschlag ohne Antwort (Netz, Stillstand, Zeit) ist
    // wiederholbar, die Zeile bietet es an.
    uploadFailed: 'Das Hochladen ist fehlgeschlagen.',
    uploadNetwork: 'Keine Verbindung beim Hochladen. Bitte erneut versuchen.',
    uploadStalled: 'Die Verbindung hat nichts mehr übertragen, das Hochladen wurde abgebrochen.',
    uploadTimeout: 'Das Hochladen hat zu lange gedauert.',
    // Von der Namensprüfung nicht hochgeladen (ADR-0086): auf einem Weg ohne
    // Upload-Dialog, etwa im Chat, oder als Nachprüfung des Servers.
    screenedOut: '{count} Datei(en) nicht hochgeladen, weil Ihr Büro sie als sensibel einstuft: {files}',
    screenedOutFile: '„{name}“ ({reason})',
    // Die Liste des Büros ist nicht lesbar: ohne sie wird nichts gesendet,
    // auch nicht mit Pilotis Vorschlag (ADR-0086).
    screeningPolicyUnavailable:
      'Die Liste sensibler Daten Ihres Büros konnte nicht geladen werden. Es wurde nichts hochgeladen. Versuchen Sie es erneut.',
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
    // Die Datei, die dieser Upload ersetzen würde, ist zurückgehalten
    // (Inhaltsprüfung, ADR-0086). Zustand „zurückgehalten“, Ort „Quarantäne“.
    quarantinedReplace:
      '„{name}“ würde eine Datei ersetzen, die zurückgehalten ist und in der Quarantäne auf ihre Prüfung wartet. Sobald jemand sie zulässt oder löscht, können Sie die neue hochladen.',
    // Den Namen trägt schon ein anderes Dokument. Absichtlich ohne Ort und ohne
    // Grund: Es kann eines sein, das diese Person nicht sehen darf.
    nameTaken: 'Den Namen „{name}“ trägt schon ein anderes Dokument. Benennen Sie die Datei um und laden Sie sie erneut hoch.',
    // Während des Hochladens hat jemand dieselbe Datei abgelegt oder gelöscht.
    uploadChangedMeanwhile: 'Während des Hochladens hat sich hier etwas geändert. Versuchen Sie es erneut.',
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
  // Der Ordnerbrief: was Piloti über einen Ordner und alles darunter weiß.
  brief: {
    scopeFolder: 'in „{name}“ und seinen Unterordnern',
    scopeProject: 'in diesem Projekt',
    scopeOffice: 'in der Büroablage',
    headlineAll: '{count, plural, one {Das Dokument ist gelesen} other {Alle # Dokumente gelesen}}',
    headlineSome: '{readable} von {count, plural, one {# Dokument} other {# Dokumenten}} gelesen',
    headlineNone: '{count, plural, one {Das Dokument ist noch nicht gelesen} other {Noch keines der # Dokumente gelesen}}',
    headlineNothingToRead: '{count, plural, one {# Dokument, nicht in der Wissensbasis} other {# Dokumente, keines in der Wissensbasis}}',
    states: {
      readable: '{count} gelesen',
      reading: '{count, plural, one {# wird gelesen} other {# werden gelesen}}',
      failed: '{count} fehlgeschlagen',
      held: '{count} zurückgehalten',
      unindexed: '{count} nicht in der Wissensbasis',
    },
    allRead: 'Alles gelesen',
    unplacedShort: '{count} ohne Dokumentart',
    /** Neben der Legende: Dokumente, die Piloti nie liest. Nicht in der Summe der Überschrift („von N“). */
    unindexedAside: 'dazu {count} nicht in der Wissensbasis',
    /** Laufende Beschriftung der beiden Chip-Familien unter „Worum es hier geht“. */
    typesLabel: 'Dokumentart',
    disciplinesLabel: 'Fachbereich',
    /** Zugänglicher Name der „Anzeigen“-Schaltflächen: drei gleichlautende Knöpfe sind drei verschiedene Dinge. */
    showFailed: '{count, plural, one {Das fehlgeschlagene Dokument anzeigen} other {Die # fehlgeschlagenen Dokumente anzeigen}}',
    showHeld: '{count, plural, one {Das zurückgehaltene Dokument anzeigen} other {Die # zurückgehaltenen Dokumente anzeigen}}',
    showUnplaced: '{count, plural, one {Das Dokument ohne Dokumentart anzeigen} other {Die # Dokumente ohne Dokumentart anzeigen}}',
    showState: 'Dokumente „{state}“ in allen Unterordnern zeigen',
    showTag: 'Alle Dokumente „{tag}“ in diesem Ordner und seinen Unterordnern zeigen',
    pages: '{count, plural, one {{formatted} Seite gelesen} other {{formatted} Seiten gelesen}}',
    aboutTitle: 'Worum es hier geht',
    noTypes: 'Piloti hat hier noch keine Dokumentart erkannt.',
    /** „Worum es hier geht“, solange nur die Zahlen des Ordners geladen sind (ADR-0102). */
    aboutDeferred: 'Dokumentarten, Fachbereiche und Themen',
    aboutDeferredHint:
      'Was Piloti in den Dokumenten erkannt hat, steht bei jedem Dokument. Für einen großen Ordner wird es erst geladen, wenn Sie es ansehen wollen.',
    loadDetails: 'Laden',
    loadingDetails: 'Wird geladen …',
    contains: 'Enthält {list}',
    needsTitle: 'Hier sind Sie gefragt',
    failedLine: '{count, plural, one {Piloti konnte # Dokument nicht lesen.} other {Piloti konnte # Dokumente nicht lesen.}}',
    readAgainAll: '{count, plural, one {Erneut lesen} other {Alle # erneut lesen}}',
    readAgainProgress: '{done} von {count} gestartet…',
    readAgainDone: '{count, plural, one {# Dokument wird neu gelesen} other {# Dokumente werden neu gelesen}}',
    readAgainPartial: '{count, plural, one {# Dokument ließ sich nicht neu starten} other {# Dokumente ließen sich nicht neu starten}}',
    heldLine:
      '{count, plural, one {# Dokument wird von der Inhaltsprüfung zurückgehalten, bis es jemand prüft.} other {# Dokumente werden von der Inhaltsprüfung zurückgehalten, bis sie jemand prüft.}}',
    unplacedLine:
      '{count, plural, one {Piloti konnte # Dokument keiner Dokumentart zuordnen.} other {Piloti konnte # Dokumente keiner Dokumentart zuordnen.}}',
    unplacedHint:
      'Sie müssen nichts eintragen, Piloti ordnet selbst ein. Bei diesen hilft nur Ihre Angabe: Öffnen Sie das Dokument und wählen Sie „Zuordnen“.',
    show: 'Anzeigen',
    missingTitle: 'Was Piloti noch fehlt',
    missingLead: 'Nach den Projektangaben erwartet Piloti diese Unterlagen und kennt sie noch nicht:',
    missingMore: '+{count} weitere',
    missingHint:
      'Liegt eine davon schon hier, weiß Piloti nur nicht, welche Datei es ist, und meldet sie in Antworten als fehlend. Gelesen heißt nicht, dass Piloti sie einer Rolle des Projekts zuordnen kann.',
    topicsTitle: 'Themen, die Piloti erkannt hat',
    photos: '{count, plural, one {# Foto} other {# Fotos}} vom {span}',
    whereTitle: 'Wo es hakt',
    expand: 'Ausklappen',
    collapse: 'Einklappen',
    slice: {
      readable: 'Gelesen',
      reading: 'Wird gelesen',
      failed: 'Fehlgeschlagen',
      held: 'Zurückgehalten',
      unindexed: 'Nicht in der Wissensbasis',
      unplaced: 'Ohne Dokumentart',
      photos: 'Fotos mit Aufnahmedatum',
    },
    sliceScopeFolder: '„{name}“ und Unterordner',
    sliceScopeRoot: 'alle Ordner',
    sliceClear: 'Zurück zum Ordner',
    sliceEmpty: 'Hier liegt nichts mehr vor.',
  },
  /** Die Anzahl auf Karte und Zeile, wenn ein Dokument Fassungen unter anderen Dateinamen hat (ADR-0099). */
  fassungBadge: {
    count: '{count, plural, one {# Fassung} other {# Fassungen}}',
    countTitle: '{count, plural, one {# Fassung dieses Dokuments} other {# Fassungen dieses Dokuments}}',
    older: 'Ältere Fassung',
    /** Tooltip der älteren Fassung: was sie ersetzt hat. {name} ist der Dateiname der neueren. */
    olderTitle: 'Ersetzt durch „{name}“',
  },
  /** Visueller Vergleich zweier Fassungen: nebeneinander, überlagert, gewischt (fassung-compare/). */
  compare: {
    title: 'Fassungen vergleichen',
    olderLabel: 'Älter',
    newerLabel: 'Neuer',
    close: 'Schließen',
    viewMode: 'Ansicht',
    modeSide: 'Nebeneinander',
    modeOverlay: 'Überlagert',
    modeSwipe: 'Wischen',
    legendOlder: 'Älter (Cyan)',
    legendNewer: 'Neuer (Orange)',
    legendLabel: 'Farblegende',
    legendUnchanged: 'Unverändert (dunkel)',
    captionOlder: 'Ältere Fassung',
    captionNewer: 'Neuere Fassung',
    paneOlder: 'Ältere Fassung: {name}',
    paneNewer: 'Neuere Fassung: {name}',
    pageOf: 'Seite {n} von {m}',
    pageOfTotal: 'von {m}',
    pageInput: 'Seite, {m} insgesamt',
    pageNavigation: 'Seite',
    previousPage: 'Vorherige Seite',
    nextPage: 'Nächste Seite',
    pageCountDiffers: 'Diese Fassungen unterscheiden sich in der Seitenzahl: {older} gegenüber {newer}.',
    pageMissing: 'Diese Fassung hat keine Seite {n}.',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    zoomLabel: 'Zoom',
    zoomFit: 'Einpassen',
    zoomPercent: '{percent} %',
    zoomFitActive: 'Ganze Seite eingepasst',
    zoomFitAction: '{percent} % der eingepassten Größe. Ganze Seite einpassen',
    zoomHint: 'Strg + Mausrad oder zwei Finger zoomen, ziehen verschiebt',
    opacity: 'Neuere Fassung einblenden',
    opacityValue: '{percent} %',
    swipeDivider: 'Trennlinie zwischen älterer und neuerer Fassung',
    swipeValue: '{percent} % ältere Fassung',
    swipeHint: 'Ziehen oder mit ← → verschieben, Doppelklick setzt auf die Mitte',
    keysHint: 'Pfeiltasten wechseln die Seite, 1, 2 und 3 die Ansicht, Esc schließt den Vergleich.',
    keysHintVisible: '← → Seite wechseln · 1 2 3 Ansicht · Esc schließen',
    loading: 'Die Seiten werden geladen…',
    failedFile: 'Die Seiten von {name} konnten nicht geladen werden.',
    failedBoth: 'Die Seiten beider Fassungen konnten nicht geladen werden.',
    failedDescription: 'Oft war nur die Verbindung kurz weg. Hilft ein zweiter Versuch nicht, öffnen Sie die Datei einzeln.',
    retry: 'Erneut versuchen',
    notComparableTitle: 'Diese Dateien lassen sich nicht visuell vergleichen',
    notComparableDescription:
      'Nur Seiten und Bilder können übereinandergelegt werden. Der Textvergleich im Fassungsverlauf zeigt, was sich im Wortlaut geändert hat.',
    openTextCompare: 'Textvergleich öffnen',
    backToHistory: 'Zum Fassungsverlauf',
    changesRegion: 'Änderungen',
    changesHeading: 'Änderungen ({count})',
    pageGroup: 'Seite {page}',
    pageGroupShown: 'angezeigt',
    changeShow: 'Änderung {number}: {label}. Auf der Seite zeigen.',
    changeTag: 'Änderung {number}: {label}',
    markPage: 'Seite {page} mit Piloti vergleichen',
    markingPage: 'Piloti vergleicht Seite {page}…',
    markedPage: 'Seite {page} ist markiert',
    markPageMissing: 'Seite {page} gibt es nur in einer Fassung',
    markSlow: 'Das dauert meist einige Sekunden.',
    caveat: 'Von Piloti markiert. Prüfen Sie Maße am Dokument.',
    markNotRead: 'Diese Fassung wird noch gelesen. Sobald sie zitierbar ist, können Sie den Vergleich starten.',
    markUnavailable: 'Piloti ist gerade nicht erreichbar. Versuchen Sie es in einer Minute erneut.',
    markFailed: 'Der Vergleich ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
  },
  filters: {
    label: 'Filter',
    labelActive: 'Filter ({count} aktiv)',
    reset: 'Filter zurücksetzen',
    // Die beiden Schalter, die ERWEITERN: Stillgelegte stehen gar nicht erst in
    // der Liste, ältere Fassungen sind ein Eintrag mit der aktuellen (ADR-0099).
    // Gleich formuliert und unter einer Überschrift, damit keiner als
    // Einschränkung gelesen wird.
    alsoShowLabel: 'Auch zeigen',
    alsoShow: {
      retired: 'Stillgelegte',
      olderFassungen: 'Ältere Fassungen',
    },
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
      processing: 'Wird gelesen',
      ready: 'Zitierbar',
    },
    originLabel: 'Herkunft und Freigabe',
    tagLabel: 'Kategorie',
    kindLabel: 'Dateityp',
    kind: {
      floorplan: 'Grundriss',
      section: 'Schnitt / Ansicht',
      siteplan: 'Lageplan',
      notice: 'Bescheid',
      photo: 'Foto',
      model: '3D-Modell (IFC)',
      sheet: 'Tabellendatei',
      text: 'Text / Notiz',
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
  lifecycle: {
    title: 'Fassungen und Freigabe',
    badgeTitle: 'Freigabestatus: {state}',
    filter: 'Freigabe ausstehend',
    states: {
      draft: 'Entwurf',
      inReview: 'In Prüfung',
      changesRequested: 'Änderungen angefordert',
      approved: 'Freigegeben',
      published: 'Veröffentlicht',
      rejected: 'Abgelehnt',
      superseded: 'Ersetzt',
      // NICHT „Archiviert“. Die Büroablage (früher „Archiv“) ist der Ort, an
      // den man eine Datei legt, DAMIT sie projektübergreifendes Bürowissen
      // wird. Dieser Zustand ist das Gegenteil: Die Datei verlässt den
      // Arbeitsstand, und ihre Einträge in der Wissensbasis werden gelöscht.
      // Ein Wort für beides hieße, dasselbe Verb für eine Sache und ihr
      // Gegenteil zu verwenden. Der Spaltenwert heißt weiter `archived` —
      // das ist Draht und Datenbank, nicht Sprache der Leserin.
      archived: 'Stillgelegt',
    },
    actions: {
      submit: 'Zur Freigabe einreichen',
      approve: 'Freigeben',
      requestChanges: 'Änderungen anfordern',
      // Dieselbe Entscheidung wie „Änderungen anfordern“, mit einem Zusatz:
      // Piloti übernimmt die Überarbeitung. Deshalb steht der Knopf daneben und
      // verlangt dieselbe Begründung.
      delegateRevision: 'Piloti überarbeiten lassen',
      reject: 'Ablehnen',
      publish: 'Veröffentlichen',
      archive: 'Stilllegen',
      // Der ⋯ neben „Änderungen anfordern“: „Piloti überarbeiten lassen“ und „Ablehnen“.
      more: 'Weitere Entscheidungen',
    },
    // Wer die Fassung freigeben soll. „Alle Bearbeiter“ ist der Normalfall und
    // deshalb die Vorauswahl: Eine unvergebene Fassung geht an alle, die sie
    // freigeben dürfen — wer zuerst hinsieht, entscheidet.
    reviewer: {
      every: 'Alle Bearbeiter',
    },
    // Die Einreichung zur Freigabe ist ein haftungsnaher Akt: Wer einreicht,
    // benennt eine Prüferin oder einen Prüfer und formuliert den Auftrag in
    // einem Satz. Beides verriegelt den Knopf — ein deaktivierter Knopf mit
    // Begründung, nie eine stille Verweigerung oder eine offene Runde, von der
    // niemand erfahren hat.
    submit: {
      reviewerLabel: 'Prüferin oder Prüfer',
      reviewerPlaceholder: 'Bitte wählen',
      orderLabel: 'Auftrag an die Prüfung',
      orderPlaceholder: 'In einem Satz: Was soll geprüft werden?',
      dueLabel: 'Frist (optional)',
      needReviewer: 'Bitte wählen Sie, wer prüfen soll.',
      needOrder: 'Bitte formulieren Sie den Auftrag in einem Satz.',
      selfReviewNote:
        'Keine weiteren Bearbeiter – die Freigabe wird als Selbstprüfung festgehalten.',
    },
    // Die Freigabe ist die Behauptung des Büros über den Inhalt, deshalb ist
    // sie nie ein Klick: Der Akt nennt seinen Geltungsstand (Fassung und
    // Datum), die handelnde Person und den Zeitpunkt, und die Checkbox ist die
    // Unterschrift.
    approveConfirm: {
      stand: 'Fassung {number} · Stand vom {date}',
      actingWithName: 'Handelnd: {name} · {date}',
      actingDateOnly: 'Handelnd: {date}',
      checkbox: 'Ich gebe diese Fassung frei',
    },
    // Die Veröffentlichung ist ein eigener Akt im eigenen Abschnitt — nie ein
    // Knopf neben der Freigabe. Die Freigabe behauptet den Inhalt, die
    // Veröffentlichung macht die Fassung zu der, aus der Piloti antwortet:
    // Nur eine veröffentlichte Fassung wird in die Wissensbasis gelesen (ADR-0054).
    publishSection: {
      heading: 'Veröffentlichung',
      blurb: 'Veröffentlichen macht Fassung {number} zu der Fassung, aus der Piloti antwortet.',
    },
    // Archivieren ist der einzige Akt in diesem Abschnitt, der sich im Haus
    // nicht zurücknehmen lässt: Die Einträge in der Wissensbasis werden
    // gelöscht, und es gibt keine Route, die sie zurückholt. Deshalb steht er
    // abgesetzt und nennt seine Folgen, bevor er ausgeführt wird — nie als
    // fünfter Knopf in einer Reihe von Prüfentscheidungen.
    archiveSection: {
      heading: 'Aus der Dateiliste nehmen',
      blurb:
        'Stilllegen nimmt die Datei aus der Dateiliste und aus der Wissensbasis. Gelöscht wird nichts.',
      confirmTitle: 'Diese Datei stilllegen?',
      confirmTitleNamed: '„{filename}“ stilllegen?',
      consequences: {
        listing:
          'Die Datei verschwindet aus der Dateiliste. Über den Filter „Stillgelegte auch zeigen“ finden Sie sie wieder.',
        knowledge:
          'Piloti zitiert sie nicht mehr: Die Einträge in der Wissensbasis werden entfernt.',
        kept: 'Die Datei und alle Fassungen bleiben erhalten. Das ist kein Löschen.',
        permanent: 'Rückgängig machen lässt sich das hier nicht.',
      },
    },
    // Was ein Stand für die Leserin bedeutet, in einem Satz. Die Stände selbst
    // („In Prüfung“, „Freigegeben“) kennt nur, wer weiß, was sie ändern, und
    // geändert wird genau eines: ob Piloti aus dieser Fassung antwortet. Nur eine
    // veröffentlichte Fassung wird in die Wissensbasis gelesen (ADR-0054); steht
    // keine hinter der neuesten, kann der Satz nicht auf sie verweisen („Alone“).
    meaning: {
      draftLive: 'Entwurf einer neuen Fassung. Piloti antwortet weiter aus der veröffentlichten Fassung.',
      draftAlone: 'Entwurf. Piloti antwortet erst daraus, wenn sie freigegeben ist.',
      inReviewLive: 'Wartet auf Freigabe. Piloti antwortet aus der veröffentlichten Fassung.',
      inReviewAlone: 'Wartet auf Freigabe. Bis dahin antwortet Piloti nicht daraus.',
      changesRequestedLive:
        'Änderungen angefordert. Piloti antwortet aus der veröffentlichten Fassung, bis die überarbeitete freigegeben ist.',
      changesRequestedAlone:
        'Änderungen angefordert. Piloti antwortet erst aus der überarbeiteten Fassung, wenn sie freigegeben ist.',
      approvedLive:
        'Freigegeben, wartet auf Veröffentlichung. Bis dahin antwortet Piloti aus der veröffentlichten Fassung.',
      approvedAlone: 'Freigegeben, wartet auf Veröffentlichung. Erst danach antwortet Piloti daraus.',
      published: 'Piloti antwortet aus dieser Fassung.',
      rejectedLive: 'Abgelehnt. Piloti antwortet aus der veröffentlichten Fassung.',
      rejectedAlone: 'Abgelehnt. Piloti antwortet nicht daraus.',
      superseded: 'Durch eine neuere Fassung ersetzt.',
      // NICHT „archiviert“: siehe `states.archived`.
      archived: 'Stillgelegt. Nicht mehr in der Dateiliste, Piloti zitiert sie nicht mehr.',
      none: 'Noch keine Fassung.',
      olderFassung: 'Ältere Fassung. Piloti antwortet aus der neueren.',
    },
    comment: {
      reasonLabel: 'Grund der Ablehnung',
      changesLabel: 'Was geändert werden soll',
      delegateNote:
        'Piloti schreibt daraufhin die nächste Fassung und legt sie zur Freigabe vor.',
      placeholder: 'Die nächste Fassung liest das hier.',
      cancel: 'Abbrechen',
    },
    versions: {
      number: 'Fassung {number}',
      comparing: 'Beide Fassungen werden geladen…',
      compareFailed: 'Die beiden Fassungen konnten nicht geladen werden.',
      diff: {
        heading: 'Was sich geändert hat',
        between: 'Fassung {from} → Fassung {to}',
        added: '{count, plural, one {# Zeile hinzugefügt} other {# Zeilen hinzugefügt}}',
        removed: '{count, plural, one {# Zeile entfernt} other {# Zeilen entfernt}}',
        gap: '{count, plural, one {# Zeile unverändert} other {# Zeilen unverändert}}',
        identical: 'Die beiden Fassungen sind Zeile für Zeile identisch.',
        truncated: 'Der Vergleich ist lang – gezeigt werden die ersten {count} Zeilen.',
        addedLine: 'hinzugefügt',
        removedLine: 'entfernt',
      },
      uploaded: 'Hochgeladen',
      created: 'Erstellt',
      submitted: 'Eingereicht',
      approved: 'Freigegeben',
      published: 'Veröffentlicht',
      // Auch eine Zurückweisung hinterlässt einen Meilenstein: Eine
      // zurückgeschickte Fassung muss nennen, wer sie wann geschickt hat,
      // sonst ist die Ablehnung in der Geschichte unsichtbar.
      changesRequested: 'Änderungen angefordert',
      rejected: 'Abgelehnt',
      byAt: 'von {name}, {time}',
      you: 'Ihnen',
      someone: 'jemandem',
    },
    errors: {
      conflict: 'Jemand hat zuerst entschieden – die aktuelle Fassung wird geladen.',
      held: 'Die Datei wird noch geprüft. Einreichen können Sie sie, sobald die Prüfung abgeschlossen ist.',
      actionFailed: 'Das hat nicht geklappt. Es hat sich nichts geändert.',
      loadFailed: 'Die Fassungen konnten nicht geladen werden.',
    },
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
    // EIN Wort für eine Geste, an allen drei Stellen: Dateiablage, Berichtskarte
    // und Posteingang. Vorher hieß derselbe Knopf „Piloti dazu fragen“ und war
    // ausgerechnet bei Entwürfen ausgegraut — genau den Dokumenten, über die man
    // sprechen will. Piloti kann jetzt auch eine unveröffentlichte Fassung lesen.
    // „Besprechen“ allein sagte nicht, MIT WEM: neben „Kollegin fragen“ las es
    // sich wie eine Besprechung im Team. Der Name steht deshalb im Knopf.
    discuss: 'Mit Piloti besprechen',
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
      'Piloti sucht in dieser Unterlage. Andere Projektakten und die Büroablage bleiben außen vor.',
    subjectClear: 'Nicht mehr auf diese Datei beschränken',
    loadingPeople: 'Personen werden geladen…',
    noPeople: 'Noch niemand in diesem Projekt',
    peopleLoadError: 'Personen konnten nicht geladen werden',
    assignError: '„{name}“ konnte nicht als zuständig eingetragen werden',
    unassignError: '„{name}“ konnte nicht entfernt werden',
    tryAgain: 'Erneut versuchen',
  },
  // Anmerkungen: Markierungen an einer Stelle einer Seite, ein Punkt oder ein
  // Bereich, mit dem, was dort zu tun ist (CONTEXT.md „Anmerkung“).
  annotations: {
    section: 'Anmerkungen',
    openCount: '{count} offen',
    kind: 'Art',
    kinds: {
      hint: 'Hinweis',
      question: 'Rückfrage',
      defect: 'Mangel',
    },
    cancel: 'Abbrechen',
    earlierFassung: 'auf Fassung {number} gesetzt',
    earlierFassungUnnumbered: 'auf einer früheren Fassung gesetzt',
    earlierFassungHint:
      'Gesetzt, bevor die aktuelle Fassung kam. Die Stelle kann sich verschoben haben, darum ist sie nicht eingezeichnet.',
    loadError: 'Anmerkungen konnten nicht geladen werden.',
    retry: 'Erneut versuchen',
  },
  // Die Prüfansicht: ein Dokument im Vollbild, die Anmerkungen darauf, die
  // Gespräche darunter, und wer gerade mit hinschaut.
  review: {
    open: 'Prüfansicht öffnen',
    openAll: 'Alle {count} in der Prüfansicht',
    othersHere: '{count, plural, one {# weitere Person sieht sich das gerade an} other {# weitere Personen sehen sich das gerade an}}',
    close: 'Prüfansicht schließen',
    nothingOpen: 'Nichts offen',
    fassung: 'Fassung {number}',
    offline: 'Verbindung unterbrochen',
    toolsLabel: 'Werkzeuge',
    offlineHint: 'Gerade nicht verbunden. Anmerkungen lassen sich weiter setzen; was andere tun, erscheint beim nächsten Laden.',
    follow: '{name} folgen',
    unfollow: 'Nicht mehr {name} folgen',
    following: 'Sie folgen {name} · Esc beendet',
    pilotiWorking: 'Piloti arbeitet am Dokument',
    reviewWithPiloti: 'Piloti prüfen lassen',
    reviewSeed:
      'Dieses Dokument prüfen und die Befunde als Anmerkungen an die Stellen setzen (vorher die Seite ansehen), um die es geht: Mängel, Rückfragen an die Fachplanung, Hinweise. Bei einem Befund, der auf einer Norm beruht, die Fundstelle nennen.',
    tools: {
      select: 'Auswählen',
      point: 'Anmerkung',
      region: 'Bereich markieren',
      ask: 'Piloti fragen',
    },
    // Piloti in der Prüfansicht: ein Ausschnitt, nach dem gefragt wird, die Antwort daneben, und Piloti im Verlauf.
    piloti: {
      conversationTitle: '{name} · Prüfansicht',
      ask: 'Piloti fragen',
      mention: 'Piloti erwähnen',
      mentionHint: 'Piloti antwortet in diesem Verlauf',
      mentionRemove: 'Erwähnung entfernen',
      replying: 'Piloti antwortet …',
      replyFailed: 'Piloti konnte nicht antworten.',
      replyLater: 'Piloti antwortet später',
      wakeHeld: 'Piloti antwortet hier gerade nicht: zu viele Anfragen in kurzer Zeit.',
      delegateChip: 'Piloti arbeitet daran · für {name}',
      retry: 'Erneut fragen',
      close: 'Schließen',
      stop: 'Anhalten',
      regionLabel: 'Ausschnitt auf Seite {page}',
      placeholder: 'Was möchten Sie zu diesem Ausschnitt wissen?',
      send: 'Fragen',
      quickLabel: 'Schnelle Fragen',
      quick: {
        what: 'Was ist das?',
        dimensions: 'Maße prüfen',
        oib: 'Gegen OIB prüfen',
        question: 'Rückfrage formulieren',
      },
      quickPrompts: {
        what: 'Was ist in diesem Ausschnitt dargestellt?',
        dimensions: 'Die Maße in diesem Ausschnitt prüfen: Sind sie vollständig, schlüssig und plausibel?',
        oib: 'Diesen Ausschnitt gegen die einschlägigen OIB-Richtlinien prüfen und die Fundstelle nennen.',
        question: 'Zu diesem Ausschnitt eine präzise Rückfrage an die Fachplanung formulieren.',
      },
      busy: 'Piloti antwortet noch auf die vorige Frage.',
      // Während Piloti arbeitet, geht, was die Person ergänzt, in die laufende
      // Antwort statt als neue Frage: Piloti liest es vor dem nächsten Schritt.
      busySteer: 'Piloti arbeitet noch: Ihre Frage geht als Ergänzung in die laufende Antwort.',
      steerPlaceholder: 'Piloti lenken …',
      steerSend: 'Ergänzen',
      steerNotes: 'Ihre Ergänzungen',
      steerWaiting: 'wird berücksichtigt',
      steerApplied: 'übernommen in Runde {round}',
      thinking: 'Sieht sich den Ausschnitt an …',
      thinkingDocument: 'Geht das Dokument durch …',
      needsInput: 'Piloti hat eine Rückfrage an Sie. Sie können sie im Chat beantworten.',
      failed: 'Piloti konnte nicht antworten.',
      sources: 'Quellen',
      source: 'Quelle',
      adopt: 'Als Anmerkung übernehmen',
      adoptReply: 'In den Verlauf übernehmen',
      continueInChat: 'Im Chat fortsetzen',
      reopen: 'Antwort von Piloti öffnen',
      reviewing: 'Piloti prüft das Dokument …',
      reviewDone: 'Piloti ist fertig',
      reviewFailed: 'Prüfung fehlgeschlagen',
      openConversation: 'Gespräch',
    },
    peerPoint: 'setzt eine Anmerkung',
    peerRegion: 'markiert einen Bereich',
    // Piloti nennt auf dem Dokument, für wen es schreibt (ADR-0105; EU AI Act Art. 50).
    attribution: {
      pilotiFor: 'Piloti · für {name}',
      proposalFor: 'Vorschlag von Piloti · für {name}',
      woken: {
        thread_mention: 'Geweckt durch eine Erwähnung',
        thread_reply: 'Geweckt durch eine Antwort',
        assigned: 'Geweckt durch die Delegation',
      },
      wokenTitle: 'Geweckt durch {name} in Anmerkung {number}',
      wokenTitleNameless: 'Geweckt in Anmerkung {number}',
    },
    pinLabel: 'Anmerkung {number}: {kind}',
    page: 'Seite {page}',
    draftPlaceholder: 'Was ist hier? Enter setzt die Anmerkung',
    set: 'Setzen',
    replyPlaceholder: 'Antworten …',
    send: 'Senden',
    sendFailed: 'Konnte nicht gesendet werden. Der Text ist noch da.',
    actionFailed: 'Das hat nicht geklappt. Bitte noch einmal.',
    conflict: 'Jemand hat diese Anmerkung gerade geändert. Sie sehen jetzt den aktuellen Stand.',
    someone: 'Unbekannt',
    assign: 'Zuständig',
    unassign: 'Zuständigkeit entfernen',
    due: 'Frist',
    setDue: 'Frist',
    overdue: 'überfällig',
    proposal: 'Vorschlag',
    proposalHint: 'Von Piloti vorgeschlagen. Zählt erst, wenn jemand ihn übernimmt.',
    accept: 'Übernehmen',
    dismiss: 'Verwerfen',
    resolve: 'Erledigt',
    reopen: 'Wieder öffnen',
    resolved: 'Erledigt',
    dismissed: 'Verworfen',
    more: 'Mehr',
    closeThread: 'Schließen',
    makeKind: 'Als {kind} führen',
    askPiloti: 'Piloti dazu fragen',
    delegateToPiloti: 'An Piloti delegieren',
    takeBackFromPiloti: 'Von Piloti zurücknehmen',
    copyLink: 'Link kopieren',
    linkCopied: 'Link kopiert',
    delete: 'Löschen',
    deleteConfirm: 'Anmerkung {number} löschen?',
    filter: 'Anzeigen',
    filters: {
      open: 'Offen',
      closed: 'Erledigt',
    },
    mine: 'Mir zugewiesen',
    proposalsGroup: '{count, plural, one {# Vorschlag von Piloti} other {# Vorschläge von Piloti}}',
    walkProposals: 'Durchgehen',
    empty: {
      noneTitle: 'Noch keine Anmerkungen',
      noneBody: 'Drücken Sie C und klicken Sie auf die Stelle, um die es geht, oder R und ziehen Sie einen Bereich auf.',
      readOnlyTitle: 'Noch keine Anmerkungen',
      readOnlyBody: 'Hier hat noch niemand etwas angemerkt.',
      mineTitle: 'Nichts für Sie',
      mineBody: 'Ihnen ist hier nichts zugewiesen, und Sie haben nichts Offenes gesetzt.',
      doneTitle: 'Alles erledigt',
      doneBody: 'Auf diesem Dokument ist nichts mehr offen.',
      openTitle: 'Nichts offen',
      openBody: 'Alle Anmerkungen sind erledigt oder verworfen.',
      closedTitle: 'Noch nichts erledigt',
      closedBody: 'Was erledigt oder verworfen ist, sammelt sich hier.',
    },
    // Die Anmerkungen als Protokoll, für den Jour fixe oder an Bauherrschaft und
    // Fachplanung: das Menü in der Prüfansicht und die Wörter in der Datei selbst.
    export: {
      button: 'Protokoll exportieren',
      scopeLabel: 'Welche Anmerkungen',
      scopes: {
        open: 'Nur offene',
        all: 'Alle, auch erledigte',
      },
      fassungLabel: 'Fassung',
      fassungen: {
        current: 'Aktuelle Fassung',
        all: 'Alle Fassungen',
      },
      includeProposals: 'Vorschläge von Piloti anhängen',
      formatLabel: 'Herunterladen als',
      formats: {
        pdf: 'PDF',
        docx: 'Word (.docx)',
        md: 'Markdown',
      },
      failed: 'Das Protokoll konnte nicht exportiert werden.',
      tooLongForPdf: 'Zu umfangreich für ein PDF. Bitte als Word oder Markdown exportieren.',
      document: {
        title: 'Anmerkungen – {name}',
        fileName: 'Anmerkungen – {name}',
        fileNameFassung: 'Anmerkungen – {name} – Fassung {number}',
        fileNameAll: 'Anmerkungen – {name} – alle Fassungen',
        document: 'Dokument',
        fassung: 'Fassung',
        fassungOf: 'Fassung {number} von {total} · Stand vom {date}',
        project: 'Projekt',
        scope: 'Umfang',
        scopes: {
          open: 'Offene Anmerkungen',
          all: 'Alle Anmerkungen, auch erledigte und verworfene',
        },
        fassungen: {
          current: 'aktuelle Fassung',
          all: 'alle Fassungen',
        },
        withProposals: 'mit Vorschlägen von Piloti',
        exportedAt: 'Exportiert am',
        exportedBy: 'Exportiert von',
        marks: 'Anmerkungen',
        none: 'Keine Anmerkungen in dieser Auswahl.',
        entry: 'Nr. {number} · Seite {page} · {kind} · {status}',
        status: {
          open: 'offen',
          resolved: 'erledigt',
          dismissed: 'verworfen',
          proposed: 'Vorschlag',
        },
        setBy: 'Gesetzt von {name} · {date}',
        pilotiSetFor: 'von Piloti gesetzt · für {name} · {date}',
        pilotiSet: 'von Piloti gesetzt · {date}',
        proposalFor: 'Vorschlag von Piloti · für {name} · {date}',
        proposal: 'Vorschlag von Piloti · {date}',
        closedResolved: 'Erledigt von {name} · {date}',
        closedDismissed: 'Verworfen von {name} · {date}',
        delegated: 'Piloti arbeitet daran · für {name}',
        basis: 'Grundlage',
        assignee: 'Zuständig',
        due: 'Termin',
        thread: 'Verlauf',
        proposals: 'Vorschläge von Piloti, nicht geprüft',
        proposalsNote:
          'Diese Stellen hat Piloti vorgeschlagen, und niemand im Büro hat sie übernommen. Sie sind keine Anmerkungen des Büros.',
      },
    },
  },
}
