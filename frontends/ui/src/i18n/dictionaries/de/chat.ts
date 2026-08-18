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
    cited: 'Zitiert',
    loadFailed: 'Die Quellenvorschau konnte nicht geladen werden. Bitte versuchen Sie es erneut.',
    bindingLabel: 'Bindungswirkung',
    openExternal: 'Im RIS öffnen',
    // Coarse source kind (ADR-0026) shown in the info popover. Preferred
    // over `origins` because the origin token is kb/ris/web only, so a
    // knowledge-base copy of a legal text reads as project material.
    kinds: {
      baurecht: 'Baurecht & Richtlinien',
      buero: 'Büroarchiv',
      projekt: 'Projektwissen',
      web: 'Webquelle',
    },
    origins: {
      kb: 'Projektwissen',
      ris: 'Recht & Richtlinien (RIS)',
      web: 'Webquelle',
    },
  },
  // Dokumentraster: echte Projekt-/Büroarchiv-Dateien, die der Assistent als
  // anklickbare Vorschaukarten anzeigt (`document_grid`-Karte / `surface_documents`).
  documentGrid: {
    countOne: '1 Dokument',
    countOther: '{count} Dokumente',
    forQuery: '„{query}“',
    source: {
      projekt: 'Projekt',
      buero: 'Büro',
    },
    // Eine referenzierte Datei, die sich nicht mehr auf eine Dokumentzeile
    // auflösen lässt — eine ehrliche, handlungsfähige Karte (im Archiv / in den
    // Projektdateien öffnen) statt einer stummen toten Kachel.
    unresolvedHint: 'Der Assistent hat diese Datei referenziert.',
    openInArchive: 'Im Archiv öffnen',
    openInFiles: 'In den Projektdateien öffnen',
    // Der Auflösungs-Abruf ist fehlgeschlagen — eine Wiederholaktion statt einer
    // dauerhaft toten Kachel.
    loadError: 'Dokumente konnten nicht geladen werden.',
    retry: 'Erneut versuchen',
    openAria: 'Dokument öffnen: {label}',
    thisFile: 'Diese Unterlage',
    choose: 'Welche Datei?',
    // Ruhige Quittung, wenn die Karte genau eine Datei neben dem Chat geöffnet hat.
    showing: '{label} wird angezeigt',
  },
  composer: {
    placeholder: 'Fragen Sie Piloti zu diesem Projekt …',
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
    // Mobile-only cue: the source/scope labels collapse to icons on phones, so a
    // tiny one-line hint under the composer keeps the active source count legible.
    sourcesActiveMobile: '{count} Quellen aktiv',
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
  // Beispielhafte österreichische Baurecht-Fragen im leeren Chat — ein Klick
  // füllt den Verfasser vor (sendet nicht automatisch), gegen die Blockade des
  // leeren Blatts.
  examples: {
    label: 'Zum Beispiel',
    questions: {
      modelElements: 'Wie viele Außenwände hat das Erdgeschoß?',
      modelRequirements: 'Welche Anforderungen kann mein Modell noch nicht beantworten?',
      fluchtweg: 'Fluchtweglänge nach OIB-2?',
      barrierefreiheit: 'Barrierefreiheit Wohnbau Wien?',
      brandabschnitte: 'Brandabschnitte Gebäudeklasse 4?',
    },
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
    // Ehrliche „Lücke“-Zeile: eine inhaltliche Antwort ohne Quellenangabe zeigt
    // dies in der neutralen --source-auto-Familie, statt die fehlende Beleglage
    // zu verbergen (Designsprache — erstklassige Wissenslücken-Behandlung).
    gapLabel: 'Ohne Quellenbeleg',
    gapAria: 'Diese Antwort nennt keine Quellen',
    // Die zusammengeführte Liste nummeriert jede Quelle so, wie die [N]-Marker
    // im Antworttext sie zitieren, und nennt die belegte Seite nach dem Chip.
    sourceNumber: 'Quelle {number}',
    page: 'S. {page}',
    pages: 'S. {pages}',
    // Zitate zum Weiterverwenden — je Quelle als Fachtext, für die ganze
    // Antwort in den Formaten, die externe Werkzeuge einlesen.
    copyCitation: 'Zitat kopieren',
    copied: 'Kopiert',
    copyCitationAria: 'Zitat kopieren: {label}',
    copyFailed: 'Das Zitat konnte nicht kopiert werden.',
    citeAll: 'Zitieren',
    citeAsLabel: 'Alle Quellen kopieren als',
    formats: {
      quotes: { label: 'Zitiertext', hint: 'Die belegten Sätze, als Liste' },
      fachtext: { label: 'Quellenangabe', hint: 'Für Befund, Gutachten, Einreichung' },
      apa: { label: 'APA', hint: 'Formatiertes Literaturverzeichnis' },
      bibtex: { label: 'BibTeX (.bib)', hint: 'LaTeX, JabRef' },
      ris: { label: 'EndNote/Zotero (.ris)', hint: 'Literaturverwaltung' },
      'csl-json': { label: 'CSL-JSON', hint: 'Zotero, Word, pandoc' },
    },
    // Hinweis unter der Quellenzeile, wenn die Zitatprüfung nicht belegbare
    // Quellenangaben entfernt hat (WP-A `citations_removed`).
    citationsRemoved: '{count} Quellenangabe(n) entfernt (nicht verifizierbar)',
    citationsRemovedReasonsLabel: 'Gründe',
  },
  // Der Zitat-Peek: was diese Fundstelle IST, bevor man sie öffnet.
  citationPeek: {
    wholeDocument: 'Gesamtes Dokument',
    openAtPage: 'An dieser Stelle öffnen',
    copyLink: 'Link kopieren',
    copyLinkAria: 'Link zu dieser Fundstelle kopieren: {label}',
    markerAria: 'Quelle {number}: {label} — Vorschau öffnen',
    lociLabel: '{count} Fundstellen',
    lociAria: 'Fundstellen in diesem Dokument',
    lociPosition: '{index}/{count}',
    previousLocus: 'Vorherige Fundstelle',
    nextLocus: 'Nächste Fundstelle',
    retrievedOnly: 'Gelesen',
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
    awaitingOther: 'Piloti wartet auf {name}',
    awaitingSomeone: 'Piloti wartet auf eine andere Person',
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
    // Live-Einzeiler, was der Assistent gerade tut — aus dem neuesten OFFENEN
    // Schritt, der sich für Lesende formulieren lässt. Bewusst ohne Eintrag
    // „zeig den Schrittnamen": ein interner Bezeichner im Status-Gewand ist
    // Rauschen. Ein nicht klassifizierbarer Schritt fällt auf die vorige
    // sinnvolle Phrase zurück, sonst auf `working` weiter oben.
    activity: {
      understanding: 'Frage wird erfasst …',
      planning: 'Vorgehen wird geplant …',
      searchingWeb: 'Web wird durchsucht …',
      searchingKnowledge: 'OIB-Wissen wird durchsucht …',
      searchingRis: 'RIS (österreichisches Recht) wird durchsucht …',
      searchingSources: 'Quellen werden durchsucht …',
      researching: 'Recherche läuft …',
      reading: 'Ergebnisse werden gelesen …',
      composing: 'Antwort wird formuliert …',
      // Skill-Aktivität — EINE Zeile für die eine berichtenswerte Tatsache:
      // welcher Skill diese Antwort prägt. `{name}` ist der Name des Skills
      // selbst (gepflegter Titel, sonst der blanke `/Bezeichner`); nie der
      // Mechanismus („Use Skill“) und nie Title-Case. Das Laden selbst ist
      // Technik und bekommt keine eigene Zeile.
      usingSkill: 'Skill „{name}“ wird angewendet …',
      // Das alte `use_skill`-Frame benennt den Mechanismus, nicht den Skill.
      // Lieber ehrlich unbenannt als falsch konkret.
      usingSkillUnnamed: 'Skill wird angewendet …',
    },
    // Kompakte Chips „was tatsächlich gelaufen ist" in der Herleitung-Basis —
    // ein Chip pro ausgeführtem Agenten/Tool, ohne Technik-Opt-in.
    executedSteps: 'Ausgeführt:',
    stepName: {
      understanding: 'Einordnung',
      routing: 'Rechercheweg',
      webSearch: 'Websuche',
      ris: 'RIS',
      corpus: 'OIB-Korpus',
      assistant: 'Assistent',
      reading: 'Lesen',
      // Ein Chip pro Skill, den dieser Turn tatsächlich angewendet hat.
      // `{name}` liefert die einzige Label-Instanz
      // (features/skills/lib/skill-activity).
      skill: 'Skill: {name}',
      // Das blanke `use_skill`-Frame ohne erkennbaren Skill dahinter.
      skillUnnamed: 'Skill',
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
    herleitungSummary: 'Herleitung · {steps} Schritte · {sources} Quellen',
    // aria-label naming the reasoning graph as one region for screen readers.
    reasoningGraphLabel: 'Herleitung',
    stepsLabel: 'Denkschritte',
    stepsHeading: 'Zwischenschritte',
    sourcesFanOut: 'Quellen',
    hitCount: '{count} Treffer',
    hitCountOne: '1 Treffer',
    gapHit: 'Nicht im Bestand',
    // Ein Dokument, das die Recherche gelesen, die Antwort aber nicht zitiert
    // hat — ein echtes Rechercheergebnis, keine Lücke.
    readNotUsed: 'gelesen, nicht verwendet',
    moreSources: '+{count} weitere',
    // Die an DIESE Nachricht angehängten Dateien. Die im Composer aktivierten
    // Datenquellen sind Verfügbarkeit, keine Aktivität, und stehen bewusst
    // nicht hier — was gelaufen ist, zeigt die `executedSteps`-Zeile darüber.
    attachedFiles: 'Angehängte Dateien:',
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
    node: {
      framingTab: 'Einordnung',
      framingTitle: 'Frage verstanden',
      framingQuestion: 'Du fragst: „{question}“',
      contextLabel: 'Kontext',
      sourcesTab: 'Quellen',
      sourcesTitle: 'Geprüfte Quellen',
      findingsTab: 'Einschätzung',
      // Reine Herleitungs-Info im Einschätzungsknoten: in welchen Quellenspuren
      // es Treffer gab. NICHT das Vertrauensurteil (Konfidenz/Belege) — das
      // steht einmal auf der Antwortkarte.
      findingsHits: 'Treffer in: {lanes}',
      // Die Beleg-Bilanz, dort genannt, wo der Fächer zusammenläuft: was
      // tatsächlich gelesen wurde, bevor die Quellenarten aufgezählt werden.
      findingsTally: '{hits} Treffer in {docs} Dokumenten',
      findingsTallyOne: '{hits} Treffer in 1 Dokument',
      // Während der Zug streamt gibt es noch keine Einschätzung, der Graph
      // braucht seinen Zusammenführungspunkt aber trotzdem — sonst hängen die
      // Quellenspalten in der Luft und die Form springt, sobald die Antwort da ist.
      findingsPendingTab: 'Einschätzung',
      findingsPending: 'Quellen werden abgewogen …',
      branchesTab: 'Folgewege',
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
    // Wiederholaktion bei einer fehlgeschlagenen Antwort (Designsprache:
    // „hilfreiche Meldung + erneut versuchen“).
    retry: 'Erneut versuchen',
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
    // Was jede Stufe BEDEUTET — im Tooltip gezeigt, damit der Leser den Chip einordnen kann.
    levelMeanings: {
      high: 'Hoch: die Antwort ist direkt durch die abgerufenen Quellen belegt, die sie klar und konsistent stützen.',
      medium:
        'Mittel: teilweise belegt — Quellen stützen Teile, aber eine Lücke, eine Schlussfolgerung oder eine kleine Mehrdeutigkeit bleibt.',
      low: 'Niedrig: Quellen fehlen, widersprechen sich oder reichen nicht aus; die Antwort extrapoliert aus Allgemeinwissen.',
    },
    // Label vor der eigenen Kurzbegründung des Modells (wortgetreu).
    reasonLabel: 'Begründung des Assistenten',
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
    commentLabel: 'Noch etwas?',
    commentPlaceholder: 'Optional — was ist schiefgelaufen?',
    commentSubmit: 'Hinweis senden',
  },
  // Schaltfläche „Nachricht kopieren" auf den Nutzernachrichtenblasen
  copyMessage: {
    copy: 'Nachricht kopieren',
    copied: 'Kopiert',
    failed: 'Nachricht konnte nicht kopiert werden',
  },
}
