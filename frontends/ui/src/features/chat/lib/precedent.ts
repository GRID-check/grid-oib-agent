import type { CitedDocument } from './citations'

/**
 * A source from another project than the chat's: a precedent, labelled as one
 * (docs/design/closed-project-experience.md). The coarse kind stays `projekt`;
 * the label is what tells it apart from the chat's own files.
 */
export const isPrecedent = (doc: CitedDocument, chatProjectId: string | null | undefined): boolean =>
  doc.project !== undefined && doc.project.id !== chatProjectId
