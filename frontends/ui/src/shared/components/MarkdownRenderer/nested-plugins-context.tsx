/**
 * The remark plugins Markdown NESTED in a surface's content should parse with.
 *
 * A composed card can hold a run of the answer's own Markdown (A2UI's `Text`
 * inside a tab), and a `[2]` there is the answer's citation just as it is in
 * the prose. The surface that knows what `[N]` means (the chat answer) provides
 * the plugin once; a nested renderer reads it here. Card markers are left out
 * by the provider on purpose: a card inside a card is a `Column`, not a slot.
 */

'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { PluggableList } from 'unified'

const NestedMarkdownPluginsContext = createContext<PluggableList | undefined>(undefined)

export const NestedMarkdownPluginsProvider = ({
  plugins,
  children,
}: {
  plugins: PluggableList
  children: ReactNode
}) => <NestedMarkdownPluginsContext.Provider value={plugins}>{children}</NestedMarkdownPluginsContext.Provider>

/** The provided plugins, or undefined where no surface supplied any. */
export const useNestedMarkdownPlugins = (): PluggableList | undefined => useContext(NestedMarkdownPluginsContext)
