import type { en } from '../en'

/** Agent Skills (Phase A): Organisations-Skill-Bibliothek plus Skill-Zeitpläne pro Projekt. */
export const skills: typeof en.skills = {
  title: 'Skills',
  subtitle:
    'Gespeicherte Skills und Zeitpläne für dieses Projekt. Ein Zeitplan pinnt einen Skill aus der Skill-Bibliothek und führt ihn bei Bedarf oder nach Zeitplan aus — über dieselbe Pipeline wie eine Chat-Anfrage.',
  backToList: 'Zurück zu den Skill-Zeitplänen',
  loadError: 'Die Skills konnten nicht geladen werden.',
  tryAgain: 'Erneut versuchen',

  toolbox: {
    heading: 'Skill-Bibliothek',
    hint: 'Skills von Piloti sowie Skills, die Ihre Organisation erstellt oder geklont hat. Zeitpläne pinnen einen dieser Skills — ein bearbeiteter Skill ändert nie einen bestehenden Zeitplan (dessen Snapshot bleibt erhalten).',
    newSkill: 'Neuer Skill',
    loadError: 'Die Skill-Bibliothek konnte nicht geladen werden.',
    empty: {
      title: 'Noch keine Skills',
      description:
        'Erstellen Sie einen Skill für Ihre Organisation oder klonen Sie einen von Piloti und passen Sie ihn an. Ein Skill ist eine wiederverwendbare Anweisung (agentskills.io-Format), die Zeitpläne und Chats aufrufen können.',
      action: 'Neuer Skill',
    },
    origin: {
      platform: 'Von Piloti',
      org: 'In dieser Organisation',
      cloned: 'Geklont',
    },
    execution: {
      chat: 'Chat-Modus',
      deepResearch: 'Deep Research',
    },
    schedulable: 'Planbar',
    notSchedulable: 'Nicht planbar',
    actions: {
      clone: 'Klonen',
      cloneAria: 'Skill „{name}“ in diese Organisation klonen',
      edit: 'Bearbeiten',
      delete: 'Löschen',
      viewBody: 'Anweisung ansehen',
    },
  },

  list: {
    heading: 'Zeitpläne',
    empty: {
      title: 'Noch keine Zeitpläne',
      description:
        'Erstellen Sie einen Zeitplan, um einen Skill aus der Bibliothek auszuführen — manuell oder nach einem wiederkehrenden Zeitplan.',
      action: 'Neuer Zeitplan',
    },
    manualOnly: 'Nur manuell',
    nextRun: 'Nächste Ausführung {time}',
    lastRun: 'Letzte Ausführung {time}',
    neverRun: 'Noch nie ausgeführt',
    disabled: 'Deaktiviert',
    enableAria: 'Zeitplan „{name}“ aktivieren',
    disableAria: 'Zeitplan „{name}“ deaktivieren',
    toggleError: 'Der Zeitplan konnte nicht aktualisiert werden.',
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
    submittedDetail: 'Sie läuft jetzt – verfolgen Sie sie live im Ausführungsverlauf.',
    viewProgress: 'Fortschritt ansehen',
    skipped: 'Ausführung übersprungen',
    error: 'Die Ausführung konnte nicht gestartet werden.',
    disabled: 'Aktivieren Sie den Zeitplan, bevor Sie ihn ausführen.',
  },

  deleteDialog: {
    title: 'Zeitplan löschen',
    description:
      'Dadurch werden „{name}“ und der zugehörige Ausführungsverlauf dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.',
    confirm: 'Zeitplan löschen',
    cancel: 'Abbrechen',
    error: 'Der Zeitplan konnte nicht gelöscht werden.',
  },

  builder: {
    createTitle: 'Neuer Zeitplan',
    editTitle: 'Zeitplan bearbeiten',
    createSubtitle:
      'Wählen Sie einen Skill aus der Bibliothek und legen Sie fest, wann er läuft. Die Vorschau zeigt genau, was der Agent erhält.',
    editSubtitle:
      'Passen Sie Skill oder Zeitplan an. Die Vorschau zeigt genau, was der Agent erhält.',

    detailsSection: 'Details',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. Wöchentlicher OIB-Brandschutz-Check',
    nameRequired: 'Ein Name ist erforderlich.',
    nameTooLong: 'Der Name ist zu lang (max. 200 Zeichen).',

    skillSection: 'Skill',
    skillLabel: 'Auszuführender Skill',
    skillPlaceholder: 'Skill auswählen…',
    skillRequired: 'Wählen Sie einen Skill.',
    skillsLoading: 'Skills werden geladen…',
    skillsError: 'Die Skills konnten nicht geladen werden — Speichern ist deaktiviert.',
    skillNotSchedulable: '„{name}“ ist als nicht planbar markiert und kann nicht nach Zeitplan laufen.',

    sourcesSection: 'Datenquellen',
    knowledgeAlways: 'Projektdokumente & OIB-Wissensbasis — in jedem Lauf automatisch enthalten',
    additionalSourcesLabel: 'Weitere Quellen',
    sourcesHint:
      'Fügen Sie Quellen über die Wissensbasis hinaus hinzu. Lassen Sie alle deaktiviert, um jede verfügbare weitere Quelle zuzulassen.',
    sourcesAll: 'Alle verfügbaren Quellen',
    sourcesLoading: 'Quellen werden geladen…',
    sourcesError:
      'Die Quellen konnten nicht geladen werden — der Zeitplan verwendet alle verfügbaren Quellen.',

    scheduleSection: 'Zeitplan',
    enableScheduleLabel: 'Nach Zeitplan ausführen',
    enableScheduleHint: 'Ist dies aus, läuft der Zeitplan nur bei „Jetzt ausführen“.',
    presetLabel: 'Häufigkeit',
    cronLabel: 'Cron-Ausdruck',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Fünf Felder: Minute Stunde Tag-des-Monats Monat Wochentag.',
    cronInvalid: 'Geben Sie einen gültigen Cron-Ausdruck mit 5 Feldern ein.',
    timezoneLabel: 'Zeitzone',

    enabledLabel: 'Aktiviert',
    enabledHint:
      'Ein deaktivierter Zeitplan läuft nie nach Zeitplan und kann nicht manuell ausgeführt werden.',

    save: 'Zeitplan speichern',
    saving: 'Wird gespeichert…',
    cancel: 'Abbrechen',
    createSuccess: 'Zeitplan erstellt.',
    updateSuccess: 'Zeitplan gespeichert.',
    saveError: 'Der Zeitplan konnte nicht gespeichert werden.',

    preview: {
      title: 'Was der Agent erhält',
      subtitle:
        'Die Skill-Anweisung, wie sie zur Laufzeit übermittelt wird. Der Server baut dieselbe Ausgabe, wenn der Zeitplan ausgelöst wird.',
      empty: 'Wählen Sie einen Skill, um den Prompt zu sehen.',
    },
  },

  editor: {
    preview: {
      heading: 'SKILL.md',
      subtitle: 'Genau das wird gespeichert – und genau das liest ein Agent.',
      level1: 'Immer geladen',
      level1Hint:
        'So viel steuert jeder Skill bei jeder Anfrage zum Kontext des Agenten bei – deshalb muss die Beschreibung sagen, wann der Skill greift.',
      level2: 'Bei Aktivierung geladen',
      level2Hint:
        'Diese Anweisungen erreichen den Agenten nur, wenn er den Skill einsetzt – ihre Länge kostet bis dahin nichts.',
      descriptionPlaceholder: 'Was dieser Skill tut und wann er einzusetzen ist.',
      emptyBody: 'Noch keine Anweisungen.',
    },
    createTitle: 'Neuer Skill',
    editTitle: 'Skill bearbeiten',
    createSubtitle:
      'Erstellen Sie einen wiederverwendbaren Skill im agentskills.io-Format: Name, Beschreibung und Anweisungstext.',
    editSubtitle: 'Passen Sie den Skill an. Bestehende Zeitpläne behalten ihren gespeicherten Snapshot.',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. oib-fire-check',
    nameRequired: 'Ein Name ist erforderlich.',
    nameTooLong: 'Skill-Namen sind höchstens 64 Zeichen lang.',
    nameInvalid:
      'Skill-Namen bestehen aus Kleinbuchstaben a–z/0–9, getrennt durch einzelne Bindestriche (keine führenden, endenden oder doppelten Bindestriche).',
    descriptionLabel: 'Beschreibung',
    descriptionPlaceholder: 'Wann soll der Agent diesen Skill verwenden?',
    descriptionRequired: 'Eine Beschreibung ist erforderlich.',
    descriptionTooLong: 'Beschreibungen sind höchstens 1024 Zeichen lang.',
    bodyLabel: 'Anweisung',
    bodyPlaceholder: 'Die vollständige Anweisung, die der Agent bei diesem Skill befolgt.',
    bodyRequired: 'Der Anweisungstext ist erforderlich.',
    bodyTooLong: 'Anweisungstexte sind höchstens 32000 Zeichen lang.',
    executionLabel: 'Ausführungsmodus',
    executionHint:
      'So führt ein Zeitplan diesen Skill aus: Chat-Modus läuft als Chat-Anfrage, Deep Research über die asynchrone Recherche-Pipeline mit Bericht.',
    schedulableLabel: 'Planbar',
    schedulableHint:
      'Aus bedeutet: Zeitpläne können diesen Skill nicht per Cron ausführen (manuelle Ausführung bleibt möglich).',
    cloneFrom: 'Geklont von „{name}“',
    enabledLabel: 'Aktiviert',
    enabledHint: 'Ein deaktivierter Skill kann nicht zu neuen Zeitplänen hinzugefügt werden.',
    save: 'Skill speichern',
    saving: 'Wird gespeichert…',
    cancel: 'Abbrechen',
    createSuccess: 'Skill erstellt.',
    updateSuccess: 'Skill gespeichert.',
    saveError: 'Der Skill konnte nicht gespeichert werden.',
    deleteTitle: 'Skill löschen',
    deleteDescription:
      'Dadurch wird „{name}“ aus der Bibliothek entfernt. Bestehende Zeitpläne behalten ihren gespeicherten Snapshot und laufen unverändert weiter.',
    deleteConfirm: 'Skill löschen',
  },

  history: {
    title: 'Ausführungsverlauf',
    loading: 'Ausführungen werden geladen…',
    loadError: 'Der Ausführungsverlauf konnte nicht geladen werden.',
    empty: 'Dieser Zeitplan wurde noch nicht ausgeführt.',
    viewReport: 'Bericht ansehen',
    viewProgress: 'Fortschritt ansehen',
    viewThinking: 'Denkprozess ansehen',
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
      submitted: 'In Warteschlange',
      pending: 'In Warteschlange',
      running: 'Läuft',
      completed: 'Abgeschlossen',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
  },

  // Die `/`-Aufrufoberfläche im Chat-Eingabefeld.
  composer: {
    picker: {
      resultsAria: 'Verfügbare Skills',
      empty: 'Noch keine Skills verfügbar',
      emptyHint: 'Skills, die Ihre Organisation anlegt, erscheinen hier. Verwaltung unter Skills.',
      noResults: 'Kein Skill passt zu „{query}“',
      noResultsHint: 'Skills werden über ihren Namen und ihren Einsatzzweck gefunden.',
      loading: 'Skills werden geladen',
      builtin: 'Integriert',
      keyboardHint: '↑↓ auswählen · ↵ einfügen · esc schließen',
    },
    invoked: {
      label: 'Skill: {name}',
      hint: 'Seine Anweisungen werden zu Beginn dieser Antwort geladen.',
      remove: 'Skill {name} aus dieser Nachricht entfernen',
    },
    activated: {
      one: '1 Skill verwendet',
      other: '{count} Skills verwendet',
      title: 'Für diese Antwort verwendete Skills',
      explainer:
        'Der Assistent sieht zu Beginn einer Antwort Name und Beschreibung jedes Skills und lädt die vollständigen Anweisungen nur für die Skills, die er aktiviert. Diese wurden aktiviert.',
    },
  },
}
