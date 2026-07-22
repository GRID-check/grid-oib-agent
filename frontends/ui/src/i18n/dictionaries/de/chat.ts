import type { en } from '../en'

/** chat namespace — populated during component i18n. */
export const chat: typeof en.chat = {
  actions: {
    dismiss: 'Schließen',
  },
  sourcePreview: {
    chipAria: 'Quelle ansehen: {label}',
    view: 'Ansehen',
    projectDocument: 'Projektunterlage',
    corpusDocument: 'Baurecht & Richtlinien',
    citedPassage: 'Fundstelle',
    loadFailed: 'Die Quellenvorschau konnte nicht geladen werden. Bitte versuchen Sie es erneut.',
    bindingLabel: 'Bindungswirkung',
    openExternal: 'Im RIS öffnen',
    origins: {
      kb: 'Projektwissen',
      ris: 'Recht & Richtlinien (RIS)',
      web: 'Webquelle',
    },
  },
  composer: {
    placeholder:
      'Beschreiben Sie, woran Sie gerade arbeiten — Piloti zeigt Ihnen Schritt für Schritt, was dafür relevant ist …',
    sources: 'Datengrundlage',
    sourcesAria: 'Datengrundlage – {enabled} von {total} Quellen aktiv. Öffnet die Datenquellen.',
    deepResearch: 'Deep Research',
    deepResearchAria: 'Deep-Research-Präferenz',
    deepResearchHint:
      'Präferenz vermerkt – Piloti eskaliert automatisch zu Deep Research, wenn eine Frage es erfordert.',
    scopeAria: 'Suchbereich: {project}',
    scopeFallback: 'Dieses Projekt',
    scopeCurrent: 'Aktuelles Projekt',
    scopeAll: 'Alle Projekte',
    scopeAllSoon: 'Bald verfügbar – projektübergreifende Suche ist noch nicht möglich.',
  },
  shortcuts: {
    label: 'Schnellzugriff',
    presetAria: 'Quellen-Voreinstellung: {label}',
    presets: {
      law: 'Baurecht & Richtlinien',
      project: 'Projektunterlagen',
      office: 'Büroarchiv',
    },
  },
  greeting: {
    morning: 'Guten Morgen',
    afternoon: 'Guten Tag',
    evening: 'Guten Abend',
    withName: '{greeting}, {name}.',
    subtitle: 'Fragen Sie zu Ihrem Projekt – Antworten belegen ihre Quellen.',
  },
  // Empty-state lock chip + thread role tabs (click-dummy overhaul, WS-3).
  workspace: {
    private: 'Privater Workspace',
  },
  roles: {
    input: 'Eingabe',
    result: 'Ergebnis',
    // Rollen-Tab für eine konversationelle / klärende Antwort (routing_decision
    // = 'meta': Begrüßungen, Fähigkeits- und Rückfragen) — deutlich abgesetzt
    // von einem inhaltlichen Baurecht-'Ergebnis'.
    note: 'Hinweis',
  },
  answerSources: {
    label: 'Belegt durch',
    ariaLabel: 'Quellen, auf die sich diese Antwort stützt',
    // Hinweis unter der Quellenzeile, wenn die Zitatprüfung nicht belegbare
    // Quellenangaben entfernt hat (WP-A `citations_removed`).
    citationsRemoved: '{count} Quellenangabe(n) entfernt (nicht verifizierbar)',
    citationsRemovedReasonsLabel: 'Gründe',
  },
  breadcrumb: {
    ariaLabel: 'Navigationspfad',
    renameAria: 'Sitzung umbenennen – zum Bearbeiten klicken',
    renameInputAria: 'Sitzungstitel',
  },
  cards: {
    aiGenerated:
      'KI-generierte Zitierung — prüfen Sie den Auszug anhand der Primärquelle (OIB / RIS).',
    legalBasis: 'Rechtsgrundlage',
    viewOib: 'OIB-Richtlinie ansehen',
    verifyRis: 'In RIS prüfen',
  },
  agentPrompt: {
    needsInput: 'Der Agent benötigt Ihre Eingabe',
    receivedInput: 'Der Agent hat Ihre Eingabe erhalten',
    approve: 'Genehmigen',
    reject: 'Ablehnen',
    approvePlan: 'Plan genehmigen',
    rejectPlan: 'Plan ablehnen',
    selectOption: 'Option auswählen: {option}',
    yourResponse: 'Ihre Antwort:',
    approvalInstruction:
      'Wählen Sie „Genehmigen“, um die Recherche zu starten, oder „Ablehnen“, um abzubrechen.',
    durationHint:
      'Die Deep-Research-Ausführung kann mehrere Minuten dauern und verbraucht Kontingent.',
  },
  agentResponse: {
    viewProgress: 'Fortschritt anzeigen',
    viewReport: 'Bericht anzeigen',
    loading: 'Wird geladen …',
    loadingLabel: 'Wird geladen',
    errorTitle: 'Fehler: {message}',
  },
  profilePatchCard: {
    accept: 'Übernehmen',
    applying: 'Wird übernommen …',
    reject: 'Ablehnen',
    accepted: 'Projekt-Briefing aktualisiert.',
    rejected: 'Änderungen verworfen.',
    noProject: 'Öffnen Sie diesen Chat aus einem Projekt, um Briefing-Änderungen zu übernehmen.',
    field: 'Feld',
    before: 'Vorher',
    after: 'Nachher',
    applyFailed: 'Änderung konnte nicht übernommen werden',
  },
  memoryProposal: {
    title: 'Diese Erkenntnis merken?',
    prompt: 'Möchten Sie das organisationsweit merken?',
    yes: 'Ja, organisationsweit merken',
    no: 'Nein',
    saving: 'Wird gespeichert …',
    saveToProject: 'Nur in diesem Projekt speichern',
    savedOrg: 'Im Organisationsgedächtnis gespeichert (organisationsweit).',
    savedProject: 'Im Gedächtnis dieses Projekts gespeichert.',
    dismissed: 'Nicht gespeichert.',
    error: 'Erkenntnis konnte nicht gespeichert werden',
    kind: {
      decision: 'Entscheidung',
      constraint: 'Vorgabe',
      open_question: 'Offene Frage',
      derived_fact: 'Abgeleiteter Fakt',
      preference: 'Präferenz',
    },
  },
  thinking: {
    inProgress: 'Denkvorgang läuft',
    working: 'Antwort wird erstellt …',
    waiting: 'Warten auf Antwort',
    elapsedAria: 'Vergangen: {seconds} Sekunden',
    // Live-Einzeiler, was der Assistent gerade tut, aus dem neuesten Schritt
    // abgeleitet. `runningNamed` ist der ehrliche Fallback für einen Schritt,
    // den wir nicht klassifizieren können.
    activity: {
      understanding: 'Frage wird erfasst …',
      planning: 'Vorgehen wird geplant …',
      searchingWeb: 'Web wird durchsucht …',
      searchingSources: 'Quellen werden durchsucht …',
      researching: 'Recherche läuft …',
      reading: 'Ergebnisse werden gelesen …',
      composing: 'Antwort wird formuliert …',
      runningNamed: '{name} …',
    },
    interrupted: 'Unterbrochen',
    // Kompakter Inline-Hinweis auf einer unterbrochenen Antwort: eine stille
    // Wiederverbindung kann eine laufende Antwort verwerfen (Protokoll-
    // Robustheit, Punkt 4). Statt nur des stummen „Unterbrochen“-Chips.
    interruptedNotice:
      'Verbindung kurz unterbrochen — Antwort ging verloren. Bitte erneut senden.',
    // Vorübergehender „Wird geprüft“-Zustand (FIX 3): angezeigt, solange der
    // Wiederherstellungs-Abruf nach einer Wiederverbindung läuft, damit ein
    // Zug, der nur unterbrochen AUSSIEHT, nicht sofort den „verloren“-Hinweis
    // zeigt, bevor bestätigt ist, dass die Antwort wirklich fehlt.
    recovering: 'Verbindung wird wiederhergestellt',
    recoveringNotice:
      'Verbindung wird wiederhergestellt — prüfe auf fertige Antwort …',
    done: 'Fertig',
    showThinking: 'Denkschritte anzeigen ({count})',
    showThinkingSteps: 'Denkschritte anzeigen ({count})',
    herleitungSummary: 'Herleitung · {steps} Zwischenschritte · {sources} Quellen',
    stepsLabel: 'Denkschritte',
    stepsHeading: 'Zwischenschritte',
    sourcesFanOut: 'Quellen',
    hitCount: '{count} Treffer',
    gapHit: 'Nicht im Bestand',
    moreSources: '+{count} weitere',
    selectedDataSources: 'Ausgewählte Datenquellen:',
    // „Warum dieser Weg?“ — die Routing-Einordnung dieses Turns (WP-A
    // `routing_decision` + `routing_reason`), im Herleitungs-Rahmenknoten.
    routing: {
      whyLabel: 'Warum dieser Weg?',
      line: 'Einordnung: {decision} — {reason}',
      decision: {
        meta: 'Direktantwort',
        shallow: 'Kurzrecherche',
        deep: 'Tiefenrecherche',
        error: 'Fehler',
      },
    },
    // Einzeiler, wenn dieser Turn von der Kurz- zur Tiefenrecherche eskaliert ist.
    escalationNarration: 'Eskaliert zur Tiefenrecherche: {reason}',
    dataSource: {
      webSearch: 'Websuche',
      knowledgeBase: 'OIB-Wissensdatenbank',
      ris: 'RIS (Österreichisches Recht)',
    },
    node: {
      framingTab: 'Zwischenschritt',
      framingTitle: 'Frage verstanden',
      framingQuestion: 'Du fragst: „{question}“',
      contextLabel: 'Kontext',
      sourcesTab: 'Quellen',
      sourcesTitle: 'Geprüfte Quellen',
      findingsTab: 'Einschätzung',
      findingsTitle: 'Belegt durch',
      confidenceLabel: 'Belegt',
      confidence: {
        high: 'Gut belegt',
        medium: 'Teilweise belegt',
        low: 'Schwach belegt',
      },
      branchesTab: 'Folgewege',
      branchesTitle: 'Wie willst du weiter vorgehen?',
      branchesSub: 'Wähle eine Option — das Ergebnis wird für deine Wahl zusammengestellt.',
    },
  },
  deepResearch: {
    stats: {
      tokens: '{count} Tokens',
      toolCalls: '{count} Tool-Aufrufe',
    },
    success: {
      heading: 'Bericht abgeschlossen!{stats}',
      subheading:
        'Die Recherche ist abgeschlossen und ein Bericht steht im Recherchebereich zur Ansicht bereit.',
    },
    failure: {
      heading: 'Bericht konnte nicht abgeschlossen werden',
      subheading:
        'Etwas hat den Abschluss des Rechercheberichts verhindert. Prüfen Sie die Denkschritte für Details.',
    },
    cancelled: {
      heading: 'Recherche abgebrochen',
      subheading:
        'Die Recherche wurde vom Benutzer gestoppt. Sie können den Teilfortschritt im Recherchebereich ansehen.',
    },
    expired: {
      heading: 'Bericht abgelaufen',
      subheading: 'Der Bericht ist abgelaufen und nicht mehr verfügbar.',
    },
    starting: {
      heading: 'Deep Research wird gestartet',
      subheading:
        'Der Chat ist pausiert, während der Bericht erstellt wird, um zu verhindern, dass mehrere Berichte generiert werden. Sie können den Tab verlassen, während dies läuft – es kann mehrere Minuten dauern.',
    },
    viewReport: 'Bericht anzeigen',
    viewThinking: 'Denkschritte anzeigen',
    viewProgress: 'Fortschritt anzeigen',
    // Einzeiler über dem „Deep Research wird gestartet“-Banner, wenn der Turn
    // von der Kurz- zur Tiefenrecherche eskaliert ist (WP-A `escalation_reason`).
    escalationNarration: 'Eskaliert zur Tiefenrecherche: {reason}',
  },
  error: {
    showDetails: 'Details anzeigen',
    hideDetails: 'Details ausblenden',
  },
  errorRegistry: {
    connectionLost: {
      title: 'Verbindung getrennt',
      message: 'Die Verbindung zum Server wurde getrennt. Bitte überprüfen Sie Ihr Netzwerk.',
    },
    connectionFailed: {
      title: 'Verbindung fehlgeschlagen',
      message:
        'Verbindung zum Server nicht möglich. Bitte überprüfen Sie Ihre Netzwerkverbindung.',
    },
    connectionTimeout: {
      title: 'Zeitüberschreitung der Anfrage',
      message: 'Die Anfrage hat zu lange gedauert.',
    },
    sessionExpired: {
      title: 'Sitzung abgelaufen',
      message: 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
    },
    unauthorized: {
      title: 'Nicht autorisiert',
      message: 'Sie haben keine Berechtigung, diese Aktion auszuführen.',
    },
    responseFailed: {
      title: 'Antwort fehlgeschlagen',
      message: 'Beim Erstellen einer Antwort ist beim Assistenten ein Fehler aufgetreten.',
    },
    responseInterrupted: {
      title: 'Antwort unterbrochen',
      message: 'Ihre vorherige Anfrage wurde nicht abgeschlossen. Bitte senden Sie Ihre Nachricht erneut.',
    },
    workflowError: {
      title: 'Anfrage fehlgeschlagen',
      message:
        'Beim Bearbeiten Ihrer Anfrage ist beim Assistenten ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    },
    deepResearchFailed: {
      title: 'Deep Research fehlgeschlagen',
      message: 'Beim Deep-Research-Vorgang ist ein Fehler aufgetreten.',
    },
    deepResearchLoadFailed: {
      title: 'Recherchedaten nicht verfügbar',
      message:
        'Recherchedaten konnten nicht geladen werden. Der Auftrag ist möglicherweise abgelaufen oder wurde gelöscht.',
    },
    unknown: {
      title: 'Etwas ist schiefgelaufen',
      message: 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.',
    },
    // Deep-Research-Auftrag wurde abgelehnt, weil die Warteschlange voll ist
    // (WP-A `job_admission_rejected`). Warnung, nicht Fehler: erneut senden hilft.
    researchQueueFull: {
      title: 'Recherche ausgelastet',
      message:
        'Die Recherche-Warteschlange ist gerade voll. Bitte sende deine Anfrage in einem Moment erneut.',
      retryHint: 'Bitte in etwa {seconds} Sekunden erneut senden.',
    },
  },
  deepResearchErrors: {
    interrupted: 'Die Recherche wurde vor dem Abschluss unterbrochen.',
    reportUnavailable: 'Dieser Recherchebericht ist nicht mehr verfügbar.',
    serviceUnreachable:
      'Der Dienst ist derzeit nicht erreichbar. Bitte versuchen Sie es später erneut.',
    jobStillRunning:
      'Die Recherche läuft noch. Der Bericht kann geöffnet werden, sobald sie abgeschlossen ist.',
    loadFailed: 'Recherchedaten konnten nicht geladen werden.',
  },
  sessionActions: {
    researchMayStillRunTitle: 'Recherche-Ausführung läuft möglicherweise noch',
    researchMayStillRunDescription:
      'Die Sitzung wurde gelöscht, aber der zugehörige Deep-Research-Auftrag konnte auf dem Server nicht gestoppt werden.',
    researchRunsMayStillRunTitle: 'Möglicherweise laufen noch {count} Recherche-{runLabel}',
    researchRunsMayStillRunDescription:
      'Die Sitzungen wurden gelöscht, aber einige Deep-Research-Aufträge konnten auf dem Server nicht gestoppt werden.',
    runSingular: 'Ausführung',
    runPlural: 'Ausführungen',
  },
  budgetExhausted: {
    title: 'Budget aufgebraucht',
    memberMessage:
      'Ihr LLM-Budget ist aufgebraucht, daher können derzeit keine neuen Nachrichten gesendet werden. Ihren eigenen Verbrauch finden Sie unter Organisation → Verbrauch & Budgets. Bitten Sie eine Organisations-Administratorin oder einen -Administrator, Ihr Limit zu erhöhen.',
    adminMessage:
      'Das LLM-Budget ist aufgebraucht, daher können derzeit keine neuen Nachrichten gesendet werden. Erhöhen Sie die Limits unter Organisation → Verbrauch & Budgets.',
  },
  fileUpload: {
    uploading:
      'Die Datei wird hochgeladen und verarbeitet. Bis zum Abschluss kann eine Datei nicht in Abfragen einbezogen werden.',
    pendingWarning:
      'Dateien stehen noch aus! Warten Sie, bis sie bereit sind, oder senden Sie Ihre Abfrage erneut, um OHNE diese Dateien fortzufahren.',
  },
  noSources: {
    warning:
      'Keine Datenquellen ausgewählt und keine Dateien verfügbar. Antworten sind eher ungenau oder veraltet, sofern keine externen Datenquellen hinzugefügt werden.',
  },
  memory: {
    noted: 'Piloti hat sich gemerkt',
    notedAria: 'Piloti hat sich {count} Notizen gemerkt',
    addedToMemory: 'In das Projektgedächtnis aufgenommen',
    manageHint: 'Diese Einträge können Sie im Projektgedächtnis verwalten und löschen.',
    kinds: {
      decision: 'Entscheidung',
      constraint: 'Vorgabe',
      open_question: 'Offene Frage',
      derived_fact: 'Fakt',
      preference: 'Präferenz',
    },
    provenance: {
      distillation: 'nach der Antwort ergänzt',
      inTurn: 'während der Antwort notiert',
    },
  },
  confidence: {
    label: 'Einschätzung: {level}',
    levels: {
      high: 'hoch',
      medium: 'mittel',
      low: 'niedrig',
    },
    ariaLabel: 'Selbsteinschätzung des Assistenten: {level}',
    tooltip:
      'Die eigene Einschätzung des Assistenten, wie gut diese Antwort durch seine Quellen gestützt ist. Sie kann falsch sein.',
    // Zusatzsatz, der im Tooltip erklärt, WARUM die Einschätzung gedeckelt
    // wurde, je nach `answer_confidence_capped_reason` (WP-A, PB-9).
    cappedReasons: {
      ungrounded: 'Geringe Sicherheit: Antwort nicht durch Quellen belegt.',
      quoteUnverified:
        'Geringe Sicherheit: ein Zitat konnte nicht wörtlich in der Quelle bestätigt werden.',
    },
  },
  // Antwort-Feedback per Daumen (WS-7, Feature-Flag `answer-feedback`).
  feedback: {
    question: 'War das hilfreich?',
    helpfulAria: 'Diese Antwort als hilfreich markieren',
    notHelpfulAria: 'Diese Antwort als nicht hilfreich markieren',
    reasonPrompt: 'Was war das Problem?',
    reasons: {
      inaccurate: 'Ungenau',
      too_slow: 'Zu langsam',
      wrong_source: 'Falsche Quelle',
      other: 'Sonstiges',
    },
    thanks: 'Danke für Ihr Feedback.',
  },
}
