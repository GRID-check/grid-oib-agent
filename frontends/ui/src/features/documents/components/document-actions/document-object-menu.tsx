'use client'

/**
 * A document tile's two triggers: the ⋯ and the right-click.
 *
 * Wraps the tile in a context menu and exposes the overflow button through
 * {@link DocumentActionsTrigger}, so FileCard/FileListView keep their `actions`
 * slot and do not need to know which primitive opened. Dialogs live here once
 * so closing the menu does not unmount a rename already in flight.
 */

import { createContext, useContext, type ReactNode } from 'react'
import { ActionMenu } from '@/components/ui/action-menu'
import { useTranslations } from '@/i18n'
import {
  DEFAULT_DOCUMENT_ACTIONS,
  type DocumentActionKind,
} from './action-entries'
import {
  useDocumentActionMenu,
  type DocumentActionsMenuProps,
} from './document-actions-menu'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'

const TriggerContext = createContext<ReactNode>(null)

export function DocumentActionsTrigger(): ReactNode {
  return useContext(TriggerContext)
}

export interface DocumentObjectMenuProps extends Omit<
  DocumentActionsMenuProps,
  'trigger' | 'align' | 'side' | 'actions'
> {
  actions?: readonly DocumentActionKind[]
  children: ReactNode
  asChild?: boolean
}

export function DocumentObjectMenu({
  children,
  actions = DEFAULT_DOCUMENT_ACTIONS,
  asChild = false,
  ...props
}: DocumentObjectMenuProps): ReactNode {
  const t = useTranslations(props.scope)
  const { entries, dialogs, name } = useDocumentActionMenu({ ...props, actions })
  const trigger =
    entries.length === 0 ? null : (
      <ActionMenu
        mode="dropdown"
        entries={entries}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 bg-background/80 shadow-2xs backdrop-blur-sm"
            aria-label={t('actions.label', { name })}
            title={t('actions.menuLabel')}
            data-testid="document-actions-trigger"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        }
      />
    )

  if (entries.length === 0) return children

  return (
    <TriggerContext.Provider value={trigger}>
      <ActionMenu mode="context" entries={entries} asChild={asChild}>
        {children}
      </ActionMenu>
      {dialogs}
    </TriggerContext.Provider>
  )
}
