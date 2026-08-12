/**
 * File operations for a document — rename, delete, download.
 *
 * Three parts, one per layer: the hook does the work, the rename dialog is the
 * form, the menu composes both behind whatever trigger the surface hands it.
 * A surface that needs the standard control imports the menu; a surface with
 * its own chrome (the model viewport) imports the hook and renders its own.
 */

export {
  DocumentActionsMenu,
  type DocumentActionKind,
  type DocumentActionsMenuProps,
} from './document-actions-menu'
export { RenameDocumentDialog, type RenameDocumentDialogProps } from './rename-document-dialog'
export {
  useDocumentActions,
  type ActionableDocument,
  type DocumentActions,
  type DocumentScope,
  type UseDocumentActionsOptions,
} from './use-document-actions'
