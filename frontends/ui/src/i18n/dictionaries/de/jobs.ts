import type { en } from '../en'

/**
 * Aufgaben mit Rhythmus — ein Auftrag auf Wunsch mit Timer, und die Woche, die
 * daraus wird.
 *
 * Eine Aufgabe feuert ihren Prompt in einen frischen Lauf, so wie jemand einen
 * neuen Chat öffnet und tippt — einmalig, oder nach dem Rhythmus aus Schritt 3.
 * Ein Skill KANN obendrauf hängen, genau wie ein vorangestelltes „/name“ — der
 * Normalfall ist kein Skill, und die Texte unten sagen das. Die
 * Skill-Werkstatt selbst liegt im Namensraum `skills`.
 *
 * Zwei Dinge gehören diesem Namensraum neu: die Texte des STUNDENPLANS und die
 * des vierteiligen ASSISTENTEN. Beide gibt es, weil ein Rhythmus das Einzige im
 * Produkt ist, das man nicht durch Hinsehen prüfen kann — also gehen die Wörter
 * dorthin, wo die Festlegung lesbar wird („Jeden Montag um 06:00“, die nächsten
 * drei echten Termine), statt in die Namen von Cron-Feldern.
 */
export const jobs: typeof en.jobs = {
  title: 'Aufgaben',
  backToList: 'Zurück zur Liste',
  loadError: 'Die Aufgaben konnten nicht geladen werden.',
  tryAgain: 'Erneut versuchen',

  list: {
    heading: 'Aufgaben',
    empty: {
      title: 'Noch keine Aufgaben',
      description:
        'Eine Aufgabe ist ein Auftrag mit oder ohne Rhythmus. Einmal schreiben, festlegen, ob ein Chat oder ein Bericht herauskommt — und Piloti arbeitet, während Sie woanders sind.',
      action: 'Neue Aufgabe',
    },
    manualOnly: 'Nur manuell',
    // Bewusst knapp: beide stehen auf EINER Fußzeile einer Karte.
    nextRun: 'Nächster {time}',
    lastRun: 'Letzter {time}',
    neverRun: 'Noch nie gelaufen',
    disabled: 'Pausiert',
    enableAria: 'Aufgabe „{name}“ fortsetzen',
    disableAria: 'Aufgabe „{name}“ pausieren',
    toggleError: 'Die Aufgabe konnte nicht geändert werden.',
    withSkill: 'Skill: {name}',
    noSkill: 'Kein Skill',
    output: {
      chat: 'Chat',
      'deep-research': 'Bericht',
    },
  },

  card: {
    openAria: 'Aufgabe „{name}“ öffnen',
  },

  actions: {
    edit: 'Bearbeiten',
    runNow: 'Jetzt ausführen',
    delete: 'Löschen',
  },

  timetable: {
    title: 'Die Woche',
    legend: 'Aufgaben in diesem Raster',
    thisWeek: 'Diese Woche',
    today: 'Heute',
    previousWeek: 'Vorige Woche',
    nextWeek: 'Nächste Woche',
    showFullDay: 'Alle 24 Stunden zeigen',
    showActiveHours: 'Nur aktive Stunden zeigen',
    nothing: 'Nichts',
    gap: '{hours} Std.',
    /** Ein Cron, den der Parser nicht lesen konnte — benannt, nie verschwiegen. */
    unplaceable: 'Nicht im Raster: {names}',
    emptyNoSchedules: 'Noch nichts geplant',
    emptyNoSchedulesHint: 'Legen Sie eine Aufgabe mit Rhythmus an — dann füllt sich diese Woche.',
    emptyThisWeek: 'Diese Woche läuft nichts',
  },

  schedule: {
    frequency: {
      hourly: 'Stündlich',
      daily: 'Täglich',
      weekly: 'Wöchentlich',
      monthly: 'Monatlich',
    },
    summaryHourly: 'Stündlich um :{minute}',
    summaryDaily: 'Täglich um {time}',
    summaryWeekly: 'Jeden {weekday} um {time}',
    summaryWeekdays: 'Werktags um {time}',
    summaryMonthly: 'Monatlich am {day}. um {time}',
    summaryCustom: 'Eigener Rhythmus ({cron})',
    inTimezone: '{summary} · {timezone}',
  },

  run: {
    submitted: 'Gestartet.',
    submittedDetail: 'Er läuft jetzt — verfolgen Sie ihn unter Tasks.',
    skipped: 'Übersprungen',
    error: 'Das konnte nicht gestartet werden.',
    disabled: 'Setzen Sie die Aufgabe fort, bevor Sie sie ausführen.',
  },

  deleteDialog: {
    title: 'Aufgabe löschen',
    description: 'Löscht „{name}“ und ihren Verlauf dauerhaft. Das lässt sich nicht rückgängig machen.',
    confirm: 'Aufgabe löschen',
    cancel: 'Abbrechen',
    error: 'Die Aufgabe konnte nicht gelöscht werden.',
  },

  builder: {
    stepsLabel: 'Schritte',
    stepProgress: 'Schritt {current} von {total}',
    steps: {
      task: 'Auftrag',
      output: 'Ergebnis',
      schedule: 'Rhythmus',
      review: 'Prüfen',
      taskTitle: 'Was soll Piloti tun?',
      taskHint:
        'Schreiben Sie es genau so, wie Sie es in einen neuen Chat tippen würden. Piloti startet ohne weiteren Kontext.',
      outputTitle: 'Was soll dabei herauskommen?',
      outputHint: 'Das entscheidet auch, welche Skills die Aufgabe nutzen kann.',
      scheduleTitle: 'Wann soll es laufen?',
      scheduleHint:
        'Wählen Sie einen Rhythmus — die nächsten Termine stehen darunter, zum Prüfen vor der Festlegung.',
      reviewTitle: 'Fertig',
      reviewHint: 'Das wird passieren. Gespeichert ist noch nichts.',
    },
    next: 'Weiter',
    back: 'Zurück',
    cancel: 'Abbrechen',
    create: 'Aufgabe anlegen',
    save: 'Aufgabe speichern',
    saving: 'Wird gespeichert…',

    nameLabel: 'Name',
    namePlaceholder: 'z. B. Wöchentlicher OIB-Brandschutz-Scan',
    nameHint: 'So heißt er in der Liste. Leer gelassen, wird die erste Zeile oben genommen.',
    nameRequired: 'Ein Name ist erforderlich.',
    nameTooLong: 'Der Name ist zu lang (max. 200 Zeichen).',

    promptLabel: 'Der Auftrag',
    promptPlaceholder:
      'Prüfe die aktuellen Projektunterlagen auf offene Brandschutzpunkte und nenne jede Abweichung mit der OIB-Fundstelle.',
    promptHint: 'Das ist es, was jedes Mal wortwörtlich abgefeuert wird.',
    promptRequired: 'Ein Auftrag ist erforderlich.',
    promptTooLong: 'Der Auftrag ist zu lang (max. 8000 Zeichen).',

    outputSection: 'Ergebnis',
    outputLabel: 'Was dabei herauskommt',
    output: {
      chatLabel: 'Chat',
      chatHint: 'Ein Gespräch, das Sie öffnen und weiterführen können.',
      chatNoun: 'einen Chat',
      deepResearchLabel: 'Bericht',
      deepResearchHint: 'Ein recherchiertes Dokument, im Projekt abgelegt.',
      deepResearchNoun: 'einen Bericht',
    },

    advancedOutput: 'Skill und Datenquellen',
    advancedSchedule: 'Zeitzone und Cron',

    skillSection: 'Skill',
    skillLabel: 'Angehängter Skill',
    skillSummary: 'Skill: {name}',
    skillNone: 'Kein Skill',
    skillNoneHint: 'Der Auftrag läuft für sich. Die meisten Aufgaben brauchen keinen Skill.',
    skillPlaceholder: 'Kein Skill',
    skillsLoading: 'Skills werden geladen…',
    skillsError: 'Die Skills konnten nicht geladen werden — die Aufgabe lässt sich trotzdem speichern.',
    skillsEmpty: 'Zu dieser Ergebnisart passt kein Skill.',
    skillDetached: '„{name}“ kann nicht als {output} laufen und wurde abgehängt.',

    sourcesSection: 'Datenquellen',
    sourcesSummary: '{count} zusätzliche Quellen',
    knowledgeAlways: 'Projektdokumente & OIB-Wissensbasis — jedes Mal dabei',
    additionalSourcesLabel: 'Zusätzliche Quellen',
    sourcesHint:
      'Quellen über die Wissensbasis hinaus. Nichts angehakt heißt: alle verfügbaren Quellen sind erlaubt.',
    sourcesAll: 'Alle verfügbaren Quellen',
    sourcesLoading: 'Quellen werden geladen…',
    sourcesError: 'Quellen konnten nicht geladen werden — die Aufgabe nutzt alle verfügbaren.',

    scheduleSection: 'Rhythmus',
    enableScheduleLabel: 'Nach Zeitplan ausführen',
    enableScheduleHint: 'Ist das aus, läuft er nur auf „Jetzt ausführen“.',
    presetLabel: 'Wie oft',
    timeLabel: 'Um',
    minuteLabel: 'Zur Minute',
    minutePast: '{minute} nach der vollen Stunde',
    weekdayLabel: 'Am',
    weekdayHint: 'So viele Tage wie nötig — Mo bis Fr liest sich als „werktags“.',
    monthDayLabel: 'Am',
    monthDayValue: '{day}.',
    upcomingLabel: 'Nächste Termine',
    upcomingNone: 'Das feuert nie von selbst — es läuft nur, wenn Sie es starten.',

    customCronLabel: 'Cron-Ausdruck schreiben',
    customCronHint: 'Für Rhythmen, die die vier Optionen oben nicht abbilden.',
    cronLabel: 'Cron-Ausdruck',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Fünf Felder: Minute Stunde Tag-des-Monats Monat Wochentag.',
    cronInvalid: 'Bitte einen gültigen 5-Feld-Cron-Ausdruck eingeben.',
    timezoneLabel: 'Zeitzone',
    timezoneHint: 'Der Zeitplan feuert nach der Uhr dieser Zone, Sommerzeit inklusive.',

    enabledLabel: 'Aktiv',
    enabledHint: 'Eine pausierte Aufgabe feuert nie und lässt sich nicht von Hand starten.',

    reviewSentence: 'Piloti erstellt {cadence} {output}.',
    reviewSentenceManual: 'Piloti erstellt {output}, jedes Mal wenn Sie es von Hand starten.',

    createSuccess: 'Aufgabe angelegt.',
    updateSuccess: 'Aufgabe gespeichert.',
    saveError: 'Die Aufgabe konnte nicht gespeichert werden.',

    preview: {
      title: 'Was der Agent erhält',
      subtitle:
        'Genau dieser Text wird übermittelt. Der Server baut beim Feuern denselben Prompt.',
    },
  },

  history: {
    title: 'Verlauf',
    loading: 'Tasks werden geladen…',
    loadError: 'Der Verlauf konnte nicht geladen werden.',
    empty: 'Diese Aufgabe ist noch nie gelaufen.',
    viewReport: 'Bericht ansehen',
    openChat: 'Chat öffnen',
    viewProgress: 'Fortschritt ansehen',
    viewThinking: 'Gedankengang ansehen',
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
    jobStatus: {
      submitted: 'Eingereiht',
      pending: 'Eingereiht',
      running: 'Läuft',
      completed: 'Abgeschlossen',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
  },
}
