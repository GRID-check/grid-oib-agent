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
    foldersWithoutRole: {
      title: 'Ordner ohne gültige Rolle',
      description:
        'Die Zugriffsliste dieser Ordner nennt nur Rollen, die es nicht mehr gibt. Bis dort eine gültige Rolle eingetragen ist, können nur Organisations-Admins sie lesen.',
      open: 'Ordner „{name}“ öffnen',
    },
    sections: {
      parameters: 'Projektparameter',
      members: 'Mitglieder',
      memory: 'Projektgedächtnis',
      insights: 'Auswertung',
      reindex: 'Wissensindex',
      inboundMail: 'E-Mail-Eingang',
    },
    reindexDescription:
      'Den indexierten Inhalt aller Dokumente dieses Projekts neu aufbauen. Hochgeladene Dateien werden nicht gelöscht — nur die daraus abgeleiteten Abschnitte, auf die sich Antworten stützen. Sinnvoll nach einer Änderung daran, wie Dokumente indexiert werden.',
    reindexAction: 'Projekt neu indizieren',
    reindexBusy: 'Wird neu indiziert…',
    reindexStarted:
      'Die Neuindizierung läuft im Hintergrund und setzt sich nach einem Neustart fort. Der Status jedes Dokuments aktualisiert sich, sobald es fertig ist.',
    reindexFailed: 'Neuindizierung konnte nicht gestartet werden',
    membersDescriptionManage:
      'Weisen Sie Organisationsmitgliedern Projektrollen zu. Organisations-Admins haben immer Zugriff.',
    membersDescriptionReadOnly:
      'Wer Zugriff auf dieses Projekt hat. Nur Projekt-Admins können Zuweisungen ändern.',
    knowledgeLink: 'Wissensbasis öffnen',
    /** Die eigene Adresse des Projekts: Anhänge, die an sie gehen, landen im Projekt. */
    inboundMail: {
      description:
        'Senden Sie Dateien als Anhang an diese Adresse. Piloti legt sie in diesem Projekt unter E-Mail-Eingang ab, jede E-Mail in einem eigenen Ordner.',
      addressLabel: 'Projektadresse',
      rulesLabel: 'Was gilt',
      rules: {
        members:
          'Senden können Projektmitglieder, die Dokumente bearbeiten dürfen, sobald der E-Mail-Eingang für die Organisation eingeschaltet ist.',
        verified:
          'Die Domain des Absenders muss ihre E-Mails mit DKIM signieren. Andere E-Mails werden abgelehnt.',
        addressing: 'Die Adresse gehört in An oder Cc. Steht sie nur in Bcc, wird die E-Mail abgelehnt.',
        size: 'Anhänge zusammen höchstens etwa 18 MB, höchstens 100 Dateien pro E-Mail.',
        attachmentsOnly:
          'Abgelegt werden nur Anhänge: keine in den Text eingefügten Bilder, keine Links auf Cloud-Dateien. Der Text der E-Mail wird nicht gespeichert.',
      },
      helpLink: 'Anleitung und Gründe für abgelehnte E-Mails',
      rotate: 'Neue Adresse erzeugen',
      confirmTitle: 'Neue Adresse erzeugen?',
      confirmDescription:
        'Die bisherige Adresse funktioniert ab sofort nicht mehr, E-Mails an sie werden abgelehnt. Geben Sie die neue Adresse an alle weiter, die Dateien an dieses Projekt senden.',
      confirmAction: 'Neue Adresse erzeugen',
      rotated: 'Neue Adresse erzeugt',
      rotateFailed: 'Die neue Adresse konnte nicht erzeugt werden. Die bisherige gilt weiter.',
      loadFailed: 'Die E-Mail-Adresse des Projekts konnte nicht geladen werden.',
    },
    insights: {
      emptyTitle: 'Noch keine Auswertung verfügbar',
      emptyDescription:
        'Nutzungs- und Quellen-Auswertungen für dieses Projekt erscheinen hier, sobald sie verfügbar sind.',
    },
  },
}
