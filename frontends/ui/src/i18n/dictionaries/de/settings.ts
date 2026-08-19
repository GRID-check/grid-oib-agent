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
   * Die Projekt-Einstellungsseite (Spec §5, FB-9): Projektparameter +
   * Mitglieder + Gedächtnis + Insights + Gefahrenzone, konsolidiert aus den
   * alten Übersichts- und Mitgliederseiten.
   */
  project: {
    eyebrow: 'Projekteinstellungen',
    createdOn: 'Erstellt am {date}',
    status: {
      active: 'Aktiv',
      completed: 'Abgeschlossen',
    },
    parameters: {
      fields: {
        name: 'Projektname',
        location: 'Standort',
        buildingClass: 'Gebäudeklasse',
        constructionType: 'Bauart',
        use: 'Nutzung',
        status: 'Status',
      },
      notProvided: 'Nicht angegeben',
      edit: 'Angaben bearbeiten',
    },
    sections: {
      parameters: 'Projektparameter',
      members: 'Mitglieder',
      memory: 'Projektgedächtnis',
      insights: 'Auswertung',
      reindex: 'Wissensindex',
    },
    reindexDescription:
      'Den indexierten Inhalt aller Dokumente dieses Projekts neu aufbauen. Hochgeladene Dateien werden nicht gelöscht — nur die daraus abgeleiteten Abschnitte, auf die sich Antworten stützen. Sinnvoll nach einer Änderung daran, wie Dokumente indexiert werden.',
    reindexAction: 'Projekt neu indizieren',
    reindexBusy: 'Wird neu indiziert…',
    reindexDone:
      '{count, plural, one {# Dokument wird} other {# Dokumente werden}} neu indiziert. Der Status aktualisiert sich laufend.',
    reindexNothing: 'Nichts zu indizieren — kein Dokument in diesem Projekt hat bisher gespeicherte Inhalte',
    reindexPartial:
      '{count, plural, one {# Dokument wurde} other {# Dokumente wurden}} nicht geändert, weil der alte Index nicht zuerst geleert werden konnte',
    reindexFailed: 'Neuindizierung konnte nicht gestartet werden',
    membersDescriptionManage:
      'Weisen Sie Organisationsmitgliedern Projektrollen zu. Organisations-Admins haben immer Zugriff.',
    membersDescriptionReadOnly:
      'Wer Zugriff auf dieses Projekt hat. Nur Projekt-Admins können Zuweisungen ändern.',
    knowledgeLink: 'Wissensbasis öffnen',
    insights: {
      emptyTitle: 'Noch keine Auswertung verfügbar',
      emptyDescription:
        'Nutzungs- und Quellen-Auswertungen für dieses Projekt erscheinen hier, sobald sie verfügbar sind.',
    },
  },
}
