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
    },
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
