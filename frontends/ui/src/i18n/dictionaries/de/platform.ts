import type { en } from '../en'

/** Das plattformweite Dashboard des Plattform-Inhabers (ADR-0016). */
export const platform: typeof en.platform = {
  title: 'Plattform',
  subtitle: 'Organisationsübergreifende Übersicht für den Plattform-Inhaber.',
  loading: 'Plattform wird geladen…',
  loadError: 'Die Plattform-Übersicht konnte nicht geladen werden.',
  loadErrorHint: 'Beim Laden der Daten ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.',
  retry: 'Erneut versuchen',
  nav: {
    label: 'Plattform-Bereiche',
    overview: 'Übersicht',
    quality: 'Antwortqualität',
    knowledge: 'Basiswissen',
    norms: 'Normenkatalog',
    workflows: 'Workflow-Vorlagen',
    maintenance: 'Wartung',
  },
  sections: {
    overview: {
      title: 'Übersicht',
      subtitle: 'Alle Organisationen der Plattform, mit Projekten und LLM-Kosten.',
    },
    quality: {
      title: 'Antwortqualität',
      subtitle: 'Wie gut Antworten belegt sind — und der Ausführungsverlauf hinter jedem Turn, der es nicht war.',
    },
    knowledge: {
      title: 'Basiswissen',
      subtitle: 'Der gemeinsame OIB-Korpus, auf den jedes Projekt seine Antworten stützt.',
    },
    norms: {
      title: 'Normenkatalog',
      subtitle: 'Welche Rechtsquellen binden, wie sie eingestuft sind und wo sie im RIS liegen.',
    },
    workflows: {
      title: 'Workflow-Vorlagen',
      subtitle: 'Vorlagen, die in der Galerie jeder Organisation erscheinen.',
    },
    maintenance: {
      title: 'Wartung',
      subtitle: 'Pflege des Vektorspeichers. Nur nötig, wenn Retrieval und Korpus auseinanderlaufen.',
    },
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
  maintenance: {
    title: 'Vektor-Wartung',
    description:
      'Verwaiste Vektoren entfernen – indexierte Textabschnitte, die bei früheren Löschungen zurückblieben und deren Dokument nicht mehr existiert. In der App sind sie unsichtbar, können aber weiterhin in der Suche auftauchen. Jederzeit gefahrlos ausführbar; es werden nur Abschnitte ohne vorhandenes Dokument entfernt.',
    reconcile: 'Verwaiste Vektoren bereinigen',
    reconciling: 'Wird bereinigt…',
    confirmTitle: 'Verwaiste Vektoren bereinigen?',
    confirmDescription:
      'Dies durchsucht jede Sammlung und löscht indexierte Abschnitte, deren Dokument nicht mehr existiert. Weiterhin sichtbare Dokumente bleiben unberührt. Der Vorgang kann nicht rückgängig gemacht werden, ein entferntes Dokument lässt sich aber erneut hochladen.',
    confirm: 'Bereinigung starten',
    cancel: 'Abbrechen',
    resultRemoved: '{chunks} verwaiste Abschnitt(e) in {collections} Sammlung(en) entfernt',
    resultClean: 'Keine verwaisten Vektoren gefunden',
    resultCleanDetail: 'Keine verwaisten Vektoren in {collections} Sammlung(en) gefunden',
    resultFailures: '{count} Sammlung(en) konnten nicht bereinigt werden',
    failed: 'Bereinigung fehlgeschlagen',
  },
  workflowTemplates: {
    title: 'Workflow-Vorlagen',
    explainer:
      'Kuratierte Rechercheaufträge, die in der Workflow-Galerie jeder Organisation veröffentlicht werden. Eine veröffentlichte Vorlage erscheint bei allen Organisationen; das Auswählen füllt dort nur den Workflow-Builder vor – es startet nie automatisch.',
    new: 'Neue Vorlage',
    // JSON-Import-Ablagefläche.
    dropTitle: 'Vorlage importieren (JSON)',
    dropActive: 'Zum Importieren loslassen',
    dropHint: 'JSON-Datei ablegen oder klicken – der Editor öffnet sich vorausgefüllt als Entwurf.',
    importLoaded: 'Vorlagendatei geladen – prüfen und speichern.',
    importInvalid: 'Diese Datei ist kein gültiger Vorlagen-Export.',
    // Listenzustände.
    empty: 'Noch keine Vorlagen. Erstellen Sie eine oder importieren Sie eine JSON-Datei.',
    loadError: 'Die Vorlagen konnten nicht geladen werden.',
    retry: 'Erneut versuchen',
    manualCadence: 'Auf Abruf',
    // Zeilen-Badges + Aktionen.
    published: 'Veröffentlicht',
    draft: 'Entwurf',
    publishAria: '„{name}“ für alle Organisationen veröffentlichen',
    unpublishAria: 'Veröffentlichung von „{name}“ zurückziehen',
    export: 'Als JSON exportieren',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    // Provenienz-Bezeichnungen (Formular + Liste).
    provenance: {
      law: 'Vorschrift',
      project: 'Projekt',
      office: 'Büro',
      auto: 'Allgemein',
    },
    // Meldungen.
    createSuccess: 'Vorlage erstellt.',
    updateSuccess: 'Vorlage aktualisiert.',
    publishSuccess: 'Vorlage für alle Organisationen veröffentlicht.',
    unpublishSuccess: 'Veröffentlichung zurückgezogen.',
    publishFailed: 'Der Veröffentlichungsstatus konnte nicht geändert werden.',
    saveFailed: 'Die Vorlage konnte nicht gespeichert werden.',
    deleteSuccess: 'Vorlage gelöscht.',
    deleteFailed: 'Die Vorlage konnte nicht gelöscht werden.',
    // Löschbestätigung.
    deleteTitle: '„{name}“ löschen?',
    deleteDescription:
      'Dies entfernt die Vorlage aus der Galerie jeder Organisation. Bereits daraus erstellte Workflows bleiben unberührt. Dies kann nicht rückgängig gemacht werden.',
    deleteConfirm: 'Vorlage löschen',
    deleteCancel: 'Abbrechen',
    form: {
      createTitle: 'Neue Workflow-Vorlage',
      editTitle: 'Workflow-Vorlage bearbeiten',
      subtitle: 'Verfassen Sie den Auftrag auf Deutsch und Englisch – die Galerie zeigt die Sprache des Betrachters.',
      provenanceLabel: 'Kategorie-Färbung',
      sortOrderLabel: 'Sortierreihenfolge',
      sortOrderHint: 'Kleinere Zahlen erscheinen in der Galerie zuerst.',
      dataSourcesLabel: 'Zusätzliche Datenquellen',
      dataSourcesHint:
        'Die Basiswissensebene ist immer enthalten. Wählen Sie weitere Quellen, die ein Lauf nutzen soll.',
      sourcesLoading: 'Quellen werden geladen…',
      sourcesAll: 'Keine zusätzlichen Quellen verfügbar.',
      scheduleLabel: 'Vorgeschlagener Zeitplan',
      scheduleHint: 'Ein Standardrhythmus, den die übernehmende Person beibehalten oder ändern kann.',
      presetLabel: 'Rhythmus',
      timezoneLabel: 'Zeitzone',
      cronLabel: 'Eigener Cron (5 Felder)',
      cronHint: 'Minute Stunde Tag-des-Monats Monat Wochentag.',
      presets: {
        hourly: 'Jede Stunde',
        daily: 'Täglich um 06:00',
        weekly: 'Wöchentlich, Montag 06:00',
        monthly: 'Monatlich, am 1. um 06:00',
        custom: 'Eigener Zeitplan',
      },
      locale: {
        de: 'Deutsch',
        en: 'Englisch',
      },
      nameLabel: 'Name',
      descriptionLabel: 'Kurzbeschreibung',
      categoryLabel: 'Kategorie-Bezeichnung',
      categoryHint: 'Kurzes Label auf der Karte, z. B. „Compliance“.',
      objectiveLabel: 'Ziel',
      contextLabel: 'Hintergrund & Kontext',
      questionsLabel: 'Forschungsfragen',
      questionsHint: 'Eine Frage pro Zeile.',
      outputFormatLabel: 'Ausgabeanforderungen',
      previewLabel: 'Kompilierter Auftrag (was der Agent erhält)',
      previewEmpty: 'Geben Sie das Ziel ein, um den kompilierten Auftrag zu sehen.',
      publishLabel: 'Veröffentlicht',
      publishHint: 'Wenn aktiv, ist diese Vorlage in der Galerie jeder Organisation sichtbar.',
      requiredError: 'Beide Sprachen benötigen mindestens Name, Beschreibung, Kategorie und Ziel.',
      cancel: 'Abbrechen',
      save: 'Vorlage speichern',
      saving: 'Wird gespeichert…',
    },
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
          '{citations} Quellenangabe(n) in {turns} Turn(s) wurden entfernt, und {share}% der Entfernungen betrafen Quellen, die gar nicht im Retrieval-Register standen — das Modell zitiert aus dem Gedächtnis.',
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
      description: 'Recherche-Turns mit einem Zitations-Befund, pro UTC-Tag über die letzten {days} Tage.',
      turns: '{count} Turns',
      empty: 'Keine Zitations-Befunde in diesem Zeitraum.',
    },
    missingTitle: 'Quellen zum Ergänzen',
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
}
