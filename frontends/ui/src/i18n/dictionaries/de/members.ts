import type { en } from '../en'

/** members namespace — populated during component i18n. */
export const members: typeof en.members = {
  header: {
    eyebrow: 'Zugriff',
    title: 'Mitglieder von {name}',
    projectFallback: 'Projekt',
    descriptionManage:
      'Gewähren Sie Organisationsmitgliedern Zugriff auf dieses Projekt, indem Sie eine Projektrolle zuweisen, oder setzen Sie „Kein Zugriff“, um sie zu entfernen.',
    descriptionReadOnly:
      'Alle mit Zugriff auf dieses Projekt. Nur Projekt-Administratoren können Rollen ändern oder Mitglieder hinzufügen.',
  },
  roles: {
    'project-viewer': 'Betrachter',
    'project-editor': 'Bearbeiter',
    'project-admin': 'Administrator',
  },
  roleDescriptions: {
    'project-viewer':
      'Kann Projektinhalte, Dateien und Unterhaltungen ansehen, aber nichts ändern.',
    'project-editor':
      'Kann außerdem Dokumente bearbeiten, Workflows ausführen und das Projektprofil aktualisieren.',
    'project-admin': 'Kann außerdem Projekteinstellungen, Mitglieder und Rollen verwalten.',
  },
  validation: {
    emailRequired: 'E-Mail ist erforderlich',
    emailInvalid: 'Geben Sie eine gültige E-Mail-Adresse ein',
  },
  errors: {
    loadFailed: 'Mitglieder konnten nicht geladen werden',
    updateFailed: 'Rolle konnte nicht aktualisiert werden',
    loadTitle: 'Mitglieder konnten nicht geladen werden',
    actionTitle: 'Zugriffsaktualisierung fehlgeschlagen',
  },
  invite: {
    title: 'Mitglied hinzufügen',
    description: 'Gewähren Sie einem bestehenden Organisationsmitglied Zugriff auf dieses Projekt.',
    memberLabel: 'Mitglied',
    searchPlaceholder: 'Nach Name oder E-Mail suchen',
    suggestionsAria: 'Passende Organisationsmitglieder',
    noSuggestions:
      'Keine Organisationsmitglieder gefunden. Neue Teammitglieder müssen zuerst der Organisation beitreten.',
    roleLabel: 'Rolle',
    submit: 'Mitglied hinzufügen',
    notFound:
      'Kein Organisationsmitglied verwendet diese E-Mail-Adresse. Es muss der Organisation beitreten, bevor es diesem Projekt hinzugefügt werden kann.',
    success: '{name} hat nun {role}-Zugriff auf dieses Projekt.',
  },
  readOnly: {
    title: 'Schreibgeschützter Zugriff',
    description:
      'Sie können alle Mitglieder dieses Projekts sehen. Nur Projekt-Administratoren können Rollen ändern oder Mitglieder hinzufügen.',
  },
  roster: {
    title: 'Mitglieder',
    counts: '{active} mit Zugriff · {total} in der Organisation',
    searchPlaceholder: 'Nach Name oder E-Mail suchen',
    searchAria: 'Projektmitglieder durchsuchen',
    saving: 'wird gespeichert',
    roleForMember: 'Projektrolle für {name}',
    noAccessOption: 'Kein Projektzugriff',
    noAccess: 'Kein Zugriff',
    emptyTitle: 'Noch keine Mitglieder',
    emptyDescription:
      'Organisationsmitglieder, die Sie hinzufügen, erscheinen hier mit ihrer Projektrolle.',
    noMatchTitle: 'Keine passenden Mitglieder',
    noMatchDescription:
      'Niemand entspricht Ihrer Suche. Setzen Sie sie zurück, um die vollständige Liste zu sehen.',
    clearSearch: 'Suche zurücksetzen',
  },
  tryAgain: 'Erneut versuchen',
}
