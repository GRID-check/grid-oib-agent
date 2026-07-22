/** members namespace — populated during component i18n. */
export const members = {
  header: {
    eyebrow: 'Access',
    title: '{name} members',
    projectFallback: 'Project',
    descriptionManage:
      'Grant organization members access to this project by assigning a project role, or set no access to remove them.',
    descriptionReadOnly:
      'Everyone with access to this project. Only project admins can change roles or add members.',
  },
  roles: {
    'project-viewer': 'Viewer',
    'project-editor': 'Editor',
    'project-admin': 'Admin',
  },
  roleDescriptions: {
    'project-viewer': 'Can view project content, files, and conversations, but not change anything.',
    'project-editor': 'Can also edit documents, run workflows, and update the project profile.',
    'project-admin': 'Can also manage project settings, members, and roles.',
  },
  validation: {
    emailRequired: 'Email is required',
    emailInvalid: 'Enter a valid email address',
  },
  errors: {
    loadFailed: 'Failed to load members',
    updateFailed: 'Failed to update role',
    loadTitle: "Couldn't load members",
    actionTitle: 'Access update failed',
    lastAdmin:
      'This project must keep at least one admin. Make someone else an admin before removing or changing this one.',
  },
  invite: {
    title: 'Add a member',
    description: 'Grant an existing organization member access to this project.',
    memberLabel: 'Member',
    searchPlaceholder: 'Search by name or email',
    suggestionsAria: 'Matching organization members',
    noSuggestions:
      'No organization members match. New teammates must join the organization first.',
    roleLabel: 'Role',
    submit: 'Add member',
    notFound:
      'No organization member uses that email. They need to join the organization before they can be added to this project.',
    success: '{name} now has {role} access to this project.',
    alreadyHasRole: '{name} already has {role} access to this project — nothing to change.',
  },
  readOnly: {
    title: 'Read-only access',
    description:
      'You can see everyone on this project. Only project admins can change roles or add members.',
  },
  roster: {
    title: 'Members',
    counts: '{active} with access · {total} in organization',
    searchPlaceholder: 'Search by name or email',
    searchAria: 'Search project members',
    saving: 'saving',
    roleForMember: 'Project role for {name}',
    noAccessOption: 'No project access',
    noAccess: 'No access',
    youBadge: 'You',
    emptyTitle: 'No members yet',
    emptyDescription:
      'Organization members you add will appear here with their project role.',
    noMatchTitle: 'No matching members',
    noMatchDescription: 'No one matches your search. Clear it to see the full roster.',
    clearSearch: 'Clear search',
  },
  /**
   * Confirmation copy for role changes that are easy to click without
   * meaning to: an admin editing their own row (self-demotion/lockout), or
   * "Add member" landing on someone who already has a different role
   * (a silent downgrade dressed up as an add).
   */
  confirm: {
    selfChangeTitle: 'Change your own role?',
    selfChangeDescription:
      "You're about to change your own project role to {role}. If the new role can't manage members, you won't be able to undo this yourself — another project admin would have to.",
    selfChangeConfirm: 'Change my role',
    selfRemoveTitle: 'Remove your own access?',
    selfRemoveDescription:
      "You're about to remove your own access to this project. You'll lose the ability to see or manage it, and will need another project admin to add you back.",
    selfRemoveConfirm: 'Remove my access',
    roleChangeTitle: 'Change their role instead?',
    roleChangeDescription:
      '{name} already has {from} access to this project. "Add member" would change their role to {to} rather than adding someone new.',
    roleChangeConfirm: 'Change role to {role}',
  },
  tryAgain: 'Try again',
}
