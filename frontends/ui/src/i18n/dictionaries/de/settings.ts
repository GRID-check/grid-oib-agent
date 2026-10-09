import type { en } from '../en'

/** The right-side settings panel + the project Settings page. */
export const settings: typeof en.settings = {
  title: 'Einstellungen',
  loading: 'Einstellungen werden geladen …',
  ariaLabel: 'Einstellungen',
  savedAutomatically: 'Einstellungen werden automatisch gespeichert.',
  appearance: {
    uiTheme: 'Design-Optionen',
    uiThemeAria: 'Oberflächendesign',
  },
  language: {
    heading: 'Sprache',
    ariaLabel: 'Sprache der Oberfläche',
  },
  openProfile: 'Vollständiges Profil öffnen',
  /**
   * Die Projekt-Einstellungen: eine Route je Bereich, verbunden über eine
   * Bereichsnavigation (wie bei der Organisation). Jeder Bereich beantwortet
   * eine Frage zum Projekt; die Texte sind genauso gruppiert.
   */
  project: {
    nav: {
      label: 'Projekteinstellungen',
      general: 'Allgemein',
      profile: 'Projektprofil',
      members: 'Mitglieder',
      memory: 'Gedächtnis',
      usage: 'Nutzung & Budget',
      documents: 'Dokumente & Index',
    },
    general: {
      identityTitle: 'Projekt',
      identityDescription: 'Der Name, unter dem alle in der Organisation dieses Projekt sehen.',
      nameLabel: 'Projektname',
      nameRequired: 'Bitte einen Namen eingeben.',
      save: 'Speichern',
      saved: 'Projekt umbenannt',
      saveError: 'Das Projekt konnte nicht umbenannt werden.',
      readOnlyHint: 'Nur Projekt-Admins können das Projekt umbenennen.',
      factsTitle: 'Auf einen Blick',
      created: 'Erstellt',
      documents: 'Dokumente',
      storage: 'Speicher',
      openFiles: 'Dateien öffnen',
    },
    profile: {
      title: 'Projektprofil',
      description:
        'Wovon Piloti bei jeder Antwort in diesem Projekt ausgeht: die Fakten aus dem Briefing, die Annahmen, die noch bestätigt werden sollen, und die Richtlinien, die sich daraus ergeben.',
    },
    members: {
      title: 'Mitglieder',
      description:
        'Weisen Sie Organisationsmitgliedern Projektrollen zu. Organisations-Admins haben immer Zugriff.',
    },
    memory: {
      readOnlyHint:
        'Sie können lesen, was Piloti sich merkt. Ändern erfordert Schreibrechte im Projekt.',
    },
    usage: {
      title: 'Nutzung',
      description:
        'Was Piloti in diesem Projekt verbraucht hat, gemessen an den Limits, die es stoppen würden. Zeitfenster in UTC: heute ab Mitternacht, dieser Monat ab dem 1.',
      today: 'Heute',
      thisMonth: 'Dieser Monat',
      requests: '{count, plural, one {# Anfrage} other {# Anfragen}}',
      byModelTitle: 'Nach Modell, dieser Monat',
      empty: 'In diesem Monat wurde in diesem Projekt noch nichts verbraucht.',
      limitTitle: 'Projektlimit',
      limitDescription:
        'Ein Limit hier stoppt Piloti nur in diesem Projekt, bevor das Limit der Organisation erreicht ist. Es kann das Limit der Organisation nie überschreiten.',
      noProjectLimit: 'Kein Projektlimit. Es gilt nur das Limit der Organisation.',
      orgCeiling: 'Limit der Organisation: {limits}',
      orgCeilingNone: 'Die Organisation hat kein Limit gesetzt.',
      setLimit: 'Limit setzen',
      editLimit: 'Limit ändern',
      blockedProject: 'Das Limit dieses Projekts ist ausgeschöpft. Neue Anfragen hier werden blockiert.',
      blockedOrganization:
        'Das Limit der Organisation ist ausgeschöpft. Neue Anfragen werden überall blockiert.',
    },
    documents: {
      uploadsTitle: 'Upload-Verlauf',
      indexTitle: 'Wissensindex',
      indexDescription:
        'Den indexierten Inhalt aller Dokumente dieses Projekts neu aufbauen. Hochgeladene Dateien werden nicht gelöscht, nur die daraus abgeleiteten Abschnitte, auf die sich Antworten stützen. Sinnvoll nach einer Änderung daran, wie Dokumente indexiert werden.',
      reindexAction: 'Projekt neu indizieren',
      reindexConfirmTitle: 'Alle Dokumente dieses Projekts neu indizieren?',
      reindexBusy: 'Wird neu indiziert…',
      reindexStarted:
        'Die Neuindizierung läuft im Hintergrund und setzt sich nach einem Neustart fort. Der Status jedes Dokuments aktualisiert sich, sobald es fertig ist.',
      reindexFailed: 'Neuindizierung konnte nicht gestartet werden',
      knowledgeTitle: 'Wissensbasis',
      knowledgeDescription: 'Was die Wissensbasis des Projekts enthält, Abschnitt für Abschnitt.',
      knowledgeLink: 'Wissensbasis öffnen',
    },
  },
}
