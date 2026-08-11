import type { en } from '../en'

/**
 * Agent Skills: die Skill-Bibliothek der Organisation, ihr Editor und der
 * „/“-Aufruf im Chat-Composer.
 *
 * Ein Skill weiß nichts über Zeit. Alles, was einen Prompt nach Zeitplan
 * ausführt — samt optional angehängtem Skill und der Ausgabe — steht im
 * Namensraum `jobs`.
 */
export const skills: typeof en.skills = {
  title: 'Skills',
  subtitle:
    'Wiederverwendbare Anweisungen, die Ihre Organisation im Chat mit „/“ aufrufen oder an einen Job anhängen kann. Ein bearbeiteter Skill ändert nie einen Job, der ihn bereits verwendet — dieser behält seinen gespeicherten Snapshot.',
  tryAgain: 'Erneut versuchen',

  toolbox: {
    heading: 'Skill-Bibliothek',
    hint: 'Skills von Piloti sowie Skills, die Ihre Organisation erstellt oder geklont hat. Ein Job kann einen davon anhängen — ein bearbeiteter Skill ändert nie einen Job, der ihn bereits verwendet (dessen Snapshot bleibt erhalten).',
    newSkill: 'Neuer Skill',
    loadError: 'Die Skill-Bibliothek konnte nicht geladen werden.',
    empty: {
      title: 'Noch keine Skills',
      description:
        'Erstellen Sie einen Skill für Ihre Organisation oder klonen Sie einen von Piloti und passen Sie ihn an. Ein Skill ist eine wiederverwendbare Anweisung (agentskills.io-Format), die Chats und Jobs aufrufen können.',
      action: 'Neuer Skill',
    },
    origin: {
      platform: 'Von Piloti',
      org: 'In dieser Organisation',
      cloned: 'Geklont',
    },
    scope: {
      chatOnly: 'Nur Chat-Agent',
      deepOnly: 'Nur Deep Research',
    },
    actions: {
      clone: 'Klonen',
      cloneAria: 'Skill „{name}“ in diese Organisation klonen',
      edit: 'Bearbeiten',
      delete: 'Löschen',
      viewBody: 'Anweisung ansehen',
    },
  },

  actions: {
    delete: 'Löschen',
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
    editSubtitle:
      'Passen Sie den Skill an. Jobs, die ihn bereits verwenden, behalten ihren gespeicherten Snapshot.',
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
    agents: {
      heading: 'Verfügbarkeit',
      hint: 'Welche Agenten diesen Skill verwenden dürfen. Standard: beide.',
      chat: {
        label: 'Chat-Agent',
        hint: 'Beantwortet Fragen im Chat. Hier rufen Sie den Skill mit „/“ auf.',
      },
      deep: {
        label: 'Deep-Research-Agent',
        hint: 'Führt die ausführliche Recherche im Hintergrund aus und schreibt den Bericht.',
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
      'Aus: Der Skill verschwindet aus dem „/“-Menü und aus der Auswahl des Agenten. Jobs, die ihn bereits verwenden, laufen mit ihrem gespeicherten Snapshot weiter.',
    save: 'Skill speichern',
    saving: 'Wird gespeichert…',
    cancel: 'Abbrechen',
    createSuccess: 'Skill erstellt.',
    updateSuccess: 'Skill gespeichert.',
    saveError: 'Der Skill konnte nicht gespeichert werden.',
    deleteTitle: 'Skill löschen',
    deleteDescription:
      'Dadurch wird „{name}“ aus der Bibliothek entfernt. Jobs, die ihn bereits verwenden, behalten ihren gespeicherten Snapshot und laufen unverändert weiter.',
    deleteConfirm: 'Skill löschen',
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
