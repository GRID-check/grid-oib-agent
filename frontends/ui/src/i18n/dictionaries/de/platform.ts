import type { en } from '../en'

/** Das plattformweite Dashboard des Plattform-Inhabers (ADR-0016). */
export const platform: typeof en.platform = {
  title: 'Plattform',
  subtitle: 'Organisationsübergreifende Übersicht für den Plattform-Inhaber.',
  loading: 'Plattform wird geladen…',
  loadError: 'Die Plattform-Übersicht konnte nicht geladen werden.',
  empty: {
    title: 'Hier gibt es noch nichts',
  },
  loadErrorHint: 'Beim Laden der Daten ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.',
  retry: 'Erneut versuchen',
  /**
   * Plattform → Basiswissen, neu aufgebaut auf den gemeinsamen Admin-Primitiven
   * (SectionCard + DataToolbar + Table + Sheet + Pagination). Hier steht nur die
   * Copy, die durch die neue Form dazugekommen ist; die Formulierungen, die den
   * Umbau überlebt haben — Upload, Synchronisierung, Löschen, Dokumentart,
   * Umbenennen — bleiben in `platform.knowledge`.
   */
  knowledgeAdmin: {
    // Der Upload ist jetzt eine Aktion, keine dauerhaft offene Ablagefläche.
    addDocuments: 'Dokumente hinzufügen',
    hideUpload: 'Upload ausblenden',
    // Korpus-Kennzahlen.
    summaryDocuments: 'Dokumente',
    summaryIndexed: 'Indexiert',
    summaryPending: 'Wird indexiert',
    summaryChunks: 'Indexierte Abschnitte',
    // Werkzeugleiste.
    searchLabel: 'Dokumente filtern',
    searchClear: 'Filter zurücksetzen',
    scopeLabel: 'Bereich',
    scopeAll: 'Alle Dokumente',
    // Tabelle.
    colDocument: 'Dokument',
    colType: 'Dokumentart',
    colState: 'Status',
    colChunks: 'Abschnitte',
    sortBy: 'Nach {column} sortieren',
    binding: 'Verbindlich',
    selectAll: 'Alle Dokumente auf dieser Seite auswählen',
    selectRow: '{name} auswählen',
    openDetail: 'Details zu {name} öffnen',
    range: '{from}–{to} von {total}',
    previous: 'Zurück',
    next: 'Weiter',
    // Auswahl / Sammelaktionen.
    selectedCount: '{count} ausgewählt',
    clearSelection: 'Aufheben',
    bulkReclassify: 'Dokumentart ändern',
    bulkReclassifyDone: 'Dokumentart von {count} Dokument(en) auf „{label}“ gesetzt',
    bulkReclassifyFailed: 'Dokumentart von {count} Dokument(en) konnte nicht geändert werden',
    bulkDelete: 'Entfernen',
    bulkDeleteTitle: '{count} Dokumente entfernen?',
    bulkDeleteDescription:
      'Hochgeladene Dokumente werden samt allen indexierten Inhalten gelöscht; mitgelieferte Basisdokumente werden aus dem Korpus ausgeschlossen und bei der nächsten Synchronisierung nicht erneut ingestiert. Antworten können sich auf keines davon mehr stützen.',
    bulkDeleteConfirm: '{count} Dokumente entfernen',
    bulkDeleteDone: '{count} Dokumente entfernt',
    bulkDeleteFailed: '{count} Dokumente konnten nicht entfernt werden',
    // Detailbereich.
    detailClose: 'Schließen',
    detailOrigin: 'Herkunft',
    detailChunks: 'Indexierte Abschnitte',
    detailSize: 'Größe',
    detailIngestedAt: 'Indexiert am',
    origin: {
      corpus: 'Mit dem Korpus ausgeliefert',
      uploaded: 'Hochgeladen',
      index_only: 'Nur im Index — keine Quelldatei',
    },
    // Leerzustand.
    emptyTitle: 'Noch keine Basisdokumente',
    emptyDescription:
      'Fügen Sie eine PDF hinzu oder ein ZIP mit vielen auf einmal — alle Projekte stützen ihre Antworten auf diesen Korpus.',
  },
  norms: {
    title: 'Normenkatalog',
    description:
      'Kuratierte Zitierstellen des österreichischen Baurechts, die der Agent zitiert — im Unterschied zum Basiswissen, das die Volltexte enthält, gegen die geprüft wird.',
    entryCount: '{count} Einträge.',
    entryCountOne: '1 Eintrag.',
    loadError: 'Der Normenkatalog konnte nicht geladen werden.',
    add: 'Neuer Eintrag',
    save: 'Register speichern',
    saved: 'Register gespeichert.',
    saveError: 'Das Register konnte nicht gespeichert werden.',
    invalid: 'Registry-Validierung fehlgeschlagen.',
    unsaved: 'Ungespeichert',
    federal: 'Bund',
    empty: {
      title: 'Noch keine Einträge im Katalog',
      description: 'Legen Sie die erste Zitierstelle an, die der Agent zitieren darf.',
    },
    noMatches: {
      title: 'Kein Eintrag passt zu diesen Filtern',
      description: 'Setzen Sie die Suche zurück oder wählen Sie einen anderen Rang bzw. Geltungsbereich.',
    },
    conflict: {
      title: 'Der Katalog wurde parallel geändert',
      description:
        'Während Ihrer Bearbeitung wurde eine neuere Fassung gespeichert, Ihre Änderungen wurden daher nicht übernommen. Laden Sie neu, um auf dem aktuellen Katalog weiterzuarbeiten — dabei gehen sie verloren.',
      reload: 'Verwerfen und neu laden',
      toast: 'Der Katalog wurde parallel geändert — bitte vor dem Speichern neu laden.',
    },
    search: {
      placeholder: 'Titel, Kürzel, ID durchsuchen…',
      label: 'Normeneinträge durchsuchen',
      clear: 'Suche zurücksetzen',
    },
    filters: {
      rank: 'Rang',
      allRanks: 'Alle Ränge',
      scope: 'Geltungsbereich',
      allScopes: 'Alle Geltungsbereiche',
      reviews: 'Offene Prüfungen ({count})',
    },
    ranks: {
      bundesgesetz: 'Bundesgesetz',
      landesgesetz: 'Landesgesetz',
      verordnung: 'Verordnung',
      behoerdliche_info: 'Behördliche Information (z. B. MA 37)',
      norm_extern: 'Externe Norm (ÖNORM/TRVB — kein Volltext)',
    },
    rankShort: {
      bundesgesetz: 'Bundesgesetz',
      landesgesetz: 'Landesgesetz',
      verordnung: 'Verordnung',
      behoerdliche_info: 'Behördliche Info',
      norm_extern: 'Externe Norm',
    },
    columns: {
      norm: 'Norm',
      rank: 'Rang',
      scope: 'Geltung',
      document: 'Dokument',
      verified: 'Verifiziert',
    },
    row: {
      open: '{title} bearbeiten',
      noFullText: 'kein Volltext',
      unverified: 'ungeprüft',
      staleHint: 'Verifizierung fehlt oder ist älter als 12 Monate',
      verifiedHint: 'Zuletzt verifiziert',
      review: 'Offene Prüfung',
    },
    pagination: {
      range: '{from}–{to} von {total}',
      previous: 'Zurück',
      next: 'Weiter',
    },
    sheet: {
      newTitle: 'Neuer Eintrag',
      editTitle: 'Eintrag bearbeiten',
      description: 'Änderungen gelangen erst mit dem Speichern in den Katalog.',
      close: 'Editor schließen',
      apply: 'Übernehmen',
      cancel: 'Abbrechen',
      delete: 'Löschen',
    },
    /**
     * Schritt 1 der Erfassung. Der Rang entscheidet über alles Weitere, daher
     * wird er zuerst gefragt — in Klartext, nicht in Enum-Bezeichnungen.
     */
    kinds: {
      legend: 'Um welche Art von Quelle handelt es sich?',
      hint: 'Die Art bestimmt, was der Katalog von Ihnen braucht und wo der Agent den Eintrag einordnet.',
      required: 'Wählen Sie zuerst die Art der Quelle — alles Weitere ergibt sich daraus.',
      bundesgesetz: {
        label: 'Bundesgesetz',
        description: 'Gilt österreichweit. Im RIS auffindbar.',
      },
      landesgesetz: {
        label: 'Landesgesetz (Bauordnung, Bautechnikgesetz)',
        description: 'Das Baurecht eines einzelnen Bundeslandes. Im RIS auffindbar.',
      },
      verordnung: {
        label: 'Verordnung oder Richtlinie',
        description: 'Per Verordnung verbindlich gestellt — z. B. eine OIB-Richtlinie. Im RIS auffindbar.',
      },
      behoerdliche_info: {
        label: 'Behördliche Information',
        description:
          'Vollzugshilfe einer Behörde (z. B. ein Merkblatt der MA 37). Kein Gesetz, nicht im RIS.',
      },
      norm_extern: {
        label: 'Externe Norm',
        description: 'ÖNORM, TRVB, EU-Norm — meist ohne frei zugänglichen Volltext. Nicht im RIS.',
      },
    },
    steps: {
      find: 'Norm im RIS suchen',
      findHint:
        'Suchen und Treffer übernehmen — Dokumentnummer, Links und Prüfdatum werden dabei automatisch gesetzt.',
      source: 'Titel und Quelle',
      sourceHint: 'Diese Art hat keinen RIS-Eintrag; maßgeblich ist daher der Link zur Quelle.',
      usage: 'Verwendung durch den Agenten',
      usageHint: 'Diese Felder verändern die Antworten des Agenten.',
      advanced: 'Erweitert',
      advancedHint:
        'Selten nötig. Hier bleibt jedes gespeicherte Feld bearbeitbar — auch die von der RIS-Suche befüllten.',
    },
    delete: {
      title: 'Eintrag löschen?',
      description: 'Der Eintrag verlässt den Katalog. Wirksam erst nach dem Speichern.',
      confirm: 'Löschen',
      cancel: 'Abbrechen',
    },
    fields: {
      id: 'Katalog-ID',
      idHint:
        'Dauerhafter Schlüssel des Eintrags. Wird aus dem Kürzel abgeleitet; ändern Sie ihn nur vor dem ersten Speichern.',
      idPlaceholder: 'z. B. oib-rl2-2023',
      idDerived: 'Katalog-ID: {id} — unter „Erweitert“ änderbar.',
      short: 'Kürzel (Zitierbezeichnung)',
      shortHint: 'So benennt der Agent diese Quelle in einer Antwort, z. B. „OIB-RL 2“.',
      shortPlaceholder: 'z. B. OIB-RL 2',
      title: 'Titel',
      titleHint: 'Der volle Titel, wie ihn die Quelle selbst führt.',
      titleRisHint:
        'Aus dem RIS-Treffer übernommen — kürzen Sie ihn, wenn der Fassungszusatz nicht mitzitiert werden soll.',
      titlePlaceholder: 'Voller Titel der Norm',
      rank: 'Rang',
      bundesland: 'Bundesland',
      bundeslandHint: 'Kanonischer Name (z. B. Wien) — leer lassen, wenn österreichweit gültig',
      bundeslandRequired: 'Kanonischer Name (z. B. Wien). Ohne Bundesland lässt sich ein Landesgesetz nicht einordnen.',
      bundeslandPlaceholder: 'Wien',
      application: 'RIS-Anwendung (Application)',
      applicationHint:
        'Der RIS-Bestand, in dem gesucht wird: BrKons = Bundesrecht konsolidiert, LrKons = Landesrecht konsolidiert. Wird aus der Art der Quelle vorbelegt.',
      applicationPlaceholder: 'z. B. LrKons / BrKons',
      relevance: 'Relevanz',
      relevanceHint: 'Wie stark der Agent diese Quelle gewichten soll, z. B. hoch / mittel.',
      relevancePlaceholder: 'z. B. hoch',
      topics: 'Themen',
      topicsHint: 'Kommagetrennt — bei diesen Themen greift der Agent auf den Eintrag zurück.',
      topicsPlaceholder: 'Brandschutz, Fluchtwege',
      aliases: 'Aliase',
      aliasesHint: 'Kommagetrennt — weitere Bezeichnungen, unter denen der Eintrag erkannt wird',
      aliasesPlaceholder: 'OIB 2, Richtlinie 2',
      documentNumber: 'Dokumentnummer',
      documentNumberHint:
        'Die RIS-Kennung genau dieser Fassung, z. B. NOR40251234. Wird normalerweise von der RIS-Suche befüllt.',
      documentNumberPlaceholder: 'NOR40251234',
      verifiedAt: 'Verifiziert am',
      verifiedAtHint:
        'Datum der letzten RIS-Prüfung. Wird von der Suche gesetzt — älter als 12 Monate gilt als veraltet.',
      verifiedAtPlaceholder: 'JJJJ-MM-TT',
      citationUrl: 'Zitier-Link (diese Fassung)',
      citationUrlHint:
        'Verweist auf genau diese Fassung im RIS — die Adresse, die der Agent unter ein Zitat setzt.',
      citationUrlPlaceholder: 'https://ris.bka.gv.at/Dokument.wxe?…',
      fullLawUrl: 'Volltext-Link (geltende Fassung)',
      fullLawUrlHint:
        'Verweist auf die derzeit geltende Gesamtfassung — zum Weiterlesen im Gesetz.',
      fullLawUrlPlaceholder: 'https://ris.bka.gv.at/GeltendeFassung.wxe?…',
      sourceUrl: 'Quell-Link (außerhalb des RIS)',
      sourceUrlHint:
        'Direktlink auf die Quelle selbst, z. B. ein Merkblatt der MA 37 oder eine Seite von Austrian Standards.',
      sourceUrlPlaceholder: 'https://www.wien.gv.at/…',
      urlPlaceholder: 'https://…',
      bindingNote: 'Rechtlicher Hinweis für den Agenten',
      bindingNoteBadge: 'Geht in den Prompt des Agenten ein',
      bindingNoteHint:
        'Dieser Text wird wörtlich in den Prompt des Agenten übernommen. Halten Sie hier fest, was die Volltexte nicht hergeben — etwa dass die WBTV die OIB-Richtlinien in Wien verbindlich stellt. Leer lassen, wenn nichts Besonderes gilt.',
      bindingNotePlaceholder: 'z. B. In Wien über § 118 Abs. 3 BO iVm der WBTV 2015 verbindlich gestellt.',
      reviewNote: 'Prüfnotiz',
      reviewNoteHint: 'Interne Prüfaufgabe — erscheint nie im Prompt',
      titleQuery: 'Hinterlegte RIS-Abfrage',
      titleQueryHint: 'Die Abfrage, mit der eine spätere Neuverifizierung beginnt.',
      titleQueryPlaceholder: 'RIS-Titelsuche',
      gesetzesnummer: 'Gesetzesnummer',
      gesetzesnummerHint:
        'Die RIS-interne Nummer des Gesetzes über alle Fassungen hinweg, z. B. 20001234. Grenzt mehrdeutige Titel ein.',
      gesetzesnummerPlaceholder: 'z. B. 20001234',
      expect: 'Im Titel erwartet',
      expectHint: 'Es werden nur Treffer angeboten, deren Titel diesen Text enthält.',
      exclude: 'Im Titel ausgeschlossen',
      excludeHint: 'Kommagetrennt — Treffer mit diesen Wörtern werden verworfen (z. B. Entwurf).',
      excludePlaceholder: 'kommagetrennt',
      optional: 'optional',
    },
    errors: {
      required: 'Pflichtfeld',
      duplicateId: 'Die ID „{id}“ ist bereits vergeben',
      lawNeedsRis: 'Noch kein RIS-Treffer übernommen — suchen Sie die Norm und wählen Sie eine Fassung.',
      needApplication: 'Ein Gesetz benötigt eine RIS-Anwendung',
      needDocumentNumber: 'Ein Gesetz benötigt eine Dokumentnummer aus dem RIS',
      needBundesland: 'Ein Landesgesetz benötigt das zugehörige Bundesland',
    },
    verify: {
      searchLabel: 'Titel im RIS',
      searchHint:
        'Geben Sie den Titel so ein, wie ihn das RIS führt — die passende Fassung wählen Sie danach aus den Treffern.',
      searchPlaceholder: 'z. B. Bauordnung für Wien',
      scope: 'Gesucht wird in: {application}',
      action: 'Im RIS suchen',
      candidate: '{title} übernehmen',
      missingInput: 'Für die Suche werden ein Titel und eine RIS-Anwendung benötigt',
      noHits: 'Keine RIS-Treffer gefunden',
      noCandidates: 'Keine Kandidaten',
      failed: 'RIS-Verifizierung fehlgeschlagen',
      applied: 'Kandidat übernommen',
      appliedTitle: 'Übernommen:',
      confirmedTitle: 'Aus dem RIS übernommen',
      again: 'Erneut suchen',
      stale: 'Letzte Prüfung liegt mehr als 12 Monate zurück — bitte erneut suchen.',
      seedTitle: 'Am Eintrag hinterlegte RIS-Abfrage',
      seedHint: 'Eingrenzungen, die die nächste Verifizierung wiederverwendet. Meist nichts zu tun.',
      notInRis: 'Nicht im RIS — Quelle als Link pflegen.',
    },
  },
  overview: {
    search: 'Organisationen suchen…',
    searchLabel: 'Organisationen suchen',
    searchClear: 'Suche zurücksetzen',
    sortBy: 'Nach {column} sortieren',
    range: '{from}–{to} von {total}',
    previous: 'Zurück',
    next: 'Weiter',
    noMatches: 'Keine Organisation passt zu dieser Suche.',
    noMatchesHint: 'Versuchen Sie einen anderen Namen oder setzen Sie die Suche zurück, um alle Organisationen zu sehen.',
    emptyHint: 'Organisationen erscheinen hier, sobald die erste angelegt wurde.',
    // Das Verzeichnis liest eine Seite aus WorkOS. Das offen zu sagen ist ehrlicher als ein blankes „100+“.
    cappedTile: 'Erste {count} — es gibt mehr',
    cappedNote:
      'Es konnten nur die ersten {count} Organisationen aus dem Verzeichnis geladen werden. Suche, Sortierung und die Kennzahlen oben umfassen genau diese.',
  },
  // Der Wartungsbereich (Bereinigung verwaister Vektoren). Eigener Namensraum,
  // damit Erklärung, Bestätigung und Ergebniszusammenfassung als eine Stimme
  // gelesen – und übersetzt – werden können.
  vectorMaintenance: {
    title: 'Vektor-Wartung',
    description:
      'Den gemeinsamen Vektorspeicher mit dem Dokumentenkatalog abgleichen und indexierte Textabschnitte löschen, deren Dokument nicht mehr existiert.',
    // Wer diese Seite braucht, versteht per Definition nicht, warum Suche und
    // Katalog auseinanderlaufen — die Antwort steht deshalb hier.
    howTitle: 'Was der Abgleich macht',
    howBody:
      'Ein Dokument zu löschen sind zwei Schritte: zuerst seine indexierten Textabschnitte aus dem Vektorspeicher entfernen, dann seinen Eintrag aus dem Katalog. Wird der erste Schritt übersprungen oder schlägt er fehl, verschwindet der Eintrag, die Abschnitte bleiben aber zurück – in der App nirgends sichtbar, in der Suche jedoch weiterhin auffindbar und zitierbar. Der Abgleich durchläuft jede Sammlung, vergleicht sie mit dem Katalog und löscht die Abschnitte, zu denen es kein Dokument mehr gibt.',
    whenTitle: 'Wann Sie ihn brauchen',
    whenBody:
      'Führen Sie ihn aus, wenn eine Antwort ein Dokument zitiert, das niemand findet, wenn eine gelöschte Datei immer wieder als Quelle auftaucht oder nach einer Sammellöschung mit Fehlern. Wiederholen ist unbedenklich: In einem sauberen Speicher findet und löscht er nichts.',
    scopeTitle: 'Was unberührt bleibt',
    scopeBody:
      'Jede Datei mit Katalogeintrag gilt als vorhanden – auch eine, die noch indexiert wird, oder eine, deren Indexierung fehlgeschlagen ist – und bleibt unangetastet. Sammlungen ganz ohne Einträge, etwa der separat gepflegte OIB-Basiskorpus, werden gar nicht erst angefasst.',
    run: 'Verwaiste Vektoren bereinigen',
    running: 'Wird bereinigt…',
    confirmTitle: 'Verwaiste Vektoren bereinigen?',
    confirmDescription:
      'Jede Sammlung der Plattform wird durchsucht, und jeder Abschnitt ohne zugehöriges Dokument wird aus dem gemeinsamen Vektorspeicher gelöscht.',
    confirmWarning:
      'Der Vorgang läuft über alle Organisationen zugleich und kann nicht rückgängig gemacht werden. Der Katalogeintrag eines verwaisten Abschnitts fehlt bereits – erneutes Hochladen stellt daher nichts wieder her.',
    confirmCta: 'Bereinigung starten',
    cancel: 'Abbrechen',
    lastRunTitle: 'Letzter Lauf',
    lastRunHint: 'Läufe werden nicht protokolliert – hier steht, was Sie auf dieser Seite starten.',
    neverRunTitle: 'Noch kein Lauf',
    neverRunBody:
      'Starten Sie eine Bereinigung, um zu sehen, wie viele Sammlungen geprüft wurden und was genau entfernt wurde.',
    colMeasure: 'Kennzahl',
    colCount: 'Anzahl',
    measureCollections: 'Geprüfte Sammlungen',
    measureCollectionsHint: 'Sammlungen mit mindestens einem katalogisierten Dokument.',
    measureFound: 'Verwaiste gefunden',
    measureFoundHint: 'Indexierte Dateien ohne zugehörigen Katalogeintrag.',
    measureDeleted: 'Abschnitte entfernt',
    measureDeletedHint: 'Abschnitte, deren Löschung der Vektorspeicher bestätigt hat.',
    outcomeRemoved: '{chunks} verwaiste(r) Abschnitt(e) in {collections} Sammlung(en) entfernt.',
    outcomeClean: 'Nichts zu bereinigen – jeder indexierte Abschnitt hat noch sein Dokument.',
    failuresTitle: '{count} Sammlung(en) konnten nicht bereinigt werden',
    failuresHint: 'Der Lauf ist darüber hinweggegangen. Sie bleiben unbereinigt, bis ein späterer Lauf erfolgreich ist.',
    colCollection: 'Sammlung',
    colError: 'Grund',
    failed: 'Bereinigung fehlgeschlagen',
    failedHint: 'Die Anfrage wurde nicht abgeschlossen, es wurde daher nichts gelöscht. Bitte erneut versuchen.',
  },
  skills: {
    hint: 'Ein hier geschriebener Skill wird jeder Organisation angeboten. Jede entscheidet selbst, ob sie ihn einschaltet. Entwürfe bleiben unsichtbar, bis Sie sie veröffentlichen.',
    new: 'Neuer kuratierter Skill',
    draft: 'Entwurf',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    deleted: '„{name}“ wurde gelöscht.',
    deleteTitle: 'Diesen kuratierten Skill löschen?',
    deleteDescription:
      'Damit verschwindet „{name}“ endgültig aus dem Katalog — die Anweisung existiert nur hier. Organisationen wird er nicht mehr angeboten; Jobs, die ihn bereits angehängt haben, laufen mit ihrem gespeicherten Snapshot weiter. Wollen Sie ihn nur aus dem Angebot nehmen, schalten Sie ihn stattdessen aus.',
    deleteConfirm: 'Skill löschen',
    cancel: 'Abbrechen',
    publishLabel: 'Veröffentlicht',
    publishHint:
      'An: Jede Organisation sieht diesen Skill auf ihrem Skills-Tab und kann ihn einschalten. Aus: Er ist ein Entwurf, den niemand außerhalb dieses Dashboards sieht, und Organisationen, die ihn eingeschaltet hatten, führen ihn nicht mehr aus.',
    publishAria: 'Kuratierten Skill „{name}“ für alle Organisationen veröffentlichen',
    createTitle: 'Neuer kuratierter Skill',
    editTitle: 'Kuratierten Skill bearbeiten',
    createSubtitle:
      'Ein Skill im agentskills.io-Format, der jeder Organisation auf der Plattform angeboten wird.',
    editSubtitle:
      'Eine Änderung erreicht sofort jede Organisation, die diesen Skill eingeschaltet hat.',
    createSuccess: 'Kuratierter Skill erstellt.',
    updateSuccess: 'Kuratierter Skill gespeichert.',
    saveError: 'Der kuratierte Skill konnte nicht gespeichert werden.',
    loadError: 'Der kuratierte Katalog konnte nicht geladen werden.',
    tryAgain: 'Erneut versuchen',
    empty: {
      title: 'Noch nichts kuratiert',
      description:
        'Ein kuratierter Skill wird einmal geschrieben und jeder Organisation auf der Plattform angeboten. Ihre Verbesserungen erreichen alle, die ihn eingeschaltet haben.',
    },
  },
  nav: {
    label: 'Plattform-Bereiche',
    overview: 'Übersicht',
    skills: 'Skills',
    models: 'Modelle',
    retrieval: 'Abruf',
    quality: 'Antwortqualität',
    cards: 'Karten',
    knowledge: 'Basiswissen',
    norms: 'Normenkatalog',
    storage: 'Speicher',
    maintenance: 'Wartung',
  },
  answerFeedback: {
    title: 'Antwort-Feedback',
    subtitle: 'Wie Nutzerinnen und Nutzer ihre Antworten in den letzten {days} Tagen bewertet haben — was gelungen ist, was nicht, und die Fragen dahinter.',
    refresh: 'Aktualisieren',
    export: 'CSV exportieren',
    digest: {
      title: 'Zusammenfassung',
      generated: 'KI-geschrieben · {ago}',
      regenerate: 'Neue Zusammenfassung schreiben',
      working: 'Was gut läuft',
      workingNone: 'In diesem Zeitraum sticht nichts als besonders gelungen hervor.',
      attention: 'Was Aufmerksamkeit braucht',
      attentionNone: 'In diesem Zeitraum sticht nichts als Problem hervor.',
      nextStep: 'Nächster Schritt:',
      caveat: 'Basiert auf {votes} freiwilligen Bewertungen aus {days} Tagen. Bewerten ist optional — das beschreibt die Bewertenden, nicht alle Antworten.',
      emptyNoFeedback: 'In diesem Zeitraum gibt es keine Bewertungen, also noch nichts zusammenzufassen.',
      emptyTooFew: 'Zu wenige Bewertungen in diesem Zeitraum für eine belastbare Zusammenfassung.',
      unavailable: 'Die Zusammenfassung konnte gerade nicht erstellt werden. Die Zahlen unten sind davon unberührt.',
    },
    trendHeading: 'Entwicklung',
    trendAria: 'Täglicher Anteil hilfreicher Bewertungen',
    trendBetter: '{points} Punkte besser',
    trendWorse: '{points} Punkte schlechter',
    trendFlat: 'Weitgehend unverändert',
    trendAverageMark: 'Ø',
    legendRate: 'Anteil hilfreich pro Tag',
    legendSparse: 'Unter {min} Bewertungen — nicht gemessen',
    legendAverage: 'Ø im Zeitraum ({pct} %)',
    legendVolume: 'Bewertungen an dem Tag',
    trendPoint: '{pct} % hilfreich von {votes} Bewertungen',
    trendPointUnreadable: 'nur {votes} Bewertungen — keine Quote',
    trendTooSparse: 'Noch zu wenige Tage mit {min}+ Bewertungen für eine Entwicklung.',
    windowLabel: 'Zeitraum',
    windowDays: 'Letzte {count} Tage',
    searchPlaceholder: 'Fragen und Antworten durchsuchen…',
    clearFilters: 'Filter zurücksetzen',
    filteredNote: 'Gefiltert — die Zahlen oben beziehen sich auf die aktuelle Auswahl.',
    helpfulRate: 'der Bewertungen waren hilfreich',
    up: 'hilfreich',
    down: 'nicht hilfreich',
    percent: '{value} %',
    downFromVoters: 'nicht hilfreich, von {voters} Personen',
    coverage: '{votes} Bewertungen zu {answers} Antworten — {pct} % der Antworten wurden bewertet',
    orgsHeading: 'Nach Organisation',
    orgVotes: '{votes} Bewertungen',
    topicsHeading: 'Nach Thema',
    topicsCaveat: 'Hier erscheinen nur Unterhaltungen mit Themen-Schlagwort — die Summen oben ergeben sich daraus nicht.',
    topics: {
      brandschutz: 'Brandschutz',
      schallschutz: 'Schallschutz',
      barrierefreiheit: 'Barrierefreiheit',
      energie: 'Energie & Wärme',
      statik: 'Statik',
      hygiene: 'Hygiene & Umwelt',
      nutzungssicherheit: 'Nutzungssicherheit',
      allgemein: 'Allgemein',
    },
    tooFewShort: 'k. A.',
    tooFewVotes: 'Weniger als {min} Bewertungen — zu wenige für eine aussagekräftige Quote.',
    reasonsHeading: 'Woran es lag',
    reasons: {
      inaccurate: 'Ungenau',
      wrong_source: 'Falsche Quelle',
      too_slow: 'Zu langsam',
      other: 'Sonstiges',
    },
    verdictLabel: 'Welche Antworten anzeigen',
    showMissed: 'Misslungen',
    showLanded: 'Gelungen',
    missedHeading: 'Misslungene Antworten',
    landedHeading: 'Gelungene Antworten',
    landedChip: 'Hilfreich',
    noMissed: 'In diesem Zeitraum gab es kein negatives Feedback.',
    noLanded: 'In diesem Zeitraum gab es keine hilfreichen Bewertungen.',
    turnUnavailable: 'Dieser Verlauf wurde nicht gespeichert — die Frage kann nicht angezeigt werden.',
    emptyTitle: 'Noch kein Feedback',
    emptyBody: 'Sobald Antworten bewertet werden, erscheinen die Bewertungen und die zugehörigen Fragen hier.',
    errorTitle: 'Antwort-Feedback konnte nicht geladen werden',
    errorBody: 'Die Auswertung konnte nicht geladen werden. Bitte versuchen Sie es gleich erneut.',
  },
  sections: {
    overview: {
      title: 'Übersicht',
      subtitle: 'Alle Organisationen der Plattform, mit Projekten und LLM-Kosten.',
    },
    skills: {
      title: 'Skills',
      subtitle:
        'Die Skills, die Piloti für alle Organisationen kuratiert. Veröffentlicht wird ein Skill allen angeboten; jede Organisation entscheidet selbst, ob sie ihn einschaltet.',
    },
    models: {
      title: 'Modelle',
      subtitle: 'Das Standardmodell, auf dem jede Organisation läuft, solange sie kein eigenes wählt.',
    },
    retrieval: {
      title: 'Abruf',
      subtitle: 'Wie viele Treffer jede Suche holt und zusammenführt — flottenweit, wirksam ab der nächsten Anfrage.',
    },
    cards: {
      title: 'Karten',
      subtitle: 'Was der Agent darstellen kann — jeder Kartentyp, gerendert, mit den Werten, die er trägt.',
    },
    quality: {
      title: 'Antwortqualität',
      subtitle: 'Wie gut Antworten belegt sind, was Nutzerinnen und Nutzer von ihnen hielten, und der Ausführungsverlauf hinter jedem Turn, der es nicht war.',
    },
    knowledge: {
      title: 'Basiswissen',
      subtitle: 'Der gemeinsame OIB-Korpus, auf den jedes Projekt seine Antworten stützt.',
    },
    norms: {
      title: 'Normenkatalog',
      subtitle: 'Welche Rechtsquellen binden, wie sie eingestuft sind und wo sie im RIS liegen.',
    },
    storage: {
      title: 'Speicher',
      subtitle:
        'Belegter Speicher je Organisation und das jeweils begrenzende Kontingent.',
    },
    maintenance: {
      title: 'Wartung',
      subtitle: 'Pflege des Vektorspeichers. Nur nötig, wenn Retrieval und Korpus auseinanderlaufen.',
    },
  },
  /** Platform → Karten: das Darstellungsvokabular des Agenten, gerendert. */
  cards: {
    title: 'Kartenkatalog',
    description:
      'Jede Karte, die der Agent darstellen kann, gezeigt wie in einer Antwort. Die Liste wird aus dem Kartenschema selbst abgeleitet und zeigt daher immer, was diese Installation tatsächlich erzeugen kann.',
    count: '{count} Kartentypen.',
    loadError: 'Der Kartenkatalog konnte nicht geladen werden.',
    interactiveBadge: 'Fragt nach',
    systemBadge: 'Systemseitig',
    showValues: 'Werte anzeigen ({count})',
    hideValues: 'Werte ausblenden',
    noPreviewModel: 'Nur mit geladenem IFC-Modell — diese Karte trägt Bauteil-IDs, keine Zahlen.',
    noPreviewDocuments: 'Nur mit echten Projektdokumenten — diese Karte zeigt Dateien, keine Beispieldaten.',
    requestCta: 'Karte anfragen',
  },
  /** Plattform → Modelle: das flottenweite Standardmodell je Agentenbereich. */
  models: {
    title: 'Standardmodelle',
    description:
      'Das Modell, auf dem jeder Teil des Agenten läuft. Eine Änderung hier bewegt jede Organisation, die für diesen Teil kein eigenes Modell gewählt hat — ab ihrer nächsten Nachricht, ohne Deployment.',
    // Zustand je Bereich.
    pinnedBadge: 'Plattform-Standard',
    yamlBadge: 'Workflow-Konfiguration',
    unknownFallback: 'Workflow-Konfiguration',
    change: 'Ändern',
    clear: 'Zurück zur Workflow-Konfiguration',
    zdrWarning:
      'Kein Zero-Data-Retention-Endpunkt — Organisationen mit dieser Richtlinie bleiben bei ihrem eigenen Modell.',
    noZdr: 'Kein Zero-Data-Retention-Endpunkt',
    // Denkstufe je Bereich — der zweite Hebel derselben Zeile.
    effortPinnedBadge: 'Plattform-Stufe',
    effortInherit: 'Workflow-Konfig.',
    effortClear: 'Denkstufe zurück zur Workflow-Konfiguration',
    effortSelectLabel: 'Denkstufe für {group}',
    effortSaveError: 'Die Denkstufen konnten nicht gespeichert werden.',
    // Die Stufen selbst (OpenRouter-Vokabular). Der Hinweis nennt die Kosten,
    // nicht nur den Namen — Denk-Tokens sind unsichtbar, bis die Rechnung kommt.
    levels: {
      none: {
        label: 'Aus',
        hint: 'Kein verstecktes Nachdenken. Für reines Routing und Einzeiler. Modelle mit Denkpflicht lehnen diese Stufe ab.',
      },
      minimal: { label: 'Minimal', hint: 'Kürzestes Nachdenken. Schnell und günstig.' },
      low: { label: 'Niedrig', hint: 'Wenig Nachdenken. Für schnelle Antworten mit etwas Abwägung.' },
      medium: { label: 'Mittel', hint: 'Ausgewogen — die Voreinstellung der meisten Rollen.' },
      high: { label: 'Hoch', hint: 'Viel Nachdenken. Deutlich mehr versteckte Tokens und Laufzeit.' },
      xhigh: {
        label: 'Sehr hoch',
        hint: 'Maximales Nachdenken. Vervielfacht Kosten und Laufzeit über hunderte Agentenschritte.',
      },
    },
    // Auswahl.
    searchPlaceholder: 'Modelle suchen…',
    contextWindow: 'Kontext',
    noResults: 'Kein passendes Modell gefunden.',
    // Speichern.
    unsavedChanges: 'Nicht gespeicherte Änderungen.',
    note: 'Notiz',
    notePlaceholder: 'Warum diese Änderung? (optional)',
    save: 'Standards speichern',
    saving: 'Wird gespeichert…',
    discard: 'Verwerfen',
    saved: 'Standardmodelle gespeichert.',
    saveError: 'Die Standardmodelle konnten nicht gespeichert werden.',
    loadError: 'Die Standardmodelle konnten nicht geladen werden.',
    confirmTitle: 'Standard für alle Organisationen ändern?',
    confirmDescription:
      'Jede Organisation, die für diese Teile des Agenten kein eigenes Modell gewählt hat, wechselt mit ihrer nächsten Nachricht. Organisationen mit eigener Wahl bleiben unberührt. Geänderte Denkstufen gelten für JEDE Organisation — höhere Stufen vervielfachen versteckte Denk-Tokens und Laufzeit.',
    confirmSave: 'Standards ändern',
  },
  /** Plattform → Abruf: die flottenweiten Abruf-Tiefen (Chunks/Ergebnisse je Suche). */
  retrieval: {
    title: 'Abruf-Tiefen',
    description:
      'Wie viele Chunks und Ergebnisse die einzelnen Suchen holen und zusammenführen. Eine Änderung hier gilt für jede Organisation — ab ihrer nächsten Anfrage, ohne Deployment.',
    // Zustand je Einstellung.
    pinnedBadge: 'Angepasst',
    defaultBadge: 'Standard',
    defaultHint: 'Standard: {value}',
    rangeHint: '{min}–{max}',
    reset: 'Zurück zum Standard',
    updatedBy: 'von {email}',
    // Speichern.
    unsavedChanges: 'Nicht gespeicherte Änderungen.',
    note: 'Notiz',
    notePlaceholder: 'Warum diese Änderung? (optional)',
    save: 'Einstellungen speichern',
    saving: 'Wird gespeichert…',
    discard: 'Verwerfen',
    saved: 'Abruf-Einstellungen gespeichert.',
    saveError: 'Die Abruf-Einstellungen konnten nicht gespeichert werden.',
    loadError: 'Die Abruf-Einstellungen konnten nicht geladen werden.',
    invalidValue: 'Ungültiger Wert',
    confirmTitle: 'Abruf-Tiefe für alle Organisationen ändern?',
    confirmDescription:
      'Mehr Treffer vertiefen die Recherche jeder Organisation, erhöhen aber auch Latenz und Token-Kosten jeder Anfrage. Die Änderung gilt ab der nächsten Anfrage.',
    confirmSave: 'Einstellungen ändern',
  },
  stats: {
    organizations: 'Organisationen',
    projects: 'Projekte',
    spendToday: 'Ausgaben heute',
    spendMonth: 'Ausgaben diesen Monat',
    requestsMonth: '{count} Anfragen diesen Monat',
  },
  orgs: {
    title: 'Organisationen',
    description: 'Alle Organisationen der Plattform, größte Ausgaben zuerst. Kosten stammen aus dem LLM-Nutzungsregister.',
    colOrganization: 'Organisation',
    colProjects: 'Projekte',
    colToday: 'Heute',
    colMonth: 'Dieser Monat',
    colCreated: 'Erstellt',
    platformBadge: 'Plattform',
    empty: 'Noch keine Organisationen.',
  },
  trend: {
    title: 'Ausgabenverlauf',
    description: 'Plattformweite LLM-Ausgaben pro Tag der letzten 30 Tage (UTC), aus dem Nutzungsregister.',
    requests: '{count} Anfragen',
    empty: 'In den letzten 30 Tagen wurde keine Nutzung erfasst.',
  },
  team: {
    title: 'Plattform-Team',
    description: 'Mitglieder der GRID-Platform-Organisation. Rollen hier gewähren plattformweiten Zugriff — mit Bedacht einladen.',
    auditLogs: 'Audit-Logs',
    auditError: 'Der Audit-Log-Viewer konnte nicht geöffnet werden.',
  },
  notOwner: {
    title: 'Plattform-Zugriff erforderlich',
    description: 'Dieses Dashboard ist exklusiv für den Plattform-Inhaber.',
  },
  knowledge: {
    title: 'Basiswissen',
    description:
      'Der gemeinsame OIB-Korpus, auf den sich alle Projekte stützen. Eine hochgeladene PDF wird sofort ingestiert; hochgeladene Dokumente können wieder entfernt werden. Eine Synchronisierung ingestiert neue oder geänderte Quelldateien erneut.',
    upload: 'PDF hochladen',
    uploading: 'Hochladen & Ingestieren…',
    uploadSuccess: '{name} in den Basis-Korpus ingestiert',
    uploadFailed: 'Ingestion von {name} fehlgeschlagen',
    uploadTimeout: '{name} wird noch ingestiert — in einer Minute aktualisieren',
    sync: 'Korpus synchronisieren',
    syncing: 'Synchronisiere…',
    syncDone: 'Synchronisierung abgeschlossen: {added} hinzugefügt/geändert von {total} Dateien',
    syncFailed: 'Korpus-Synchronisierung fehlgeschlagen',
    search: 'Dokumente filtern…',
    empty: 'Keine Dokumente gefunden.',
    delete: 'Entfernen',
    deleteTitle: '{name} entfernen?',
    deleteDescription:
      'Dies löscht die hochgeladene PDF, ihren Registry-Eintrag und alle indexierten Inhalte. Chats können sich nicht mehr darauf stützen.',
    deleteConfirm: 'Dokument entfernen',
    deleteCancel: 'Abbrechen',
    deleteSuccess: '{name} aus dem Basis-Korpus entfernt',
    deleteFailed: '{name} konnte nicht entfernt werden',
    // Entfernen eines mitgelieferten Basisdokuments (aus dem aktiven Korpus ausgeschlossen).
    corpusDelete: 'Aus Korpus entfernen',
    corpusDeleteTitle: '{name} aus dem Korpus entfernen?',
    corpusDeleteDescription:
      'Dies entfernt ein mitgeliefertes Basisgesetz aus dem aktiven Korpus: Die indexierten Inhalte werden gelöscht und bei der nächsten Synchronisierung nicht erneut ingestiert. Piloti prüft Antworten nicht mehr dagegen.',
    corpusDeleteConfirm: 'Aus Korpus entfernen',
    corpusDeleteSuccess: '{name} aus dem Korpus entfernt',
    loadError: 'Die Wissensbasis konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    chunkCount: '{count} Abschnitte',
    explainer:
      'Basiswissen: die verbindlichen OIB-Richtlinien und weitere Grundlagen, gegen die Piloti jede Antwort prüft.',
    dropTitle: 'PDF oder ZIP hier ablegen',
    dropHint: 'oder klicken, um eine Datei zu wählen — ein ZIP kann viele PDFs auf einmal enthalten',
    dropActive: 'Loslassen zum Hochladen',
    processing: 'Wird verarbeitet — das kann eine Minute dauern…',
    processingHint: 'Sie können weiterarbeiten; neue Dokumente erscheinen unten, sobald sie fertig sind. Warten ist sicher.',
    indexingProgress: 'Indexiere {done} von {total} Dokument(en)…',
    indexingDone: 'Indexiert',
    indexingPending: 'Wird indexiert…',
    pollTimeoutTitle: 'Verarbeitung dauert länger als erwartet',
    pollTimeoutDescription:
      'Der Upload wird weiterhin im Hintergrund indexiert. Aktualisieren Sie, um den aktuellen Status zu prüfen.',
    pollTimeoutRefresh: 'Aktualisieren',
    uploadPending: '{name} empfangen — wird im Hintergrund indexiert',
    zipQueued: 'ZIP empfangen: {accepted} PDF(s) eingereiht, {rejected} übersprungen',
    zipRejectedTitle: 'Aus dem ZIP übersprungen',
    bindingTitle: 'Verbindliche OIB-Grundlagen',
    bindingHint: 'Die offiziellen OIB-Richtlinien und zugehörigen Grundlagengesetze — das maßgebliche Baurecht, dem Piloti folgen muss.',
    otherTitle: 'Weitere Basisdokumente',
    otherHint: 'Weitere Normen, Gesetze und unterstützende Dokumente im Basis-Korpus.',
    docClassLabel: 'Dokumentart',
    docClassFor: 'Dokumentart für {name}',
    docClassFilterAll: 'Alle Dokumentarten',
    docClassUpdated: 'Dokumentart von {name} auf „{label}“ gesetzt',
    docClassUpdateFailed: 'Dokumentart von {name} konnte nicht geändert werden',
    displayTitleFor: 'Anzeigename für {name}',
    displayTitleEdit: '{name} umbenennen',
    displayTitlePlaceholder: 'Anzeigename (leer lassen zum Zurücksetzen)',
    displayTitleSave: 'Namen speichern',
    displayTitleCancel: 'Umbenennen abbrechen',
    displayTitleUpdated: '{name} umbenannt',
    displayTitleUpdateFailed: '{name} konnte nicht umbenannt werden',
    viewPdf: 'PDF ansehen',
    noMatch: 'Keine Dokumente entsprechen dem Filter.',
    clearFilters: 'Filter zurücksetzen',
  },
  profiler: {
    title: 'Agent-Profiler',
    description:
      'Ausführungs-Zeitleiste pro Konversation — wie lange der Agent für jeden Schritt (Graph-Knoten, LLM-Aufruf, Tool-Aufruf) gebraucht hat, organisationsübergreifend.',
    loadError: 'Die Profiler-Daten konnten nicht geladen werden.',
    retry: 'Erneut versuchen',
    search: 'Nach Konversation oder Titel suchen…',
    empty: 'Noch keine profilierten Konversationen.',
    capped: 'Zeigt die {count} zuletzt aktiven Konversationen.',
    colConversation: 'Konversation',
    colOrg: 'Organisation',
    colTurns: 'Turns',
    colDuration: 'Gesamtzeit',
    colLastActive: 'Zuletzt aktiv',
    detailEmpty: 'Konversation auswählen, um die Zeitleiste zu sehen.',
    detailLoading: 'Zeitleiste wird geladen…',
    detailLoadError: 'Die Zeitleiste dieser Konversation konnte nicht geladen werden.',
    turn: 'Turn',
    turnFailed: 'fehlgeschlagen',
    spanCount: '{count} Spans',
    noSpans: 'Keine Spans für diesen Turn erfasst.',
  },
  /**
   * Zitations-Qualität (citation_events-Ledger): wie oft die Quellenprüfung in
   * einen Recherche-Turn eingreifen musste — und warum.
   */
  citations: {
    title: 'Zitations-Qualität',
    description:
      'Wie oft die Quellenprüfung in einen Recherche-Turn eingreifen musste — und was sie gefunden hat. Jeder Recherche-Turn schreibt eine Zeile; Auffälligkeiten werden daneben erfasst.',
    loadError: 'Zitations-Qualität konnte nicht geladen werden.',
    findingsTitle: 'Was zu tun ist',
    findingsDescription:
      'Abgeleitet aus den Befunden dieses Zeitraums — dringendste zuerst. Jeder Eintrag nennt die wahrscheinliche Ursache und den nächsten Schritt.',
    findings: {
      retrieval_unavailable: {
        title: 'Eine Retrieval-Anbindung ist ausgefallen',
        meaning:
          '{turns} Recherche-Turn(s) haben überhaupt keine Quelle erfasst. Wenn das Retrieval nichts liefert, gibt es nichts zu zitieren — der Turn scheitert, statt zu antworten.',
        action:
          'Prüfen Sie das gemeldete Werkzeug ({subject}) und seine Datenquellen-Konfiguration — API-Key, Base-URL, Erreichbarkeit. Das zuerst beheben; alle anderen Befunde hängen davon ab.',
        actionNoSubject:
          'Prüfen Sie die Datenquellen-Konfiguration der Recherche-Werkzeuge — API-Key, Base-URL, Erreichbarkeit. Das zuerst beheben; alle anderen Befunde hängen davon ab.',
      },
      answers_ungrounded: {
        title: 'Antworten gehen ohne Quelle raus',
        meaning:
          '{turns} Antwort(en) ({share}% der Turns) wurden mit dem sichtbaren Hinweis „Ohne Quellenangabe“ ausgeliefert — es wurden Quellen gefunden, aber keine zitierte hat die Prüfung überstanden.',
        action:
          'Öffnen Sie die markierten Turns unten und prüfen Sie, ob der Korpus die Frage überhaupt abdeckt. Wenn ja, liegt es am Zitier-Kontrakt im Writer-Prompt; wenn nein, fehlen dem Basiswissen von {subject} die Dokumente.',
        actionNoSubject:
          'Öffnen Sie die markierten Turns unten und prüfen Sie, ob der Korpus die Frage überhaupt abdeckt. Wenn ja, liegt es am Zitier-Kontrakt im Writer-Prompt; wenn nein, fehlen dem Basiswissen die Dokumente.',
      },
      citations_invented: {
        title: 'Das Modell zitiert Quellen, die nie abgerufen wurden',
        meaning:
          '{citations} Quellenangabe(n) in {turns} Turn(s) wurden entfernt, {share}% davon, weil die zitierte Quelle nicht unter den in diesem Turn abgerufenen Quellen war — und {unheld} dieser Quellen liegen nirgends auf der Plattform, das Modell zitiert also aus dem Gedächtnis.',
        action:
          'Das ist ein Prompt-/Modellproblem, kein Retrieval-Problem. Schärfen Sie die Zitierregeln im Researcher-Prompt (nur aus abgerufenen Passagen zitieren) und prüfen Sie das Modell der betroffenen Organisationen. Aktuell fängt das nur die Prüfung ab.',
      },
      quotes_fabricated: {
        title: 'Wörtliche Zitate stehen so nicht in den Quellen',
        meaning:
          '{quotes} wörtliche(s) Zitat(e) in {turns} Turn(s) ({share}% der Turns) passten zu keiner abgerufenen Passage — das klassische Muster „echter Paragraf, erfundener Wortlaut“.',
        action:
          'Stichprobe: markierte Turns gegen das zitierte Dokument prüfen. Sind die Zitate tatsächlich korrekt, ist die Fuzzy-Schwelle zu streng; sind sie es nicht, erfindet das Modell Wortlaut und braucht eine strengere Zitieranweisung.',
      },
      citation_format_unparsed: {
        title: 'Quellenangaben kommen in einem Format, das die Prüfung nicht lesen kann',
        meaning:
          'In {turns} Turn(s) ({share}% der Turns) hat nichts vom Modell Geschriebenes das Parsen überstanden, und eine Quelle musste automatisch ergänzt werden.',
        action:
          'Vergleichen Sie die Zitier-Syntax im Researcher-Prompt mit dem, was die Prüfung erwartet. Ein Format-Drift verwirft hier stillschweigend korrekte Quellenangaben — die Antwort wirkt schlechter belegt, als sie ist.',
      },
      organization_outlier: {
        title: 'Eine Organisation ist deutlich schlechter als der Rest',
        meaning:
          '{subject} hat eine Befundquote von {share}% gegenüber {platformShare}% im Plattformdurchschnitt ({turns} auffällige Turns).',
        action:
          'Schauen Sie gezielt auf diese Organisation statt auf die Pipeline: Abdeckung des Basiswissens, hochgeladene Projektdokumente und das konfigurierte Modell. Eine plattformweite Änderung wäre hier die falsche Reparatur.',
      },
      sources_missing: {
        title: 'Konkrete Quellen werden zitiert, sind aber nicht vorhanden',
        meaning:
          '{sources} verschiedene Quelle(n) wurden in {turns} Turn(s) zitiert, keine davon liegt im Basiskorpus oder im Normenkatalog. Am häufigsten: {subject}.',
        action:
          'Arbeiten Sie die Liste „Quellen zum Ergänzen“ unten ab. {automatic} davon sind RIS-Verweise, bei denen nur der Rechtsrang zu bestätigen ist; der Rest sind Dokumente, deren PDF Sie beisteuern müssen.',
      },
      sources_unretrievable: {
        title: 'Vorhandene Quellen erreichen die Antworten nicht',
        meaning:
          '{sources} zitierte Quelle(n) in {turns} Turn(s) liegen bereits im Korpus, wurden vom Retrieval aber nie geliefert — allen voran {subject}.',
        action:
          'Diese NICHT erneut hochladen. Prüfen Sie stattdessen die Indexierung: Korpus-Sync ausführen, dann den Vektorspeicher abgleichen. Bleiben sie unauffindbar, liegt es am Chunking oder Embedding dieser Dokumente.',
      },
      duplicates_only: {
        title: 'Die meisten Entfernungen sind nur Dubletten',
        meaning:
          '{share}% der entfernten Quellenangaben waren Dubletten einer bereits in derselben Antwort vorhandenen Angabe.',
        action:
          'Kein Handlungsbedarf — das ist kosmetische Entdopplung, kein Beleg-Problem. Solange das dominiert, ist die Zahl „entfernte Quellenangaben“ kein Qualitätsproblem.',
      },
      all_clear: {
        title: 'Nichts erfordert Ihre Aufmerksamkeit',
        meaning: '{turns} Recherche-Turns in diesem Zeitraum, {share}% davon ohne einen einzigen Befund.',
        action: 'Nichts zu tun. Schauen Sie wieder rein, wenn der Trend oben ansteigt.',
      },
    },
    export: 'Diagnose exportieren',
    windowAria: 'Zeitraum',
    windowDays: 'Letzte {count} Tage',
    unattributed: 'Ohne Zuordnung',
    turnId: 'Turn',
    itemCount: '{count} betroffen',
    empty: {
      title: 'Noch keine Recherche-Turns erfasst',
      description:
        'Die Zitations-Qualität füllt sich, sobald Recherche-Turns laufen. Nichts erfasst heißt: nichts zu prüfen.',
    },
    stats: {
      cleanRate: 'Saubere Turns',
      cleanRateHint: '{clean} von {turns} Turns ohne Befund',
      ungrounded: 'Ohne Quellenangabe',
      ungroundedHint: 'Antworten ohne verifizierte Quellenangabe',
      removed: 'Entfernte Quellenangaben',
      removedHint: 'Einzelne Quellenangaben, die nicht bestätigt werden konnten',
      quotes: 'Nicht verifizierte Zitate',
      quotesHint: 'Wörtliche Zitate, die in keiner Fundstelle auftauchen',
    },
    trend: {
      title: 'Befunde pro Tag',
      description:
        'Zitations-Befunde pro UTC-Tag über die letzten {days} Tage. Ein Turn kann mehrere Befunde tragen — die Balken zählen Befunde, nicht Turns.',
      turns: '{count} Turns',
      findings: '{count} Befunde',
      flagged: '{count} auffällig',
      empty: 'Keine Zitations-Befunde in diesem Zeitraum.',
    },
    missingTitle: 'Quellen ohne Nachweis',
    missingDescription:
      'Konkrete Quellen, die Antworten immer wieder zitieren und die die Prüfung nicht bestätigen konnte — abgeglichen mit dem, was die Plattform tatsächlich hat. Meistzitierte zuerst.',
    missingCited: 'in {turns} Turn(s) zitiert · {organizations} Organisation(en)',
    missingCaveat:
      'Jede Schaltfläche öffnet die zuständige Verwaltung, mit der Kennung in der Zwischenablage. Das Hinzufügen erfolgt bewusst nicht still: Ein PDF muss von Ihnen kommen, und ein Eintrag im Normenkatalog braucht bestätigte Rechtsrang- und Bundesland-Angaben, bevor der Agent ihn als verbindlich zitieren darf.',
    missingStatus: {
      absent: 'nicht in der Plattform vorhanden',
      present: 'bereits vorhanden — das Retrieval hat sie nicht gefunden',
    },
    missingKinds: {
      document: 'Dokument',
      ris: 'RIS',
      web: 'Web',
    },
    missingActions: {
      upload_to_base_knowledge: 'Zum Basiswissen hinzufügen',
      add_to_norm_catalog: 'Zum Normenkatalog hinzufügen',
      investigate_retrieval: 'Indexierung prüfen',
      none: 'Außerhalb des Korpus',
    },
    reasonsTitle: 'Warum Quellenangaben entfernt wurden',
    reasonsDescription: 'Der Grund der Prüfung für jede Entfernung, häufigster zuerst.',
    reasonsEmpty: 'Keine Entfernungen in diesem Zeitraum.',
    sourcesTitle: 'Quellen bei auffälligen Turns',
    sourcesDescription: 'Herkünfte und Werkzeuge, die bei Turns mit Befund im Einsatz waren.',
    sourcesEmpty: 'Keine Quellen-Metadaten für auffällige Turns in diesem Zeitraum.',
    orgsTitle: 'Nach Organisation',
    orgsDescription:
      'Am stärksten betroffene zuerst. Eine hohe Quote bei wenigen Turns ist Rauschen; eine hohe Quote bei vielen ist ein Problem.',
    orgsEmpty: 'Keine Organisationen in diesem Zeitraum erfasst.',
    colTurns: 'Turns',
    colDefects: 'Auffällig',
    colDefectRate: 'Quote',
    recentTitle: 'Neueste Befunde',
    recentDescription: 'Die zuletzt auffälligen Turns. Die Turn-ID entspricht der im Agent-Profiler oben.',
    recentEmpty: 'Keine Befunde in diesem Zeitraum.',
    kinds: {
      answer_ungrounded: 'Ohne Quellenangabe',
      citations_removed: 'Quellenangaben entfernt',
      quote_unverified: 'Zitat nicht verifizierbar',
      registry_empty: 'Keine Quellen erfasst',
      citation_fallback: 'Quellenangabe automatisch ergänzt',
      confidence_capped: 'Konfidenz gedeckelt',
    },
    reasons: {
      url_not_in_registry: 'URL nicht unter den abgerufenen Quellen',
      citation_key_not_in_registry: 'Dokument nicht unter den abgerufenen Quellen',
      unverifiable: 'Kein prüfbares Ziel in der Quellenangabe',
      duplicate: 'Doppelte Quellenangabe',
      ungrounded: 'Antwort nicht auf eine Quellenangabe gestützt',
      quote_unverified: 'Zitat nicht verifizierbar',
    },
    dimensions: {
      origin: 'Herkunft',
      tool: 'Werkzeug',
    },
    agents: {
      shallow: 'Schnellrecherche',
      deep: 'Tiefenrecherche',
    },
  },
  /** Speicher: Verbrauch je Mandant und das begrenzende Kontingent. */
  storage: {
    title: 'Dokumentenspeicher',
    description:
      'Belegter Speicher je Organisation und das Kontingent, das weitere Uploads ablehnt. Kontingente sind eine Plattformsteuerung — Mandanten sehen ihren Wert, ändern ihn aber nie.',
    totals: '{used} belegt in {orgs} Organisationen',
    columnOrg: 'Organisation',
    columnUsed: 'Belegt',
    columnQuota: 'Kontingent',
    unlimited: 'Unbegrenzt',
    inherited: 'Plattform-Standard',
    /** Count-neutral: die Vorlage wird auch bei genau einem Dokument gerendert. */
    rowDocuments: 'Dokumente: {count}',
    rowOver: 'Kontingent erreicht — Uploads abgelehnt',
    rowNear: 'Fast voll',
    edit: 'Kontingent für {org} bearbeiten',
    save: 'Kontingent speichern',
    cancel: 'Abbrechen',
    saved: 'Kontingent aktualisiert.',
    saveError: 'Kontingent konnte nicht aktualisiert werden.',
    belowUsage:
      'Dieses Kontingent liegt unter dem bereits belegten Speicher. Geben Sie zuerst Platz frei.',
    invalidQuota:
      'Geben Sie ein Kontingent in GB über null ein oder lassen Sie das Feld leer für kein Limit.',
    quotaTooLarge:
      'Dieses Kontingent ist größer als das System darstellen kann. Geben Sie höchstens 9.000.000 GB ein oder lassen Sie das Feld leer für kein Limit.',
    truncated:
      'Es werden die ersten 1000 Organisationen angezeigt. Für den Rest bitte einen Flottenbericht anfordern.',
    loadError: 'Speichernutzung konnte nicht geladen werden.',
    empty: 'Noch keine Organisation hat Daten gespeichert.',
    hint: 'Feld leer lassen, um das Limit zu entfernen. Ein Kontingent unter der aktuellen Belegung wird abgelehnt — es würde den Mandanten handlungsunfähig machen.',
  },

}
