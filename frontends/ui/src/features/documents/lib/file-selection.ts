import type { FileItem } from '../components/project-file-workspace'

/**
 * A listing in which documents are CHOSEN, not opened — the document picker.
 *
 * The Files browser's cards and rows open a document on a click; a picker
 * reuses the same cards and rows (the same thumbnails, the same columns, the
 * same folders) and asks them to carry a mark instead. One contract for the
 * card, the list row and the pane that renders both, so a chosen document
 * looks chosen the same way in either view.
 */
export interface FileSelection {
  isChecked: (file: FileItem) => boolean
  onToggle: (file: FileItem) => void
  /** Why this document cannot be chosen here, shown in its place; null when it can. */
  disabledReason?: (file: FileItem) => string | null
  /** The checkbox's accessible name for one document. */
  label: (file: FileItem) => string
}
