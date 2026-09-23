import type { en } from '../en'

/** The research workspace: chat shell, panels, and deep-research detail views. */
export const research: typeof en.research = {
  dismissError: 'Fehler ausblenden',

  detailsHelp:
    'Diese Details erscheinen während einer laufenden Recherche und sind für abgeschlossene Berichte möglicherweise nicht verfügbar.',

  // Label for a run whose chat has no local title (headless/CLI jobs).
  runsList: {
    untitledRun: 'Deep-Research-Durchlauf',
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
      'Melden Sie sich an, um den Projekt-Arbeitsbereich freizuschalten: Ihre Unterlagen, das Büroarchiv und den Vorschriftenkorpus.',
    signInSso: 'Mit SSO anmelden',
    welcomeTitle: 'Wie kann Piloti bei Ihrem Projekt helfen?',
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
    /** The persistent "still working" signal while a run is going in the thread. */
    researching: 'Recherche läuft',
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
    overflowAria: '{count, plural, one {# weitere Quellenart} other {# weitere Quellenarten}}',
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
      countSessions:
        '{count, plural, one {der eine Chat dieses Projekts} other {alle # Chats dieses Projekts}}',
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





  fileCard: {
    lines: '{count, plural, one {# Zeile} other {# Zeilen}}',
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
    subjectCleared: 'Frage bezieht sich nicht mehr auf diese Datei.',
    subjectClearedUndo: 'Rückgängig',
    aiDisclosure:
      'Piloti ist ein KI-System — Antworten können falsch sein; prüfen Sie sie anhand der zitierten Unterlagen.',
    placeholderDefault: 'Datenquellen prüfen und eine Recherchefrage stellen...',
    signInToStart: 'Melden Sie sich an, um zu beginnen',
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
    sendResponse: 'Antwort senden',
    sendMessage: 'Nachricht senden',
    sendQuery: 'Anfrage senden',
    responseInput: 'Antworteingabe',
    chatMessageInput: 'Chat-Nachrichteneingabe',
    stopStreaming: 'Antwort stoppen',
    sendWhilePending: 'Dateien werden noch verarbeitet – trotzdem senden?',
    heldForUpload: 'Wird gesendet, sobald die Datei gelesen ist.',
    heldForUploadSendNow: 'Jetzt ohne die Datei fragen',
    removeFile: 'Datei entfernen: {name}',
    retryUpload: 'Upload erneut versuchen',
    manageFiles: 'Dateien verwalten',
    manageFilesCount: 'Angehängte Dateien verwalten ({count})',
    manageFilesMobile: '{count, plural, one {# Datei} other {# Dateien}} verwalten',
    openFile: 'Datei öffnen: {name}',
    fileUploadingStatus: 'Wird hochgeladen',
    fileFailedStatus: 'Upload fehlgeschlagen',
    fileReadyStatus: 'Bereit',
  },





  sessionsPanel: {
    title: 'Chatverlauf',
    /** Schließen-Steuerung des Sheets (Grabber-Pille + Desktop-X). */
    close: 'Chatverlauf schließen',
    /** Steht neben dem Titel, damit der Bereich seinen eigenen Umfang nennt. */
    countLabel: '{count, plural, one {# Chat} other {# Chats}}',
    countLabelOne: '1 Chat',
    // Chats werden serverseitig gespeichert (Postgres via /api/conversations) —
    // diese Zeile darf nie behaupten, sie lägen im Browser, und nie raten,
    // Chats zu löschen, um lokalen Platz zu schaffen: Löschen entfernt auch die
    // Server-Kopie.
    syncedNote:
      'Chats werden in Ihrem Workspace gespeichert und sind auf allen Geräten verfügbar. Rechercheberichte können auf dem Server ablaufen.',
    deleteAllDisabled: 'Alle Chats dieses Projekts löschen (deaktiviert)',
    deleteAll: 'Alle Chats dieses Projekts löschen',
    cannotDeleteBusy: 'Löschen nicht möglich, während Vorgänge laufen',
    deleteAllButton: 'Alle Chats löschen',
    /** Stopp-Aktion für einen blockierten Deep-Research-Durchlauf (Chatzeile, Durchlaufzeile). */
    stopResearch: 'Recherche stoppen',
    stopResearchTitle: 'Diesen Recherchedurchlauf stoppen',
    /** Stopping cancels server-side work that cannot be resumed (shared ConfirmDialog, warning tone). */
    stopConfirmTitle: 'Recherche stoppen?',
    stopConfirmBody:
      'Die laufende Recherche wird abgebrochen und kann nicht fortgesetzt werden. Der bisherige Teilfortschritt bleibt im Recherchebereich sichtbar.',
    stopConfirmConfirm: 'Recherche stoppen',
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
    reportCompleted: 'Bericht fertig',
    chatSession: 'Chat',
    sessionLabelBusy: 'Chat: {title} (Verarbeitung läuft)',
    sessionLabel: 'Chat: {title}',
    /** Dieselbe Zeile, ergänzt um den Zustand, den ihr Symbol zeigt. */
    sessionLabelWithStatus: 'Chat: {title} — {status}',
    // FB-10: Deep-Research-Bereich im Sitzungsbereich. Die Anzahl trägt ein
    // CountPill neben der Überschrift, nicht der Text selbst.
    deepResearchHeading: 'Deep Research',
    deepResearchChip: 'Deep Research',
    deepResearchRunLabel: 'Deep-Research-Durchlauf öffnen: {label} — {status}',
    /** Bereichsfilter über die eine Liste — Chats, Durchläufe oder beides. */
    filterAria: 'Verlauf filtern',
    filterAll: 'Alle',
    filterChats: 'Chats',
    filterResearch: 'Deep Research',
    /** Ein fehlgeschlagener Abruf sagt es — ein leerer Bereich würde ihn verschweigen. */
    researchLoadFailed: 'Deep-Research-Durchläufe konnten nicht geladen werden.',
    noRuns: 'Noch keine Deep-Research-Durchläufe',
    noRunsDescription: 'Deep-Research-Durchläufe aus diesem Projekt erscheinen hier.',
    /** Der Zustand eines Durchlaufs in Worten — das Symbol allein ließ „fehlgeschlagen“ und „fertig“ gleich aussehen. */
    runStatus: {
      running: 'Läuft',
      completed: 'Bericht fertig',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
  },









}
