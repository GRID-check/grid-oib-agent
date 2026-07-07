/** onboarding namespace — populated during component i18n. */
export const onboarding = {
  validation: {
    nameRequired: 'Organization name is required.',
  },
  steps: {
    createOrg: 'Create your organization',
    makeAdmin: 'Make you the workspace admin',
    openProject: 'Open Grid and your first project',
  },
  errors: {
    createFailed: 'Failed to create organization.',
    generic: 'Something went wrong.',
    title: 'Organization setup failed',
  },
  intro: {
    eyebrow: 'first workspace',
    title: 'Set your organization before Grid handles project data.',
    description:
      'Your organization is the private boundary for your building projects — documents, members, and OIB/RIS research all live inside it. You become its admin.',
  },
  features: {
    privateTenant: 'Private tenant',
    adminAccess: 'Admin access',
    projectsReady: 'Projects ready',
  },
  success: {
    eyebrow: 'workspace ready',
    title: 'You’re all set',
    description: 'Your organization is created and you’re the admin.',
    redirecting: 'Taking you to your projects…',
  },
  form: {
    eyebrow: 'organization setup',
    title: 'Name your organization',
    description: 'Use your office, practice, or client organization name.',
    nameLabel: 'Organization name',
    namePlaceholder: 'Grid Bauphysik Vienna',
    submit: 'Create organization',
  },
}
