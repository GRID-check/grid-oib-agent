import type { en } from '../en'

/** The research workspace: chat shell, panels, and deep-research detail views. */
export const research: typeof en.research = {
  dismissError: 'Fehler ausblenden',

  runsPage: {
    title: 'Recherchedurchläufe',
    subtitle:
      'Deep-Research-Berichte, die Grid für dieses Projekt erstellt hat, neueste zuerst.',
  },

  dockedPanel: {
    closePanel: 'Bereich schließen',
  },

  chatArea: {
    ariaMessages: 'Chat-Nachrichten',
    secureWorkspace: 'sicherer Arbeitsbereich',
    loggedOutTitle: 'Grid wird verfügbar, sobald Ihre Organisation verifiziert ist.',
    loggedOutBody:
      'Melden Sie sich an, um projektbezogene OIB-Recherche, Dokumenten-Ingestion und Zugriffskontrollen für Mitglieder freizuschalten.',
    signInSso: 'Mit SSO anmelden',
    featureWorkos: 'WorkOS-Authentifizierung',
    featureRetrieval: 'Projektbezogene Suche',
    featureRbac: 'Rollenbasierter Zugriff',
    cockpit: 'OIB-Recherche-Cockpit',
    title: 'Beginnen Sie mit einem Projekt und fragen Sie nach belegter baurechtlicher Argumentation.',
    body: 'Grid hält die Suche auf den ausgewählten Arbeitsbereich beschränkt und verwandelt lange Richtliniendokumente in nachvollziehbare Entscheidungen.',
    openProjects: 'Projekte öffnen',
    openProjectsDesc: 'Arbeitsbereiche anlegen, Dokumente verwalten und Rollen einladen.',
    selectContext: 'Kontext auswählen',
    selectContextDesc: 'Nutzen Sie die Arbeitsbereichsauswahl, bevor Sie eine Analyse starten.',
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
    toggleSessions: 'Sitzungsleiste umschalten',
    signInToView: 'Melden Sie sich an, um Sitzungen anzuzeigen',
    sessions: 'Sitzungen',
    addSources: 'Datenquellen hinzufügen',
    signInToManage: 'Melden Sie sich an, um Datenquellen zu verwalten',
    sources: 'Quellen',
    research: 'Recherche',
  },

  dataSources: {
    loading: 'Datenquellen werden geladen',
    loadingEllipsis: 'Datenquellen werden geladen...',
    unableToLoad: 'Datenquellen konnten nicht geladen werden',
    retryAria: 'Laden der Datenquellen erneut versuchen',
    none: 'Keine Datenquellen verfügbar',
    changesDisabledBusy: 'Änderungen an Datenquellen sind während aktiver Vorgänge deaktiviert',
  },

  dataConnectionCard: {
    enabled: 'aktiviert',
    disabled: 'deaktiviert',
    disabledParenthetical: '(deaktiviert)',
    noPermission: 'Sie haben keine Berechtigung, auf diese Datenquelle zuzugreifen',
    enableName: '{name} aktivieren',
    disableName: '{name} deaktivieren',
    nameDisabled: '{name} (deaktiviert)',
  },

  dataConnectionsTab: {
    availableSources: 'Verfügbare Quellen ({count})',
  },

  dataSourcesPanel: {
    title: 'Datenquellen',
    footerConnections:
      '{enabled} von {available} verfügbaren Verbindungen aktiviert. Aktivierte Verbindungen stehen dem KI-Assistenten zur Verfügung.',
    footerFiles: 'Angehängte Dateien stehen den Agenten bis zur Löschung dauerhaft zur Verfügung.',
    tabConnections: 'Verbindungen',
    tabFiles: 'Dateien',
    enableAuthBanner: 'Aktivieren Sie die Authentifizierung, um auf weitere Datenquellen zuzugreifen.',
    signInBanner: 'Melden Sie sich an, um auf weitere Datenquellen zuzugreifen.',
    allConnections: 'Alle Verbindungen',
    allAvailableDisabledOps: 'Alle verfügbaren Verbindungen (während Vorgängen deaktiviert)',
    allAvailableState: 'Alle verfügbaren Verbindungen: {state}',
    disableEnableAll: 'Alle deaktivieren / aktivieren',
    toggleAllDisabled: 'Alle Verbindungen umschalten (deaktiviert)',
    disableAll: 'Alle Verbindungen deaktivieren',
    enableAll: 'Alle Verbindungen aktivieren',
    individualConnections: 'Einzelne Verbindungen ({count})',
    signInRequiredSource: 'Anmeldung erforderlich, um auf diese Datenquelle zuzugreifen',
  },

  deleteModals: {
    cannotReverse:
      'Diese Aktion kann nicht rückgängig gemacht werden. Sind Sie sicher, dass Sie dies tun möchten?',
    aboutToDelete: 'Sie sind dabei,',
    lossSuffix:
      ' zu löschen. Dabei gehen sämtliche Fortschritte verloren und alle von Ihnen angehängten Dateien werden entfernt.',
    all: {
      title: 'Alle Sitzungen löschen',
      countSessions: 'alle {count} Sitzungen',
      allSessions: 'ALLE Sitzungen',
      confirm: 'ALLE Sitzungen löschen',
    },
    file: {
      title: 'Datei löschen',
      thisFile: 'diese Datei',
      suffix: ' zu löschen. Sie wird damit vollständig aus Ihrer Sitzung entfernt.',
      confirm: 'Datei löschen',
    },
    session: {
      title: 'Sitzung löschen',
      thisSession: 'diese Sitzung',
      confirm: 'Sitzung löschen',
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
    description: 'Aktive Planer-, Rechercheur- und Autoren-Agenten führen Aufgaben aus.',
    empty: 'Keine Agentenaktivität verfügbar.',
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
  },

  fileSourcesTab: {
    uploadTo: 'Hochladen nach',
    targetProject: 'Projekt-Korpus',
    targetSession: 'Private Sitzung',
    targetProjectLower: 'Projekt-Korpus',
    targetSessionLower: 'private Sitzung',
    availableInProject: 'In diesem Projekt verfügbar.',
    preparingCorpus: 'Projekt-Korpus wird vorbereitet...',
    onlyThisSession: 'Nur in dieser Chat-Sitzung verfügbar.',
    loadingFiles: 'Dateien werden geladen',
    checkingFiles: 'Dateien werden geprüft...',
    setupBackend: 'Richten Sie das Backend ein, um Dateien zu aktivieren.',
    noAttachedFiles: 'Keine angehängten Dateien',
    filesGoTo: 'Hier hochgeladene Dateien gelangen in {target}, sofern nicht entfernt.',
    filesCount: '{target} – Dateien ({count})',
    loadingFilesEllipsis: 'Dateien werden geladen...',
    addFiles: 'Dateien hinzufügen',
    uploadNotAvailable: 'Datei-Upload nicht verfügbar',
    addFile: '+ Datei hinzufügen',
  },

  inputArea: {
    placeholderDefault: 'Datenquellen prüfen und eine Recherchefrage stellen...',
    signInToStart: 'Melden Sie sich an, um mit der Recherche zu beginnen',
    researchCompletedNewSession:
      'Recherche abgeschlossen. Erstellen Sie für weitere Fragen eine neue Sitzung.',
    typeResponse: 'Geben Sie Ihre Antwort an den Agenten ein...',
    pleaseWait: 'Bitte warten...',
    messageNotSent: 'Nachricht nicht gesendet',
    messageNotSentDesc:
      'Beim Senden Ihrer Nachricht ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    unsupportedFileType: 'Nicht unterstützter Dateityp',
    dropToUpload: 'Dateien zum Hochladen ablegen',
    accepts: 'Akzeptiert: {types}',
    toggleDataSources: 'Datenquellen-Verbindungen umschalten',
    selectedConnections: 'Ausgewählte Datenverbindungen',
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
    researchInProgressAria: 'Recherche läuft – bitte warten',
    researchInProgress: 'Recherche läuft',
    researchInProgressPopover:
      'Die Recherche läuft derzeit. Der Chat ist pausiert, um zu verhindern, dass mehrere Berichte gleichzeitig erstellt werden.',
    sendResponse: 'Antwort senden',
    sendMessage: 'Nachricht senden',
    sendQuery: 'Anfrage senden',
    responseInput: 'Antworteingabe',
    chatMessageInput: 'Chat-Nachrichteneingabe',
  },

  reportCard: {
    reportWhenComplete: 'Der Bericht erscheint hier, sobald die Recherche abgeschlossen ist.',
    exportAsMdPdf: 'Sie können ihn als Markdown oder PDF exportieren.',
    draft: 'Entwurf',
    words: '{count} Wörter',
  },

  reportTab: {
    contentWhenAvailable: 'Berichtsinhalt erscheint hier, sobald verfügbar.',
    notesBanner: 'Rechercheanmerkungen der Agenten – der finale Bericht wird noch erstellt.',
  },

  researchPanel: {
    closePanel: 'Recherchebereich schließen',
    openPanel: 'Recherchebereich öffnen',
    signInToAccess: 'Melden Sie sich an, um auf den Recherchebereich zuzugreifen',
    researching: 'Recherchiert',
    tabTasks: 'Aufgaben',
    tabThinking: 'Denken',
    tabReport: 'Bericht',
    stopResearchingButton: 'Recherche stoppen',
    stopResearching: 'Recherche stoppen',
    noActiveResearch: 'Keine aktive Recherche',
    loadingData: 'Recherchedaten werden geladen',
    loadingDataEllipsis: 'Recherchedaten werden geladen...',
    loadingReport: 'Bericht wird geladen...',
    couldNotStop: 'Recherche konnte nicht gestoppt werden',
    couldNotStopDesc: 'Der Recherchedurchlauf läuft möglicherweise noch. Bitte versuchen Sie es erneut.',
  },

  sessionsPanel: {
    title: 'Sitzungen',
    storageQuota: '{percent}% des Browser-Speicherkontingents belegt',
    storageNote:
      'Hinweis: Chat-Sitzungen werden in diesem Browser gespeichert. Rechercheberichte können auf dem Server ablaufen.',
    deleteAllDisabled: 'Alle Sitzungen löschen (deaktiviert)',
    deleteAll: 'Alle Sitzungen löschen',
    cannotDeleteBusy: 'Löschen nicht möglich, während Vorgänge laufen',
    deleteAllButton: 'Alle löschen',
    newSessionDisabled: 'Neue Sitzung starten (während aktiver Vorgänge deaktiviert)',
    startNewSession: 'Neue Sitzung starten',
    cannotCreateActive:
      'Es kann keine neue Sitzung erstellt werden, solange die aktuelle Sitzung aktiv ist',
    newSessionButton: 'Neue Sitzung',
    searchPlaceholder: 'Sitzungen durchsuchen...',
    searchAria: 'Sitzungen durchsuchen',
    noMatching: 'Keine passenden Sitzungen',
    noSessions: 'Noch keine Sitzungen',
    startNewSessionButton: 'Neue Sitzung starten',
    today: 'Heute',
    yesterday: 'Gestern',
    editTitle: 'Sitzungstitel bearbeiten',
    renameDisabled: 'Sitzung umbenennen (deaktiviert)',
    rename: 'Sitzung umbenennen',
    cannotRenameBusy: 'Umbenennen nicht möglich, während Vorgänge laufen',
    deleteDisabled: 'Sitzung löschen (deaktiviert)',
    deleteSession: 'Sitzung löschen',
    sessionActive: 'Sitzung aktiv',
    reportExpired: 'Bericht abgelaufen',
    reportCompleted: 'Bericht abgeschlossen',
    chatSession: 'Chat-Sitzung',
    sessionLabelBusy: 'Sitzung: {title} (Verarbeitung läuft)',
    sessionLabel: 'Sitzung: {title}',
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
    description: 'Aufschlüsselung und Fortschritt des Rechercheplans während der Deep Research.',
    empty: 'Rechercheaufgaben erscheinen hier.',
    emptyHelp: 'Zeigt die Aufschlüsselung des Plans und den Fortschritt während der Deep Research.',
    progressAria: 'Fortschritt der Aufgabenerledigung',
    writingReport: 'Finaler Bericht wird geschrieben... Dies kann einige Minuten dauern.',
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

  thoughtCard: {
    detailsWhenComplete: 'Details verfügbar, sobald die Generierung abgeschlossen ist',
    generating: 'Generiert',
    via: 'über {workflow}',
    tokens: 'Tokens: {prompt} rein / {completion} raus',
    output: 'Ausgabe',
  },

  thoughtTracesTab: {
    title: 'Gedankenspuren',
    runningCount: '{count} aktiv',
    description: 'Gedankenkette und Inferenzaktivität des LLM.',
    empty: 'Keine Gedankenspuren verfügbar.',
  },

  toolCallCard: {
    detailsWhenComplete: 'Details verfügbar, sobald der Werkzeugaufruf abgeschlossen ist',
    isRunning: '{name} läuft',
    via: 'über {workflow}',
    arguments: 'Argumente',
    result: 'Ergebnis',
    error: 'Fehler',
  },

  toolCallsTab: {
    title: 'Werkzeugaufrufe',
    runningCount: '{count} aktiv',
    description: 'Websuchen, Dateioperationen und andere Werkzeugaufrufe.',
    empty: 'Keine Werkzeugaufrufe verfügbar.',
  },

  sourceCard: {
    cited: 'Zitiert',
  },
}
