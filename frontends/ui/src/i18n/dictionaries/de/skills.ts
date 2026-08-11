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
    review: {
      heading: 'Skill-Prüfung',
      subtitle:
        'Eine Prüfinstanz liest den Skill so, wie ein Agent ihn liest, und nennt, was seiner Auswahl im Weg steht. Beratend – sie blockiert das Speichern nie.',
      action: 'Skill prüfen',
      running: 'Wird geprüft…',
      clean: 'Nichts zu beanstanden. Die Beschreibung sagt, was der Skill tut und wann er einzusetzen ist.',
      unavailable: 'Die Prüfung konnte gerade nicht ausgeführt werden. Es wurde nichts bewertet – bitte gleich erneut versuchen.',
      fields: {
        name: 'Name',
        description: 'Beschreibung',
        body: 'Anweisungen',
      },
    },
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
    nameHint: 'Kleinbuchstaben und Bindestriche. Genau so rufen Sie den Skill im Chat mit „/“ auf.',
    nameRequired: 'Ein Name ist erforderlich.',
    nameTooLong: 'Skill-Namen sind höchstens 64 Zeichen lang.',
    nameInvalid:
      'Skill-Namen bestehen aus Kleinbuchstaben a–z/0–9, getrennt durch einzelne Bindestriche (keine führenden, endenden oder doppelten Bindestriche).',
    descriptionLabel: 'Beschreibung',
    descriptionPlaceholder: 'Wann soll der Agent diesen Skill verwenden?',
    descriptionHint:
      'Daran erkennt der Agent den Skill: Er liest nur diesen Satz – nie die Anweisung – und entscheidet daraufhin, ob er den Skill lädt. Sagen Sie also, WAS der Skill tut und WANN er greifen soll, in den Worten, die Ihre Kolleginnen und Kollegen tatsächlich verwenden.',
    descriptionRequired: 'Eine Beschreibung ist erforderlich.',
    descriptionTooLong: 'Beschreibungen sind höchstens 1024 Zeichen lang.',
    bodyLabel: 'Anweisung',
    bodyPlaceholder: 'Die vollständige Anweisung, die der Agent bei diesem Skill befolgt.',
    bodyHint:
      'Markdown. Diese Anweisung erreicht den Agenten erst, wenn er den Skill lädt – bis dahin kostet ihre Länge nichts.',
    bodyRequired: 'Der Anweisungstext ist erforderlich.',
    bodyTooLong: 'Anweisungstexte sind höchstens 32000 Zeichen lang.',
    markdown: {
      h1: 'Überschrift 1',
      h2: 'Überschrift 2',
      h3: 'Überschrift 3',
      bold: 'Fett (Strg + B)',
      italic: 'Kursiv (Strg + I)',
      code: 'Code im Text',
      codeBlock: 'Codeblock',
      bulletList: 'Aufzählung',
      numberedList: 'Nummerierte Liste',
      taskList: 'Aufgabenliste',
      link: 'Link einfügen',
      quote: 'Zitat',
      table: 'Tabelle einfügen',
      edit: 'Nur Text',
      split: 'Text und Vorschau',
      preview: 'Nur Vorschau',
      fullscreen: 'Vollbild',
    },
    behaviourHeading: 'Verfügbarkeit',
    executionLabel: 'Einsatzbereich',
    executionHint:
      'Wo dieser Skill überhaupt existiert. Er gehört zu genau einem der beiden – die Anweisungen der beiden Laufzeiten unterscheiden sich zu stark.',
    execution: {
      chat: {
        label: 'Chat',
        hint: 'Steht im Chat zur Verfügung: Der Agent zieht den Skill selbst heran, wenn die Beschreibung zur Frage passt – und Sie rufen ihn mit „/“ direkt auf.',
      },
      deepResearch: {
        label: 'Deep Research',
        hint: 'Gilt nur in der Recherche-Pipeline, die im Hintergrund läuft und einen Bericht schreibt. Im Chat wird der Skill nicht angeboten.',
      },
    },
    raw: {
      heading: 'Erweitert: SKILL.md direkt bearbeiten',
      subtitle:
        'Das ganze Dokument einfügen oder ändern – die Felder oben werden daraus neu gesetzt.',
      documentLabel: 'SKILL.md-Dokument',
      apply: 'Übernehmen',
      reset: 'Zurücksetzen',
      applied: 'Dokument übernommen.',
      ready: 'Das Dokument ist gültig. „Übernehmen“ schreibt es in die Felder oben.',
      unchanged: 'Unverändert – identisch mit den Feldern oben.',
      ignored:
        'Diese Felder kann GRID nicht speichern und lässt sie beim Übernehmen weg: {keys}.',
      errors: {
        'missing-frontmatter':
          'Das Dokument beginnt nicht mit einem „---“-Block. Ein SKILL.md startet immer mit YAML-Frontmatter.',
        'unterminated-frontmatter': 'Der Frontmatter-Block wird nicht mit „---“ geschlossen.',
        'malformed-frontmatter':
          'Der Frontmatter enthält eine Zeile, die kein „schlüssel: wert“ ist. Außer „metadata“ sind hier keine verschachtelten Strukturen möglich.',
        'missing-name': 'Im Frontmatter fehlt „name“.',
        'missing-description': 'Im Frontmatter fehlt „description“.',
      },
    },
    schedulableLabel: 'Planbar',
    schedulableHint:
      'Darf zeitgesteuert laufen. Aus: Der Skill bleibt normal nutzbar, nur ein Zeitplan kann ihn nicht per Cron starten.',
    cards: {
      heading: 'Bevorzugte Ergebnis-Cards',
      hint: 'Der Agent gibt das Ergebnis bevorzugt als eine dieser Cards aus, sofern der Inhalt dazu passt – eine Präferenz, keine Vorgabe.',
      searchPlaceholder: 'Cards durchsuchen, z. B. Vergleich oder Fluchtweg',
      empty: 'Keine Präferenz – der Agent wählt die Card, die zur Antwort passt.',
      noMatches: 'Keine Card passt zu dieser Suche.',
      removeAria: 'Card-Typ „{type}“ aus der Präferenz entfernen',
    },
    cloneFrom: 'Geklont von „{name}“',
    enabledLabel: 'Aktiviert',
    enabledHint:
      'Aus: Der Skill verschwindet aus dem „/“-Menü und aus der Auswahl des Agenten. Bestehende Zeitpläne laufen mit ihrem gespeicherten Snapshot weiter.',
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
      label: 'Skill',
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
