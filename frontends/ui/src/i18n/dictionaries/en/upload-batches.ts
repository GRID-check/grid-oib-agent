/**
 * What one upload brought in, and a project's uploads over time (ADR-0086).
 *
 * The status words („Citable", „Reading", „Quarantined", „Failed", „Filed")
 * are NOT here: the summary reads them from `files.status.*`, so a count and
 * the badge beside a file cannot name one state two ways.
 */
export const uploadBatches = {
  summary: {
    title: 'What arrived',
    loading: 'Loading the summary…',
    // Where the upload went, when the project's name cannot be read.
    place: {
      project: 'Project',
      archiv: 'Archiv',
      session: 'Chat',
    },
    open: {
      project: 'Open files',
      archiv: 'Open Archiv',
      session: 'Open chat',
    },
    state: {
      sending: 'The upload is still running.',
      reading: 'Piloti is still reading. This summary updates itself.',
      done: 'Everything has been read.',
    },
    counts: {
      label: 'At a glance',
      unchanged: 'Unchanged',
      excluded: 'Not uploaded',
    },
    uploadFailed:
      '{count, plural, one {# file did not arrive. Upload it again.} other {# files did not arrive. Upload them again.}}',
    types: {
      title: 'Document types',
    },
    excluded: {
      title: 'Not uploaded',
      description:
        'These files never left your computer. Your office marks these terms in file and folder names as sensitive.',
      listLabel: 'Files kept back, by term',
    },
    files: {
      title: 'Files',
      root: {
        project: 'Project folder',
        archiv: 'Archiv',
        session: 'Chat',
      },
      empty: 'No file from this upload reached Piloti.',
      pages: '{count, plural, one {# page} other {# pages}}',
      reasonsLabel: 'Why it is held back',
      openInFiles: 'Open in Files',
      openInArchiv: 'Open in the Archiv',
    },
    notFound: {
      title: 'Summary not found',
      description: 'This summary no longer exists or belongs to someone else.',
    },
    error: {
      title: 'The summary could not be loaded',
      description: 'Check your connection and try again.',
    },
  },
  history: {
    title: 'Uploads',
    description:
      'Who uploaded how many files, and when. Each person sees the file-by-file summary of their own uploads only.',
    you: 'You',
    files: '{count, plural, one {# file} other {# files}}',
    open: 'Summary',
    openLabel: 'Open the summary of your upload from {date}',
    countsLabel: 'Outcome',
    empty: {
      title: 'No uploads yet',
      description: 'Uploads to this project appear here with what became of each file.',
    },
    error: 'The upload history could not be loaded.',
  },
}
