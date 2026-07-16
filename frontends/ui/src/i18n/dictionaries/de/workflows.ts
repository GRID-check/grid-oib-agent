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
    empty: {
      title: 'Noch keine Workflows',
      description:
        'Erstellen Sie einen Workflow, um ein Recherche-Briefing zu speichern, das Sie wiederholen möchten — manuell oder nach einem wiederkehrenden Zeitplan.',
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
    sourcesHint:
      'Schränken Sie ein, welche Quellen der Agent verwenden darf. Lassen Sie alle deaktiviert, um jede verfügbare Quelle zuzulassen.',
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
}
