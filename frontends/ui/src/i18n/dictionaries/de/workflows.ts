import type { en } from '../en'

/** Workflows: gespeicherte Recherche-Briefings, manuell oder per Zeitplan. */
export const workflows: typeof en.workflows = {
  title: 'Workflows',
  subtitle:
    'Gespeicherte Recherche-Briefings für dieses Projekt. Führen Sie sie bei Bedarf oder nach Zeitplan aus — jede Ausführung läuft über dieselbe Deep-Research-Pipeline wie eine Chat-Anfrage.',
  newWorkflow: 'Neuer Workflow',
  backToList: 'Zurück zu den Workflows',
  loadError: 'Die Workflows konnten nicht geladen werden.',
  tryAgain: 'Erneut versuchen',

  list: {
    heading: 'Ihre Workflows',
    empty: {
      title: 'Noch keine Workflows',
      description:
        'Richten Sie oben eine Vorlage ein oder erstellen Sie einen Workflow von Grund auf, um ein Recherche-Briefing zu speichern, das Sie wiederholen möchten — manuell oder nach einem wiederkehrenden Zeitplan.',
      action: 'Neuer Workflow',
    },
    manualOnly: 'Nur manuell',
    nextRun: 'Nächste Ausführung {time}',
    lastRun: 'Letzte Ausführung {time}',
    neverRun: 'Noch nie ausgeführt',
    disabled: 'Deaktiviert',
    enableAria: 'Workflow „{name}“ aktivieren',
    disableAria: 'Workflow „{name}“ deaktivieren',
    toggleError: 'Der Workflow konnte nicht aktualisiert werden.',
  },

  actions: {
    edit: 'Bearbeiten',
    runNow: 'Jetzt ausführen',
    running: 'Wird ausgeführt…',
    delete: 'Löschen',
    history: 'Ausführungsverlauf',
  },

  schedule: {
    presets: {
      hourly: 'Stündlich',
      daily: 'Täglich um 06:00',
      weekly: 'Wöchentlich, Montag 06:00',
      monthly: 'Monatlich, am 1. um 06:00',
      custom: 'Benutzerdefinierter Zeitplan',
    },
    summaryHourly: 'Stündlich',
    summaryDaily: 'Täglich um 06:00',
    summaryWeekly: 'Wöchentlich montags um 06:00',
    summaryMonthly: 'Monatlich am 1. um 06:00',
    summaryCustom: 'Benutzerdefiniert ({cron})',
    inTimezone: '{summary} · {timezone}',
  },

  run: {
    submitted: 'Ausführung gestartet.',
    submittedDetail: 'Verfolgen Sie sie im Reiter „Recherche“.',
    skipped: 'Ausführung übersprungen',
    error: 'Die Ausführung konnte nicht gestartet werden.',
    disabled: 'Aktivieren Sie den Workflow, bevor Sie ihn ausführen.',
  },

  deleteDialog: {
    title: 'Workflow löschen',
    description:
      'Dadurch werden „{name}“ und der zugehörige Ausführungsverlauf dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.',
    confirm: 'Workflow löschen',
    cancel: 'Abbrechen',
    error: 'Der Workflow konnte nicht gelöscht werden.',
  },

  builder: {
    createTitle: 'Neuer Workflow',
    editTitle: 'Workflow bearbeiten',
    createSubtitle:
      'Beschreiben Sie das Recherche-Briefing. Die Vorschau zeigt genau, was der Agent erhält.',
    editSubtitle:
      'Passen Sie das Briefing oder den Zeitplan an. Die Vorschau zeigt genau, was der Agent erhält.',

    detailsSection: 'Details',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. Wöchentlicher OIB-Brandschutz-Check',
    nameRequired: 'Ein Name ist erforderlich.',
    nameTooLong: 'Der Name ist zu lang (max. 200 Zeichen).',
    descriptionLabel: 'Beschreibung',
    descriptionPlaceholder: 'Optional — eine kurze Notiz, wofür dieser Workflow gedacht ist.',

    briefSection: 'Recherche-Briefing',
    objectiveLabel: 'Ziel',
    objectivePlaceholder:
      'Was soll der Agent recherchieren? z. B. „Aktuelle Änderungen der OIB-Richtlinie 2 zusammenfassen.“',
    objectiveRequired: 'Ein Ziel ist erforderlich.',
    contextLabel: 'Kontext',
    contextPlaceholder:
      'Optionaler Hintergrund, den der Agent annehmen soll — Projekt, bisherige Erkenntnisse, Rahmenbedingungen.',
    questionsLabel: 'Recherchefragen',
    questionsHint: 'Optionale konkrete Fragen, die der Bericht beantworten soll.',
    questionPlaceholder: 'Recherchefrage',
    addQuestion: 'Frage hinzufügen',
    removeQuestion: 'Frage entfernen',
    outputFormatLabel: 'Ausgabeformat',
    outputFormatPlaceholder: 'Optional — z. B. „Zusammenfassung plus Quellentabelle.“',
    compiledTooLong:
      'Das kompilierte Briefing ist zu lang (max. 32.000 Zeichen). Kürzen Sie die Abschnitte.',

    sourcesSection: 'Datenquellen',
    knowledgeAlways: 'Projektdokumente & OIB-Wissensbasis — in jedem Lauf automatisch enthalten',
    additionalSourcesLabel: 'Weitere Quellen',
    sourcesHint:
      'Fügen Sie Quellen über die Wissensbasis hinaus hinzu. Lassen Sie alle deaktiviert, um jede verfügbare weitere Quelle zuzulassen.',
    sourcesAll: 'Alle verfügbaren Quellen',
    sourcesLoading: 'Quellen werden geladen…',
    sourcesError:
      'Die Quellen konnten nicht geladen werden — der Workflow verwendet alle verfügbaren Quellen.',

    scheduleSection: 'Zeitplan',
    enableScheduleLabel: 'Nach Zeitplan ausführen',
    enableScheduleHint: 'Ist dies aus, läuft der Workflow nur bei „Jetzt ausführen“.',
    presetLabel: 'Häufigkeit',
    cronLabel: 'Cron-Ausdruck',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Fünf Felder: Minute Stunde Tag-des-Monats Monat Wochentag.',
    cronInvalid: 'Geben Sie einen gültigen Cron-Ausdruck mit 5 Feldern ein.',
    timezoneLabel: 'Zeitzone',

    enabledLabel: 'Aktiviert',
    enabledHint:
      'Ein deaktivierter Workflow läuft nie nach Zeitplan und kann nicht manuell ausgeführt werden.',

    save: 'Workflow speichern',
    saving: 'Wird gespeichert…',
    cancel: 'Abbrechen',
    createSuccess: 'Workflow erstellt.',
    updateSuccess: 'Workflow gespeichert.',
    saveError: 'Der Workflow konnte nicht gespeichert werden.',

    preview: {
      title: 'Was der Agent erhält',
      subtitle:
        'Kompiliert aus dem obigen Briefing. Der Server kompiliert beim Speichern dieselbe Ausgabe.',
      empty: 'Füllen Sie das Ziel aus, um das kompilierte Briefing zu sehen.',
    },
  },

  history: {
    title: 'Ausführungsverlauf',
    loading: 'Ausführungen werden geladen…',
    loadError: 'Der Ausführungsverlauf konnte nicht geladen werden.',
    empty: 'Dieser Workflow wurde noch nicht ausgeführt.',
    viewReport: 'Bericht ansehen',
    scheduler: 'Zeitplaner',
    trigger: {
      manual: 'Manuell',
      schedule: 'Geplant',
    },
    status: {
      submitted: 'Übermittelt',
      skipped: 'Übersprungen',
      error: 'Fehler',
    },
  },

  // Von Piloti erstellte Standardvorlagen — die stets sichtbare Galerie oben auf
  // der Workflows-Seite. Eine Karte füllt den Builder vor; Vorlagen erstellen
  // oder starten nie automatisch einen Workflow (die Nutzerin prüft und
  // speichert).
  templates: {
    badge: 'Von Piloti',
    heading: 'Vorlagen von Piloti',
    hint: 'Vorausgefüllte Recherche-Briefings — prüfen, anpassen und speichern. Es läuft nichts, bevor Sie den Workflow speichern.',
    setUp: 'Einrichten',
    setUpAria: 'Vorlage „{name}“ einrichten',
    // Ehrliche Kadenz-Hinweise, abgeleitet aus dem echten Cron der Vorlage.
    cadence: {
      manual: 'Auf Abruf',
      hourly: 'Läuft stündlich',
      daily: 'Läuft täglich',
      weekly: 'Läuft wöchentlich',
      monthly: 'Läuft monatlich',
      custom: 'Eigener Zeitplan ({cron})',
    },
    moreComing: {
      title: 'Weitere Workflows folgen',
      hint: 'Hier erscheinen künftig weitere Piloti-Vorlagen.',
    },

    submissionPrecheck: {
      name: 'Vorprüfung Einreichung',
      category: 'Baurecht',
      description:
        'Recherchiert, welche Anforderungen für die Einreichung dieses Projekts gelten (Landes-Bauordnung, OIB-Richtlinien), und berichtet offene Punkte und fehlende Nachweise als Deep-Research-Bericht.',
      objective:
        'Ermitteln, welche Anforderungen die Einreichung dieses Projekts erfüllen muss — nach der anwendbaren Landes-Bauordnung und den OIB-Richtlinien — und berichten, welche Punkte die Projektdokumentation bereits abdeckt und welche offen bleiben.',
      context:
        'Nutzen Sie die Projektdokumente, um festzustellen, was geplant und bereits vorbereitet ist (Pläne, Berichte, Nachweise). Verwenden Sie die OIB-Wissensbasis und RIS (Bauordnung und einschlägige Verordnungen des Projekt-Bundeslands) als normative Grundlage. Dies ist ein vorbereitender Recherchebericht für das Planungsteam — er ersetzt nicht die formelle Prüfung der Einreichung durch die Behörde.',
      outputFormat:
        'Eine nach Themen gruppierte Checkliste: Anforderung, Rechtsgrundlage (exakte Fundstelle), Status (abgedeckt / offen / unklar), Verweis auf das Projektdokument, empfohlene Maßnahme. Schließen Sie mit einer kurzen Zusammenfassung der größten offenen Punkte. Belegen Sie jede Anforderung mit ihrer Quelle.',
      questions: {
        q1: 'Welche behördlichen Anforderungen und welche Einreichunterlagen verlangt die anwendbare Landes-Bauordnung für diesen Projekttyp und Standort?',
        q2: 'Welche OIB-Anforderungen muss die Einreichung für diese Gebäudeklasse und Nutzung nachweislich behandeln?',
        q3: 'Welche dieser Punkte deckt die aktuelle Projektdokumentation bereits ab? Nennen Sie das Dokument.',
        q4: 'Welche Punkte sind offen — fehlende Unterlagen, fehlende Nachweise oder ungeklärte Widersprüche?',
        q5: 'Was sollte das Planungsteam vor der Einreichung priorisieren, und zeichnen sich formelle Abweichungen ab?',
      },
    },

    regulatoryWatch: {
      name: 'Richtlinien-Monitoring: OIB & österreichisches Baurecht',
      category: 'Richtlinien',
      description:
        'Wöchentlicher Scan von RIS und Web nach geänderten Gesetzen, Verordnungen, Judikatur und OIB-Richtlinien-Veröffentlichungen, die dieses Projekt betreffen — mit konkreter Auswirkungsbewertung.',
      objective:
        'Änderungen des österreichischen Baurechts und der OIB-Richtlinien identifizieren, die für dieses Projekt relevant sind — neue oder novellierte Bundes- und Landesgesetze sowie Verordnungen (RIS), neue OIB-Richtlinien-Veröffentlichungen oder -Entwürfe sowie einschlägige Judikatur — und deren konkrete Auswirkungen auf dieses Projekt bewerten.',
      context:
        'Nutzen Sie die Dokumente dieses Projekts, um dessen Rahmen zu verstehen (Gebäudetyp, Standort/Bundesland, Genehmigungsstatus, aktuelle Planungsphase). Priorisieren Sie Primärquellen: RIS für Bundes- und Landesrecht (einschließlich Bauordnungen und Bautechnikgesetze/-verordnungen) sowie Judikatur; offizielle OIB-Publikationen für Richtlinien-Veröffentlichungen; nutzen Sie die Websuche nur für Ankündigungen, Entwürfe und Fachkommentare. Konzentrieren Sie sich auf Entwicklungen der letzten 30 Tage sowie auf ältere Punkte mit einer bevorstehenden Übergangsfrist.',
      outputFormat:
        'Beginnen Sie mit einer Management-Zusammenfassung von höchstens einer halben Seite. Danach eine Änderungstabelle: Quelle (mit exakter RIS-/OIB-Fundstelle), Datum, was sich geändert hat, Auswirkung auf dieses Projekt (hoch/mittel/gering), empfohlene Maßnahme, Frist. Schließen Sie mit offenen Fragen für das Planungsteam. Belegen Sie jede Aussage mit ihrer Quelle.',
      questions: {
        q1: 'Welche für dieses Projekt relevanten Gesetze, Verordnungen oder OIB-Richtlinien haben sich kürzlich geändert oder haben angekündigte Änderungen?',
        q2: 'Was genau hat sich gegenüber der bisherigen Rechtslage geändert?',
        q3: 'Welche Teile dieses Projekts (Planung, Genehmigungen, Dokumentation) sind betroffen, und wie stark?',
        q4: 'Welche Fristen oder Übergangsfristen gelten?',
        q5: 'Welche konkreten Maßnahmen sollte das Planungsteam ergreifen, und wie dringend ist jede davon?',
      },
    },

    complianceGapCheck: {
      name: 'OIB-Konformitätscheck',
      category: 'Konformität',
      description:
        'Gleicht die Projektdokumentation mit den anwendbaren OIB-Richtlinien ab und liefert eine priorisierte Liste von Lücken, Widersprüchen und fehlenden Nachweisen.',
      objective:
        'Die aktuelle Dokumentation dieses Projekts systematisch mit den anwendbaren Anforderungen der OIB-Richtlinien (1–6) abgleichen und Konformitätslücken, Widersprüche und fehlende Nachweise identifizieren.',
      context:
        'Verwenden Sie die hochgeladenen Projektdokumente als Tatsachengrundlage für das Geplante und die OIB-Wissensbasis als normative Grundlage. Bestimmen Sie zunächst, welche OIB-Richtlinien und welche Anforderungsklassen für diesen Gebäudetyp, diese Nutzung und diesen Standort gelten. Wo die Projektdokumentation zu einer anwendbaren Anforderung keine Aussage trifft, werten Sie dies als fehlenden Nachweis — nicht als konform. Vermerken Sie, wo eine geplante Lösung von einer OIB-Anforderung abweicht und eine formelle Abweichung nach der anwendbaren Landes-Bauordnung erfordern würde, einschließlich möglicher Ausgleichsmaßnahmen.',
      outputFormat:
        'Eine nach OIB-Richtlinie gruppierte Konformitätsmatrix: Anforderung, Status (konform / Lücke / fehlender Nachweis / Abweichung), Nachweis-Fundstelle, Kommentar. Danach eine nach Risiko gereihte Lückenliste mit empfohlenen nächsten Schritten sowie offene Fragen für das Planungsteam. Zitieren Sie OIB-Punkte und Projektdokumente präzise.',
      questions: {
        q1: 'Welche OIB-Richtlinien und welche konkreten Anforderungen gelten für dieses Projekt (Gebäudeklasse, Nutzung, Standort)?',
        q2: 'Für jede anwendbare Anforderung: Wo weist die Projektdokumentation die Konformität nach? Nennen Sie Dokument und Fundstelle.',
        q3: 'Welche anwendbaren Anforderungen haben in der Dokumentation keinen Nachweis oder widersprüchliche Angaben über mehrere Dokumente hinweg?',
        q4: 'Welche geplanten Lösungen weichen von OIB-Anforderungen ab und würden einen formellen Abweichungsantrag oder Ausgleichsmaßnahmen erfordern?',
        q5: 'Welche Lücken bergen das höchste Risiko und sollten vor dem nächsten Genehmigungsmeilenstein geschlossen werden?',
      },
    },
  },
}
