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
    alreadyHasRole: '{name} hat bereits {role}-Zugriff auf dieses Projekt — keine Änderung nötig.',
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
    youBadge: 'Sie',
    emptyTitle: 'Noch keine Mitglieder',
    emptyDescription:
      'Organisationsmitglieder, die Sie hinzufügen, erscheinen hier mit ihrer Projektrolle.',
    noMatchTitle: 'Keine passenden Mitglieder',
    noMatchDescription:
      'Niemand entspricht Ihrer Suche. Setzen Sie sie zurück, um die vollständige Liste zu sehen.',
    clearSearch: 'Suche zurücksetzen',
  },
  confirm: {
    selfChangeTitle: 'Eigene Rolle ändern?',
    selfChangeDescription:
      'Sie sind dabei, Ihre eigene Projektrolle auf {role} zu ändern. Wenn die neue Rolle keine Mitglieder verwalten kann, können Sie dies nicht selbst rückgängig machen — ein anderer Projekt-Administrator müsste das übernehmen.',
    selfChangeConfirm: 'Meine Rolle ändern',
    selfRemoveTitle: 'Eigenen Zugriff entfernen?',
    selfRemoveDescription:
      'Sie sind dabei, Ihren eigenen Zugriff auf dieses Projekt zu entfernen. Sie verlieren die Möglichkeit, es zu sehen oder zu verwalten, und benötigen einen anderen Projekt-Administrator, um wieder hinzugefügt zu werden.',
    selfRemoveConfirm: 'Meinen Zugriff entfernen',
    roleChangeTitle: 'Stattdessen Rolle ändern?',
    roleChangeDescription:
      '{name} hat bereits {from}-Zugriff auf dieses Projekt. „Mitglied hinzufügen" würde die Rolle auf {to} ändern, anstatt jemand Neuen hinzuzufügen.',
    roleChangeConfirm: 'Rolle zu {role} ändern',
  },
  tryAgain: 'Erneut versuchen',
}
