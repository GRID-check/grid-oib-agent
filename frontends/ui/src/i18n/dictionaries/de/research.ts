import type { en } from '../en'

/** The research workspace: chat shell, panels, and deep-research detail views. */
export const research: typeof en.research = {
  dismissError: 'Fehler ausblenden',

  detailsHelp:
    'Diese Details erscheinen während einer laufenden Recherche und sind für abgeschlossene Berichte möglicherweise nicht verfügbar.',

  runsPage: {
    title: 'Recherchedurchläufe',
    subtitle:
      'Deep-Research-Berichte, die Piloti für dieses Projekt erstellt hat, neueste zuerst.',
  },

  // Labels for the per-project research-runs list rows (research-runs-list.tsx).
  runsList: {
    untitledRun: 'Deep-Research-Durchlauf',
    sessionLabel: 'Sitzung {id}',
    viewThinking: 'Denkschritte anzeigen',
  },

  dockedPanel: {
    closePanel: 'Bereich schließen',
  },

  chatArea: {
    ariaMessages: 'Chat-Nachrichten',
    loading: 'Unterhaltung wird geladen',
    typing: 'Piloti antwortet …',
    scrollToLatest: 'Zum neuesten Beitrag springen',
    status: {
      thinking: 'Denkt nach …',
      searching: 'Sucht …',
      planning: 'Plant …',
      researching: 'Recherchiert …',
      writing: 'Schreibt …',
    },
    loggedOutTitle: 'Piloti wird verfügbar, sobald Ihre Organisation verifiziert ist.',
    loggedOutBody:
      'Melden Sie sich an, um projektbezogene OIB-Recherche, das Einlesen Ihrer Dokumente und Zugriffsrechte für Mitglieder freizuschalten.',
    signInSso: 'Mit SSO anmelden',
    welcomeTitle: 'Wie kann Piloti bei Ihrem Projekt helfen?',
    usePrompt: 'Vorschlag verwenden: {prompt}',
    prompt1: 'Vergleiche die Brandschutzpflichten nach OIB 2 über die Gebäudeklassen hinweg.',
    prompt2: 'Fasse die Barrierefreiheitsanforderungen für eine öffentliche Sanierung zusammen.',
    prompt3: 'Finde Widersprüche zwischen den hochgeladenen Plänen und den OIB-Richtlinien.',
  },

  chatToolbar: {
    createNewSession: 'Neue Sitzung erstellen',
    signInToCreate: 'Melden Sie sich an, um Sitzungen zu erstellen',
    cannotCreateActive:
      'Es kann keine neue Sitzung erstellt werden, solange die aktuelle Sitzung aktiv ist',
    newChat: 'Neuer Chat',
    toggleSessions: 'Chatverlauf',
    signInToView: 'Melden Sie sich an, um Ihren Chatverlauf zu sehen',
    sessions: 'Sitzungen',
    addSources: 'Datenquellen hinzufügen',
    signInToManage: 'Melden Sie sich an, um Datenquellen zu verwalten',
    sources: 'Quellen',
    research: 'Recherche',
    /** Trigger for the thread menu that holds every non-primary header action. */
    moreActions: 'Weitere Aktionen',
    renameSession: 'Chat umbenennen',
    researchReport: 'Recherchebericht',
  },

  dataSources: {
    loading: 'Datenquellen werden geladen',
    loadingEllipsis: 'Datenquellen werden geladen...',
    unableToLoad: 'Datenquellen konnten nicht geladen werden',
    retryAria: 'Laden der Datenquellen erneut versuchen',
  },

  /**
   * Datenbasis — der Verfasser-Regler dafür, WORIN Piloti suchen darf.
   *
   * Ein Name für eine Sache: dieses Objekt löst die vier konkurrierenden
   * Bezeichnungen ab, die dieselbe Fläche früher trugen (aria-label
   * „Datengrundlage“, sichtbar „Datengrundlage“, title „Ausgewählte
   * Datenverbindungen“, Kopfzeile „Datenquellen“).
   *
   * Zeitform ist hier Bedeutung: der Regler spricht ausschließlich in der
   * Gegenwart/Möglichkeit („darf suchen“). Was tatsächlich benutzt wurde, sagt
   * die Herleitung — nie dieses Bedienelement.
   */
  sourceBasis: {
    label: 'Datenbasis',
    triggerAria: 'Datenbasis: {summary}. Öffnet die Auswahl.',
    description:
      'Worin Piloti suchen darf. Was tatsächlich verwendet wurde, steht in der Herleitung.',
    allSources: 'Alle Quellen',
    internalOnly: 'Nur Projektwissen',
    overflowAria: '{count} weitere Quellenarten',
    alwaysOn: 'Immer dabei',
    alwaysOnChip: 'Immer aktiv',
    external: 'Externe Quellen',
    signInRequired: 'Anmeldung nötig',
    signInReason: 'Melden Sie sich an, um diese Quelle zu nutzen.',
    lockedBusy: 'Während einer laufenden Recherche lässt sich die Datenbasis nicht ändern.',
    noExternalWarning: 'Piloti sucht dann nur noch in Ihren Projektunterlagen.',
    presetsLabel: 'Voreinstellungen',
    emptyTitle: 'Keine externen Quellen',
    emptyBody:
      'Für dieses Projekt sind derzeit keine externen Quellen freigeschaltet. Piloti sucht in Ihren Projektunterlagen.',
    toggleAria: '{name} zulassen',
    /** Wortmarken der Provenienz-Straten — immer mit Icon und Farbe zusammen. */
    strata: {
      law: 'Baurecht',
      office: 'Büroarchiv',
      project: 'Projektwissen',
      auto: 'Web',
    },
    /** Voreinstellungen im Fuß der Auswahl — „Alle“ macht den Normalfall benennbar. */
    presets: {
      all: 'Alle Quellen',
      law: 'Baurecht & Richtlinien',
      project: 'Projektunterlagen',
      office: 'Büroarchiv',
    },
    /**
     * Die Wissensschicht ist keine umschaltbare Quelle — sie geht bei jedem Zug
     * mit auf die Leitung. Deshalb steht sie hier sichtbar drin, statt gefiltert
     * zu verschwinden und die Zählung zu verfälschen.
     */
    knowledge: {
      projectName: 'Projektwissen',
      projectDescription: 'Ihre Projektunterlagen in diesem Projekt.',
      officeName: 'Büroarchiv',
      officeDescription: 'Freigegebene Unterlagen Ihres Büros.',
    },
  },

  deleteModals: {
    cannotReverse:
      'Diese Aktion kann nicht rückgängig gemacht werden. Sind Sie sicher, dass Sie dies tun möchten?',
    aboutToDelete: 'Sie sind dabei,',
    lossSuffix:
      ' zu löschen. Dabei gehen sämtliche Fortschritte verloren und alle von Ihnen angehängten Dateien werden entfernt.',
    all: {
      title: 'Alle Chats dieses Projekts löschen?',
      countSessions: 'alle {count} Chats dieses Projekts',
      allSessions: 'JEDEN Chat dieses Projekts',
      scopeNote:
        'Es werden nur Chats dieses Projekts gelöscht. Ihre Chats in anderen Projekten sind nicht betroffen.',
      confirm: 'Alle Chats löschen',
    },
    file: {
      title: 'Datei löschen',
      thisFile: 'diese Datei',
      suffix: ' zu löschen. Sie wird damit vollständig aus Ihrer Sitzung entfernt.',
      confirm: 'Datei löschen',
    },
    session: {
      title: 'Diesen Chat löschen?',
      thisSession: 'diesen Chat',
      confirm: 'Chat löschen',
    },
  },

  export: {
    availableWhenComplete: 'Der Export ist verfügbar, sobald die Recherche abgeschlossen ist',
    exportReport: 'Bericht exportieren',
    noContent: 'Kein Inhalt zum Exportieren',
    asMarkdown: 'Als Markdown exportieren',
    asMarkdownDisabled: 'Als Markdown exportieren ({reason})',
    asPdf: 'Als PDF exportieren',
    asPdfDisabled: 'Als PDF exportieren ({reason})',
    generatingPdf: 'PDF wird erstellt...',
    generating: 'Wird erstellt...',
    markdown: 'Markdown',
    pdf: 'PDF',
  },

  agentCard: {
    detailsWhenComplete: 'Details verfügbar, sobald der Agent fertig ist',
    isRunning: '{name} läuft',
    queriesCount: '{completed}/{total} Abfragen',
    toolsCount: '{completed}/{total} Werkzeuge',
    started: 'Gestartet: {time}',
    running: 'Läuft',
  },

  agentsTab: {
    title: 'Agenten',
    runningCount: '{count} aktiv',
    queriesProgress: '{completed}/{total} Abfragen',
    description: 'Piloti plant, recherchiert und schreibt — hier steht, woran gerade gearbeitet wird.',
    empty: 'Keine Agentenaktivität verfügbar.',
  },

  filesTab: {
    title: 'Dateien',
    description: 'Entwürfe, Berichte und weitere Dateien, die diese Recherche erzeugt hat.',
    empty: 'Noch keine Dateien erzeugt.',
  },

  fileCard: {
    lines: '{count} Zeilen',
    content: 'Inhalt',
  },

  fileSourceCard: {
    statusUploading: 'Wird hochgeladen...',
    statusIngesting: 'Wird verarbeitet...',
    statusAvailable: 'Verfügbar',
    statusError: 'Fehler',
    statusDeleting: 'Wird gelöscht...',
    expiryPending: 'Löschung ausstehend – erneut hochladen',
    expiresIn: 'Läuft in {minutes} Min. ab',
    deleteDisabled: '{title} löschen (deaktiviert)',
    delete: '{title} löschen',
    waitUpload: 'Warten Sie, bis der Upload abgeschlossen ist',
    cannotDeleteBusy: 'Dateien können während aktiver Vorgänge nicht gelöscht werden',
    deleteFile: 'Datei löschen',
    open: 'Vorschau öffnen: {title}',
  },

  fileSourcesTab: {
    uploadTo: 'Hochladen nach',
    targetProject: 'Projektwissen',
    targetSession: 'Private Sitzung',
    targetProjectLower: 'das Projektwissen',
    targetSessionLower: 'die private Sitzung',
    availableInProject: 'In diesem Projekt verfügbar.',
    preparingCorpus: 'Projektwissen wird vorbereitet...',
    onlyThisSession: 'Nur in dieser Chat-Sitzung verfügbar.',
    loadingFiles: 'Dateien werden geladen',
    checkingFiles: 'Dateien werden geprüft...',
    setupBackend: 'Dateien stehen erst zur Verfügung, wenn die Verbindung zu Piloti steht.',
    noAttachedFiles: 'Keine angehängten Dateien',
    filesGoTo: 'Hier hochgeladene Dateien gelangen in {target}, sofern nicht entfernt.',
    filesCount: '{target} – Dateien ({count})',
    loadingFilesEllipsis: 'Dateien werden geladen...',
    addFiles: 'Dateien hinzufügen',
    uploadNotAvailable: 'Datei-Upload nicht verfügbar',
    addFile: '+ Datei hinzufügen',
  },

  inputArea: {
    aiDisclosure:
      'Piloti ist ein KI-System — Antworten können falsch sein; prüfen Sie sie anhand der zitierten Richtlinie.',
    placeholderDefault: 'Datenquellen prüfen und eine Recherchefrage stellen...',
    signInToStart: 'Melden Sie sich an, um mit der Recherche zu beginnen',
    researchCompletedNewSession:
      'Recherche abgeschlossen. Erstellen Sie für weitere Fragen eine neue Sitzung.',
    researchFailedFollowUp:
      'Die Recherche wurde nicht abgeschlossen. Stellen Sie eine Anschlussfrage oder versuchen Sie es erneut.',
    typeResponse: 'Geben Sie Ihre Antwort an Piloti ein...',
    pleaseWait: 'Bitte warten...',
    messageNotSent: 'Nachricht nicht gesendet',
    messageNotSentDesc:
      'Beim Senden Ihrer Nachricht ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    unsupportedFileType: 'Nicht unterstützter Dateityp',
    dropToUpload: 'Dateien zum Hochladen ablegen',
    accepts: 'Akzeptiert: {types}',
    openFiles: 'Hochgeladene Dateien öffnen',
    availableFiles: 'Verfügbare Dateien',
    uploadNotAvailable: 'Datei-Upload nicht verfügbar',
    attachFiles: 'Dateien anhängen',
    uploadDisabledBusy: 'Datei-Upload während aktiver Vorgänge deaktiviert',
    selectFiles: 'Dateien zum Hochladen auswählen',
    researchCompletedAria: 'Recherche abgeschlossen – neue Sitzung erstellen',
    researchCompleted: 'Recherche abgeschlossen',
    researchCompletedPopover:
      'Recherche abgeschlossen. Für weitere Fragen oder Berichte erstellen Sie bitte eine neue Sitzung.',
    startNewSession: 'Neue Sitzung starten',
    researchInProgressAria: 'Recherche läuft – bitte warten',
    researchInProgress: 'Recherche läuft',
    researchInProgressPopover:
      'Die Recherche läuft derzeit. Der Chat ist pausiert, um zu verhindern, dass mehrere Berichte gleichzeitig erstellt werden.',
    sendResponse: 'Antwort senden',
    sendMessage: 'Nachricht senden',
    sendQuery: 'Anfrage senden',
    responseInput: 'Antworteingabe',
    chatMessageInput: 'Chat-Nachrichteneingabe',
    stopStreaming: 'Antwort stoppen',
    sendWhilePending: 'Dateien werden noch verarbeitet – trotzdem senden?',
    removeFile: 'Datei entfernen: {name}',
    retryUpload: 'Upload erneut versuchen',
    manageFiles: 'Dateien verwalten',
    manageFilesCount: 'Angehängte Dateien verwalten ({count})',
    manageFilesMobile: '{count} Dateien verwalten',
    openFile: 'Datei öffnen: {name}',
    fileUploadingStatus: 'Wird hochgeladen',
    fileFailedStatus: 'Upload fehlgeschlagen',
    fileReadyStatus: 'Bereit',
  },

  reportCard: {
    reportWhenComplete: 'Der Bericht erscheint hier, sobald die Recherche abgeschlossen ist.',
    exportAsMdPdf: 'Sie können ihn als Markdown oder PDF exportieren.',
    draft: 'Entwurf',
    words: '{count} Wörter',
  },

  reportTab: {
    contentWhenAvailable: 'Berichtsinhalt erscheint hier, sobald verfügbar.',
    notesBanner: 'Zwischennotizen aus der Recherche – der finale Bericht wird noch erstellt.',
    sourcesTitle: 'Quellen',
    sourceBadge: {
      kb: 'Wissensbasis',
      web: 'Web',
      ris: 'RIS',
    },
  },

  /**
   * Die Gliederung über dem fertigen Bericht: die Überschriften des Berichts
   * als Sprungliste, mit einer Markierung auf dem Abschnitt, den die Leserin
   * gerade liest.
   */
  reportOutline: {
    label: 'Gliederung des Berichts',
    title: 'Gliederung',
    sectionCount: '{count} Abschnitte',
    show: 'Gliederung einblenden',
    hide: 'Gliederung ausblenden',
  },

  researchPanel: {
    closePanel: 'Recherchebereich schließen',
    openPanel: 'Recherchebereich öffnen',
    signInToAccess: 'Melden Sie sich an, um auf den Recherchebereich zuzugreifen',
    researching: 'Recherche läuft',
    tabTasks: 'Aufgaben',
    tabThinking: 'Denken',
    tabReport: 'Bericht',
    stopResearchingButton: 'Recherche stoppen',
    stopResearching: 'Recherche stoppen',
    stopConfirmTitle: 'Recherche stoppen?',
    stopConfirmBody:
      'Die laufende Recherche wird abgebrochen und kann nicht fortgesetzt werden. Der bisherige Teilfortschritt bleibt im Recherchebereich sichtbar.',
    stopConfirmConfirm: 'Recherche stoppen',
    noActiveResearch: 'Keine aktive Recherche',
    loadingData: 'Recherchedaten werden geladen',
    loadingDataEllipsis: 'Recherchedaten werden geladen...',
    loadingReport: 'Bericht wird geladen...',
    couldNotStop: 'Recherche konnte nicht gestoppt werden',
    couldNotStopDesc: 'Der Recherchedurchlauf läuft möglicherweise noch. Bitte versuchen Sie es erneut.',
  },

  sessionsPanel: {
    title: 'Chatverlauf',
    /** Steht neben dem Titel, damit der Bereich seinen eigenen Umfang nennt. */
    countLabel: '{count} Chats',
    countLabelOne: '1 Chat',
    // Der Speicher wird erst eingeblendet, wenn er relevant wird — und sagt dann,
    // was zu tun ist, statt nur eine Zahl zu melden.
    storageQuota: 'Browser-Speicher zu {percent}% belegt — alte Chats löschen schafft Platz.',
    storageNote:
      'Chats werden in diesem Browser gespeichert. Rechercheberichte können auf dem Server ablaufen.',
    deleteAllDisabled: 'Alle Chats dieses Projekts löschen (deaktiviert)',
    deleteAll: 'Alle Chats dieses Projekts löschen',
    cannotDeleteBusy: 'Löschen nicht möglich, während Vorgänge laufen',
    deleteAllButton: 'Alle Chats löschen',
    newSessionDisabled: 'Neuen Chat starten (während aktiver Vorgänge deaktiviert)',
    startNewSession: 'Neuen Chat starten',
    cannotCreateActive:
      'Es kann kein neuer Chat gestartet werden, solange dieser noch antwortet',
    newSessionButton: 'Neuer Chat',
    searchPlaceholder: 'Chats durchsuchen',
    searchAria: 'Chats durchsuchen',
    clearSearch: 'Suche zurücksetzen',
    /** Live-Trefferanzahl unter dem Suchfeld, solange eine Suche aktiv ist. */
    searchResults: '{count} von {total} Chats',
    noMatching: 'Keine passenden Chats',
    noMatchingDescription: 'Nichts in diesem Projekt passt zu „{query}“.',
    noSessions: 'Noch keine Chats',
    noSessionsDescription: 'Ihre Chats mit Piloti in diesem Projekt erscheinen hier.',
    /** Erklärt, warum alle Zeilen während einer Antwort ausgegraut sind. */
    navigationBlocked:
      'Piloti antwortet noch. Neue Chats und der Wechsel zwischen Chats pausieren bis zum Abschluss.',
    today: 'Heute',
    yesterday: 'Gestern',
    editTitle: 'Chat-Titel bearbeiten',
    untitledSession: 'Chat ohne Titel',
    renameDisabled: 'Chat umbenennen (deaktiviert)',
    rename: 'Chat umbenennen',
    cannotRenameBusy: 'Umbenennen nicht möglich, während Vorgänge laufen',
    deleteDisabled: 'Chat löschen (deaktiviert)',
    deleteSession: 'Chat löschen',
    sessionActive: 'Piloti arbeitet an diesem Chat',
    reportExpired: 'Bericht abgelaufen',
    reportCompleted: 'Bericht fertig',
    chatSession: 'Chat',
    sessionLabelBusy: 'Chat: {title} (Verarbeitung läuft)',
    sessionLabel: 'Chat: {title}',
    /** Dieselbe Zeile, ergänzt um den Zustand, den ihr Symbol zeigt. */
    sessionLabelWithStatus: 'Chat: {title} — {status}',
    // FB-10: Deep-Research-Bereich im Sitzungsbereich.
    deepResearchHeading: 'Deep Research ({count})',
    deepResearchChip: 'Deep Research',
    deepResearchRunLabel: 'Deep-Research-Durchlauf öffnen: {label} — {status}',
    /** Der Zustand eines Durchlaufs in Worten — das Symbol allein ließ „fehlgeschlagen“ und „fertig“ gleich aussehen. */
    runStatus: {
      running: 'Läuft',
      completed: 'Bericht fertig',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
  },

  taskCard: {
    statusComplete: 'abgeschlossen',
    statusInProgress: 'in Bearbeitung',
    statusPending: 'ausstehend',
    statusStopped: 'gestoppt',
    inProgress: 'In Bearbeitung',
    task: 'Aufgabe: {content}',
  },

  tasksTab: {
    title: 'Aufgaben',
    description:
      'Aufschlüsselung und Fortschritt des Rechercheplans während der Deep-Research-Ausführung.',
    empty: 'Rechercheaufgaben erscheinen hier.',
    emptyHelp:
      'Zeigt die Aufschlüsselung des Plans und den Fortschritt während der Deep-Research-Ausführung.',
    progressAria: 'Fortschritt der Aufgabenerledigung',
    elapsed: 'Läuft seit {minutes} Min.',
    writingReport: 'Finaler Bericht wird geschrieben... Dies kann einige Minuten dauern.',
    stalledTitle: 'Seit einer Weile keine Rückmeldung',
    stalledBody:
      'Die Recherche hat sich seit einiger Zeit nicht gemeldet. Sie läuft möglicherweise noch – stellen Sie die Verbindung wieder her, um die Live-Anzeige fortzusetzen.',
    connectionLostTitle: 'Verbindung zur laufenden Recherche verloren',
    connectionLostBody:
      'Die Live-Verbindung wurde unterbrochen, aber die Recherche läuft möglicherweise noch auf dem Server. Stellen Sie die Verbindung wieder her, um fortzufahren, oder stoppen Sie sie über die Leiste oben.',
    reconnect: 'Erneut verbinden',
    // Ergebnis einer Ausführung, die hier ohne eigenen Chat-Verlauf verfolgt
    // wird (Workflow-Ausführung) — sie hat kein Banner im Verlauf.
    attachedRunFinished: 'Diese Ausführung ist abgeschlossen. Der Bericht steht im Reiter „Bericht“.',
    attachedRunFailed: 'Diese Ausführung ist vor dem Abschluss fehlgeschlagen.',
    attachedRunStopped: 'Diese Ausführung wurde vor dem Abschluss gestoppt.',
  },

  thinkingTab: {
    tabThoughts: 'Gedanken',
    tabAgents: 'Agenten',
    tabTools: 'Werkzeuge',
    tabFiles: 'Dateien',
    tabRead: 'Gelesen',
    tabReferenced: 'Referenziert',
    referenced: 'Referenziert',
    sourcesRead: 'Gelesene Quellen',
    referencedSub: 'Im finalen Bericht referenzierte Quellen.',
    readSub:
      'Während der Recherche gefundene Quellen, die im finalen Bericht nicht referenziert wurden.',
    noReferenced: 'Keine referenzierten Quellen verfügbar.',
    noRead: 'Keine gelesenen Quellen verfügbar.',
  },

  /**
   * Der Abschnitt eines Recherchedurchlaufs, aus dem eine Karte stammt.
   *
   * Die Karten gaben bisher die rohe Kennung des Backends aus („über
   * researcher-agent“) — eine Kennung mitten im Satz, die niemand gelernt hat.
   * Hier steht stattdessen die Arbeit, in denselben Worten wie auf der übrigen
   * Recherchefläche. Eine Herkunft, für die dieser Build keinen Namen hat,
   * liest „intern“ — nie die Kennung. Siehe `features/layout/lib/workflow-names`.
   */
  workflowName: {
    planning: 'Planung',
    research: 'Recherche',
    sourceSelection: 'Quellenauswahl',
    writing: 'Berichtstext',
    internal: 'intern',
  },

  thoughtCard: {
    detailsWhenComplete: 'Details verfügbar, sobald die Generierung abgeschlossen ist',
    generating: 'Generiert',
    step: 'Schritt: {name}',
    tokens: 'Textmenge: {prompt} Eingabe / {completion} Ausgabe',
    output: 'Ausgabe',
  },

  thoughtTracesTab: {
    title: 'Gedankengang',
    runningCount: '{count} aktiv',
    description: 'Wie Piloti während der Recherche nachgedacht hat.',
    empty: 'Kein Gedankengang verfügbar.',
  },

  toolCallCard: {
    detailsWhenComplete: 'Details verfügbar, sobald der Werkzeugaufruf abgeschlossen ist',
    isRunning: '{name} läuft',
    step: 'Schritt: {name}',
    arguments: 'Argumente',
    result: 'Ergebnis',
    error: 'Fehler',
  },

  toolCallsTab: {
    title: 'Werkzeugaufrufe',
    runningCount: '{count} aktiv',
    description: 'Websuchen, Dateizugriffe und weitere Werkzeugaufrufe.',
    empty: 'Keine Werkzeugaufrufe verfügbar.',
  },

  sourceCard: {
    cited: 'Zitiert',
  },
}
