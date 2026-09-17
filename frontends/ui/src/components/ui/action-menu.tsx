'use client'

/**
 * One list of actions, two triggers.
 *
 * Dropdown (⋯) and context menu (right-click) are different Radix primitives
 * with the same parts. Surfaces build an entry list once; this renders it as
 * either shape so the two cannot drift. Nothing here knows what a document is.
 */

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export type ActionMenuItemEntry = {
  type: 'item'
  id: string
  label: string
  icon?: LucideIcon
  variant?: 'default' | 'destructive'
  disabled?: boolean
  onSelect: () => void
  testId?: string
}

export type ActionMenuSeparatorEntry = { type: 'separator' }

export type ActionMenuSubEntry = {
  type: 'sub'
  id: string
  label: string
  icon?: LucideIcon
  disabled?: boolean
  testId?: string
  items: ActionMenuEntry[]
}

export type ActionMenuRadioEntry = {
  type: 'radio-group'
  value: string
  onValueChange: (value: string) => void
  items: { value: string; label: string; testId?: string }[]
}

export type ActionMenuEntry =
  | ActionMenuItemEntry
  | ActionMenuSeparatorEntry
  | ActionMenuSubEntry
  | ActionMenuRadioEntry

type MenuParts = {
  Item: typeof DropdownMenuItem
  Separator: typeof DropdownMenuSeparator
  Sub: typeof DropdownMenuSub
  SubTrigger: typeof DropdownMenuSubTrigger
  SubContent: typeof DropdownMenuSubContent
  RadioGroup: typeof DropdownMenuRadioGroup
  RadioItem: typeof DropdownMenuRadioItem
}

const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
}

const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
}

function renderEntries(entries: readonly ActionMenuEntry[], parts: MenuParts): ReactNode {
  return entries.map((entry, index) => {
    switch (entry.type) {
      case 'separator':
        return <parts.Separator key={`sep-${index}`} />
      case 'item': {
        const Icon = entry.icon
        return (
          <parts.Item
            key={entry.id}
            variant={entry.variant}
            disabled={entry.disabled}
            onSelect={entry.onSelect}
            data-testid={entry.testId}
          >
            {Icon ? <Icon className="size-4" aria-hidden /> : null}
            {entry.label}
          </parts.Item>
        )
      }
      case 'sub': {
        const Icon = entry.icon
        return (
          <parts.Sub key={entry.id}>
            <parts.SubTrigger disabled={entry.disabled} data-testid={entry.testId}>
              {Icon ? <Icon className="size-4" aria-hidden /> : null}
              {entry.label}
            </parts.SubTrigger>
            <parts.SubContent className="max-h-72 w-64 overflow-y-auto">
              {renderEntries(entry.items, parts)}
            </parts.SubContent>
          </parts.Sub>
        )
      }
      case 'radio-group':
        return (
          <parts.RadioGroup
            key={`radio-${index}`}
            value={entry.value}
            onValueChange={entry.onValueChange}
          >
            {entry.items.map((item) => (
              <parts.RadioItem key={item.value} value={item.value} data-testid={item.testId}>
                {item.label}
              </parts.RadioItem>
            ))}
          </parts.RadioGroup>
        )
      default: {
        const _exhaustive: never = entry
        return _exhaustive
      }
    }
  })
}

export interface ActionMenuProps {
  entries: readonly ActionMenuEntry[]
  mode: 'dropdown' | 'context'
  /** Dropdown trigger (the ⋯). Ignored in context mode. */
  trigger?: ReactNode
  /** Context-menu target. Ignored in dropdown mode. */
  children?: ReactNode
  contentClassName?: string
  align?: 'start' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  onOpenChange?: (open: boolean) => void
  /**
   * Context mode only: clone the child as the trigger (a `forwardRef` host
   * such as a table row). Default wraps in a div, which is the safe option
   * for a card that does not forward a ref.
   */
  asChild?: boolean
}

export function ActionMenu({
  entries,
  mode,
  trigger,
  children,
  contentClassName = 'w-56',
  align = 'end',
  side = 'bottom',
  onOpenChange,
  asChild = false,
}: ActionMenuProps): ReactNode {
  if (entries.length === 0) {
    // A context host with nothing to offer is still the listing; swallowing
    // it would blank the pane. A dropdown with nothing to offer is not a
    // control.
    return mode === 'context' ? (children ?? null) : null
  }

  if (mode === 'dropdown') {
    if (!trigger) return null
    return (
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} side={side} className={contentClassName}>
          {renderEntries(entries, DROPDOWN_PARTS)}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>
        {asChild ? children : <div className="h-full min-w-0">{children}</div>}
      </ContextMenuTrigger>
      <ContextMenuContent className={contentClassName}>
        {renderEntries(entries, CONTEXT_PARTS)}
      </ContextMenuContent>
    </ContextMenu>
  )
}
