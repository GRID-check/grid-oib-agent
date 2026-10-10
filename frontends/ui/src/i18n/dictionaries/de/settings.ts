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
      members: 'Mitglieder',
      memory: 'Gedächtnis',
      usage: 'Nutzung & Budget',
      documents: 'Dokumente & Index',
      references: 'Ähnliche Projekte',
    },
    foldersWithoutRole: {
      title: 'Ordner ohne gültige Rolle',
      description:
        'Die Zugriffsliste dieser Ordner nennt nur Rollen, die es nicht mehr gibt. Bis dort eine gültige Rolle eingetragen ist, können nur Organisations-Admins sie lesen.',
      open: 'Ordner „{name}“ öffnen',
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
      activity: {
        label: 'Aktivität',
        thisMonth: 'Diesen Monat',
        questionsWord: '{count, plural, one {Frage} other {Fragen}}',
        questions: '{count, plural, one {# Frage} other {# Fragen}}',
        peopleLabel: 'Fragende Personen',
        empty: 'In den letzten 30 Tagen keine Fragen. Fragen Sie Piloti etwas zu diesem Projekt, um loszulegen.',
      },
      similar: {
        label: 'Ähnliche Projekte',
        open: '{count, plural, one {Ähnliches Projekt öffnen} other {Alle # ähnlichen Projekte}}',
        openOthers: 'Abgeschlossene Projekte ansehen',
        empty: 'Noch kein abgeschlossenes Projekt im Büro. Es erscheint hier, sobald eines abgeschlossen ist.',
      },
      usage: {
        label: 'Verbrauch diesen Monat',
        noLimit: 'Kein Monatslimit',
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
