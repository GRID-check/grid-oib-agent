/** Error, not-found, and auth-error surfaces. */
export const errors = {
  notFound: {
    code: '404',
    title: "We couldn't find that",
    description:
      "The page or project you're looking for doesn't exist, or you no longer have access to it.",
    action: 'Back to projects',
  },
  appError: {
    code: 'Error',
    title: 'Something went wrong',
    description: 'An unexpected error occurred. You can try again, or head back to your projects.',
    action: 'Try again',
    backAction: 'Back to projects',
  },
  access: {
    code: 'Access',
    title: 'You don’t have access to this',
    description:
      'This project may have been moved, or your access was changed. Check with a project admin if you think this is a mistake.',
    action: 'Go Home',
  },
  auth: {
    title: 'Authentication error',
    heading: 'Authentication Error',
    description: 'We could not sign you in. Please try again.',
    action: 'Back to home',
    tryAgain: 'Try Again',
    goHome: 'Go Home',
    redirecting: 'Redirecting…',
    loading: 'Loading',
    messages: {
      Configuration: 'There is a problem with the server configuration.',
      AccessDenied: 'You do not have permission to access this resource.',
      Verification: 'The verification link has expired or has already been used.',
      Default: 'An error occurred during authentication.',
    },
  },
  /**
   * A conversation that drew on a folder with restricted access, refusing to
   * carry its content where others read it (ADR-0087,
   * `lib/conversations/restricted-egress.ts`). One sentence per door, relayed
   * as the API error: the agent quotes the German one to the reader.
   */
  confinement: {
    deepResearch:
      'This conversation draws on a folder with restricted access or on another project, so it cannot start a deep research run: the run, its title and its report would be visible to everyone in the project, including people who may not read that folder or project.',
    task: 'This conversation draws on a folder with restricted access or on another project, so it cannot create a task: tasks are visible to everyone in the project, including people who may not read that folder or project.',
    profilePatch:
      'This conversation draws on a folder with restricted access or on another project, so it cannot change the project context: the project context is visible to everyone in the project, including people who may not read that folder or project.',
    filing:
      'This conversation draws on a folder with restricted access or on another project, so nothing from it can be filed there: that place is visible to people who may not read the restricted folder or the other project. Filing works only into a folder restricted at least as narrowly, and never for content from other projects.',
    revision:
      'This document is in a folder with restricted access, so Piloti cannot revise it: the task for that would be visible to everyone in the project, including people not cleared for that folder. Request the changes without Piloti.',
    planDocument:
      'A document you named sits in a folder with restricted access, so it cannot be handed to a research run: a run’s documents and its report are visible to everyone in the project, including people not cleared for that folder.',
  },
  /**
   * The cross-project lookups (ADR-0094), refusing where their findings could
   * reach someone who may not open the other project. Relayed as the API error;
   * the agent quotes the German one to the reader.
   */
  crossProject: {
    audienceChanged:
      'Who may read this conversation changed just now, so nothing was taken from other projects. Please ask again.',
    memory:
      'This conversation drew on other projects that are still running, or on folders of other projects with their own access list, so nothing from it is saved to project or office memory: everyone in this project reads that memory, including people who may not open those projects or folders. What came from the open folders of closed projects may be saved.',
  },
}
