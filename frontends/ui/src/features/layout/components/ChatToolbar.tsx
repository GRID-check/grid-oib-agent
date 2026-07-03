// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FC, memo, useCallback } from 'react'
import { Button, Divider, Flex, Text } from '@/adapters/ui'
import { ChatMessage, Globe } from '@/adapters/ui/icons'
import { useAuth } from '@/adapters/auth'
import { useLayoutStore } from '../store'

interface ChatToolbarProps {
  sessionTitle?: string
  onNewSession?: () => void
  isNewSessionDisabled?: boolean
}

export const ChatToolbar: FC<ChatToolbarProps> = memo(function ChatToolbar({
  sessionTitle = '',
  onNewSession,
  isNewSessionDisabled = false,
}) {
  const { isAuthenticated } = useAuth()
  const toggleSessionsPanel = useLayoutStore((s) => s.toggleSessionsPanel)

  const handleMenuClick = useCallback(() => {
    if (isAuthenticated) toggleSessionsPanel()
  }, [toggleSessionsPanel, isAuthenticated])

  const handleAddSourcesClick = useCallback(() => {
    if (!isAuthenticated) return
    const { rightPanel, closeRightPanel, openRightPanel } = useLayoutStore.getState()
    if (rightPanel === 'data-sources') closeRightPanel()
    else openRightPanel('data-sources')
  }, [isAuthenticated])

  const handleNewSessionClick = useCallback(() => {
    if (!isAuthenticated || isNewSessionDisabled) return
    onNewSession?.()
  }, [isAuthenticated, isNewSessionDisabled, onNewSession])

  return (
    <header className="border-b border-base bg-surface-raised-30">
      <Flex align="center" justify="between" className="h-12 gap-4 px-4">
        <Flex align="center" gap="2" className="min-w-0 flex-1">
          <Button
            kind="secondary"
            size="small"
            onClick={handleNewSessionClick}
            disabled={!isAuthenticated || isNewSessionDisabled}
            aria-label="Create new session"
          >
            New chat
          </Button>
          <Button
            kind="tertiary"
            size="small"
            onClick={handleMenuClick}
            disabled={!isAuthenticated}
            aria-label="Toggle sessions sidebar"
          >
            <Flex align="center" gap="1">
              <ChatMessage className="h-4 w-4" />
              <Text kind="label/bold/sm">Sessions</Text>
            </Flex>
          </Button>
          {sessionTitle ? <Divider orientation="vertical" /> : null}
          {sessionTitle ? (
            <Text kind="body/regular/sm" className="hidden max-w-[520px] truncate text-subtle md:block">
              {sessionTitle}
            </Text>
          ) : null}
        </Flex>
        <Button
          kind="tertiary"
          size="small"
          onClick={handleAddSourcesClick}
          disabled={!isAuthenticated}
          aria-label="Add data sources"
        >
          <Flex align="center" gap="1">
            <Globe className="h-4 w-4" />
            <Text kind="label/regular/md">Sources</Text>
          </Flex>
        </Button>
      </Flex>
    </header>
  )
})
