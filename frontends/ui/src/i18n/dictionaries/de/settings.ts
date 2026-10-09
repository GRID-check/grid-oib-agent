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
      overview: 'Übersicht',
      profile: 'Projektprofil',
      members: 'Mitglieder',
      memory: 'Gedächtnis',
      usage: 'Nutzung & Budget',
      documents: 'Dokumente & Index',
    },
    overview: {
      createdOn: 'Erstellt am {date}',
      documentsCount: '{count, plural, one {# Dokument} other {# Dokumente}}',
      summaryEmpty: 'Noch kein Briefing. Richten Sie eines ein, damit Piloti weiß, worum es in diesem Projekt geht, bevor es antwortet.',
      setUpBrief: 'Briefing einrichten',
      editBrief: 'Briefing bearbeiten',
      askPiloti: 'Piloti fragen',
      openFiles: 'Dateien öffnen',
      actions: 'Projektaktionen',
      rename: 'Umbenennen',
      delete: 'Projekt löschen',
      usage: {
        label: 'Verbrauch diesen Monat',
        noLimit: 'Kein Monatslimit',
        trendEmpty: 'In den letzten 30 Tagen nichts verbraucht.',
        blocked: 'Limit erreicht, Anfragen werden blockiert',
        open: 'Nutzung & Budget',
      },
      documents: {
        label: 'Dokumente',
        storage: '{size} gespeichert',
        empty: 'Noch keine Dokumente. Ziehen Sie Dateien irgendwo ins Projekt, um sie hinzuzufügen.',
        open: 'Dokumente & Index',
      },
      memory: {
        label: 'Gedächtnis',
        notes: '{count, plural, one {Notiz} other {Notizen}}',
        toReview: '{count, plural, one {# zu prüfen} other {# zu prüfen}}',
        allReviewed: 'Alles bestätigt',
        empty: 'Piloti hat sich zu diesem Projekt noch nichts gemerkt.',
        error: 'Das Gedächtnis konnte nicht geladen werden.',
        open: 'Gedächtnis',
      },
      members: {
        label: 'Mitglieder',
        count: '{count, plural, one {Person} other {Personen}}',
        empty: 'Diesem Projekt ist noch niemand zugewiesen.',
        error: 'Die Mitgliederliste konnte nicht geladen werden.',
        open: 'Mitglieder',
      },
      profile: {
        label: 'Briefing',
        captured: '{answered} von {total} Angaben',
        toConfirm: '{count, plural, one {# Annahme zu bestätigen} other {# Annahmen zu bestätigen}}',
        unknown: 'Noch unbekannt',
        complete: 'Im Briefing ist nichts offen.',
        open: 'Projektprofil',
      },
      standards: {
        label: 'Anwendbare OIB-Richtlinien',
        required: '{count} erforderlich',
        check: '{count} zu prüfen',
        empty: 'Vervollständigen Sie das Briefing, um zu sehen, welche OIB-Richtlinien gelten.',
        open: 'Alle Richtlinien',
      },
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
