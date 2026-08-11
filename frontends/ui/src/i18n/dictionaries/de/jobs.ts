import type { en } from '../en'

/**
 * Jobs — ein Prompt mit Zeitplan.
 *
 * Ein Job schickt seinen Prompt genau so ab, wie man ihn in einen neuen Chat
 * tippen würde. Ein Skill kann zusätzlich angehängt werden — genau so, wie ein
 * vorangestelltes „/name“ ihn anhängt. Der Normalfall ist: kein Skill.
 */
export const jobs: typeof en.jobs = {
  title: 'Jobs',
  subtitle:
    'Prompts, die dieses Projekt nach Zeitplan ausführt. Ein Job schickt seinen Prompt genau so ab, als hätten Sie ihn in einen neuen Chat getippt — auf Wunsch mit angehängtem Skill — und Sie legen fest, was dabei herauskommt: ein Chat oder ein Bericht.',
  backToList: 'Zurück zu den Jobs',
  loadError: 'Die Jobs konnten nicht geladen werden.',
  tryAgain: 'Erneut versuchen',

  list: {
    heading: 'Jobs',
    empty: {
      title: 'Noch keine Jobs',
      description:
        'Ein Job ist ein Prompt mit Zeitplan. Formulieren Sie ihn einmal, legen Sie fest, ob ein Chat oder ein Bericht entsteht, und lassen Sie ihn laufen — auf Zuruf oder wiederkehrend.',
      action: 'Neuer Job',
    },
    manualOnly: 'Nur manuell',
    nextRun: 'Nächste Ausführung {time}',
    lastRun: 'Letzte Ausführung {time}',
    neverRun: 'Noch nie ausgeführt',
    disabled: 'Deaktiviert',
    enableAria: 'Job „{name}“ aktivieren',
    disableAria: 'Job „{name}“ deaktivieren',
    toggleError: 'Der Job konnte nicht aktualisiert werden.',
    promptLabel: 'Prompt',
    withSkill: 'Skill: {name}',
    noSkill: 'Ohne Skill',
    output: {
      chat: 'Chat',
      'deep-research': 'Bericht',
    },
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
    submittedDetail: 'Sie läuft jetzt — verfolgen Sie sie live im Ausführungsverlauf.',
    viewProgress: 'Fortschritt ansehen',
    skipped: 'Ausführung übersprungen',
    error: 'Die Ausführung konnte nicht gestartet werden.',
    disabled: 'Aktivieren Sie den Job, bevor Sie ihn ausführen.',
  },

  deleteDialog: {
    title: 'Job löschen',
    description:
      'Dadurch werden „{name}“ und der zugehörige Ausführungsverlauf dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.',
    confirm: 'Job löschen',
    cancel: 'Abbrechen',
    error: 'Der Job konnte nicht gelöscht werden.',
  },

  builder: {
    createTitle: 'Neuer Job',
    editTitle: 'Job bearbeiten',
    createSubtitle:
      'Formulieren Sie den Prompt, den dieser Job abschickt, legen Sie fest, was dabei herauskommt, und wann er läuft. Die Vorschau zeigt genau, was der Agent erhält.',
    editSubtitle:
      'Passen Sie Prompt, Ausgabe oder Zeitplan an. Die Vorschau zeigt genau, was der Agent erhält.',

    detailsSection: 'Details',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. Wöchentlicher OIB-Brandschutz-Check',
    nameRequired: 'Ein Name ist erforderlich.',
    nameTooLong: 'Der Name ist zu lang (max. 200 Zeichen).',

    promptSection: 'Prompt',
    promptLabel: 'Was dieser Job fragt',
    promptPlaceholder:
      'Prüfe die aktuellen Projektunterlagen auf offene Brandschutzpunkte und nenne jede Abweichung mit der zugehörigen OIB-Klausel.',
    promptHint:
      'Das ist es, was ausgelöst wird. Schreiben Sie ihn genau so, wie Sie ihn in einen neuen Chat tippen würden — die Ausführung startet ohne weiteren Kontext.',
    promptRequired: 'Ein Prompt ist erforderlich.',
    promptTooLong: 'Der Prompt ist zu lang (max. 8000 Zeichen).',

    outputSection: 'Ausgabe',
    outputLabel: 'Was eine Ausführung erzeugt',
    outputHint: 'Diese Wahl entscheidet auch, welche Skills der Job anhängen kann.',
    output: {
      chatLabel: 'Chat',
      chatHint: 'ein Chat, den Sie öffnen und weiterführen können',
      deepResearchLabel: 'Deep Research',
      deepResearchHint: 'ein Bericht',
    },

    skillSection: 'Skill',
    skillLabel: 'Angehängter Skill',
    skillOptional: 'Optional',
    skillHint:
      'Ein Skill wird dem Prompt hinzugefügt — genau so, wie ein vorangestelltes „/name“ ihn anhängen würde. Die meisten Jobs brauchen keinen.',
    skillNone: 'Kein Skill',
    skillNoneHint: 'Der Prompt läuft für sich allein.',
    skillPlaceholder: 'Kein Skill',
    skillsLoading: 'Skills werden geladen…',
    skillsError:
      'Die Skills konnten nicht geladen werden — der Job lässt sich trotzdem ohne Skill speichern.',
    skillsEmpty: 'Für diese Ausgabe kann kein Skill laufen.',
    skillDetached: '„{name}“ kann nicht als {output} laufen und wurde deshalb entfernt.',

    sourcesSection: 'Datenquellen',
    knowledgeAlways: 'Projektdokumente & OIB-Wissensbasis — in jedem Lauf automatisch enthalten',
    additionalSourcesLabel: 'Weitere Quellen',
    sourcesHint:
      'Fügen Sie Quellen über die Wissensbasis hinaus hinzu. Lassen Sie alle deaktiviert, um jede verfügbare weitere Quelle zuzulassen.',
    sourcesAll: 'Alle verfügbaren Quellen',
    sourcesLoading: 'Quellen werden geladen…',
    sourcesError:
      'Die Quellen konnten nicht geladen werden — der Job verwendet alle verfügbaren Quellen.',

    scheduleSection: 'Zeitplan',
    enableScheduleLabel: 'Nach Zeitplan ausführen',
    enableScheduleHint: 'Ist dies aus, läuft der Job nur bei „Jetzt ausführen“.',
    presetLabel: 'Häufigkeit',
    cronLabel: 'Cron-Ausdruck',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Fünf Felder: Minute Stunde Tag-des-Monats Monat Wochentag.',
    cronInvalid: 'Geben Sie einen gültigen Cron-Ausdruck mit 5 Feldern ein.',
    timezoneLabel: 'Zeitzone',

    enabledLabel: 'Aktiviert',
    enabledHint:
      'Ein deaktivierter Job läuft nie nach Zeitplan und kann nicht manuell ausgeführt werden.',

    save: 'Job speichern',
    saving: 'Wird gespeichert…',
    cancel: 'Abbrechen',
    createSuccess: 'Job erstellt.',
    updateSuccess: 'Job gespeichert.',
    saveError: 'Der Job konnte nicht gespeichert werden.',

    preview: {
      title: 'Was der Agent erhält',
      subtitle:
        'Genau der Text, der bei einer Ausführung übermittelt wird. Der Server baut denselben Prompt, wenn der Job auslöst.',
      empty: 'Schreiben Sie einen Prompt, um zu sehen, was der Agent erhält.',
    },
  },

  history: {
    title: 'Ausführungsverlauf',
    loading: 'Ausführungen werden geladen…',
    loadError: 'Der Ausführungsverlauf konnte nicht geladen werden.',
    empty: 'Dieser Job wurde noch nie ausgeführt.',
    viewReport: 'Bericht ansehen',
    viewProgress: 'Fortschritt ansehen',
    viewThinking: 'Denkprozess ansehen',
    scheduler: 'Zeitplaner',
    trigger: {
      manual: 'Manuell',
      schedule: 'Nach Zeitplan',
    },
    status: {
      submitted: 'Übermittelt',
      skipped: 'Übersprungen',
      error: 'Fehler',
    },
    jobStatus: {
      submitted: 'In Warteschlange',
      pending: 'In Warteschlange',
      running: 'Läuft',
      completed: 'Abgeschlossen',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
  },
}
