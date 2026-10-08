import type { PluggableList } from 'unified'

export interface MarkdownRendererProps {
  /** Markdown content to render */
  content: string
  /** Whether content is still streaming: stabilise half-arrived Markdown and hold the open fence's place */
  isStreaming?: boolean
  /** Additional CSS classes for the wrapper */
  className?: string
  /** Use compact text sizes (for chat bubbles vs full reports) */
  compact?: boolean
  /**
   * Remark plugins to run after the renderer's own (GFM, math).
   *
   * The same inversion `InPageAnchorProvider` makes for rendering, made for
   * PARSING: a surface that knows something about its content the renderer must
   * not learn — the chat knowing which `[N]` are its citations — supplies a
   * plugin instead of pre-rewriting the markdown it hands over. Memoize the
   * list, and keep its options' identity while they are equal: a new array
   * re-parses every block of the document, where a streamed step otherwise
   * parses only the block that grew. The renderer runs the plugins once per
   * top-level block (`markdown-blocks.ts`); a plugin that acts on the
   * document's END must check `documentContinues(file)`. Memoize the renderer a
   * caller hands `MarkdownSlotProvider` too: a new function re-renders every
   * slot in the answer. The slots are not remounted by it, because the overrides
   * read the renderer from context (`stable-overrides.spec.tsx`).
   */
  remarkPlugins?: PluggableList
}

/** Supported languages for syntax highlighting */
export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'json'
  | 'bash'
  | 'shell'
  | 'html'
  | 'css'
  | 'yaml'
  | 'markdown'
  | 'go'
  | 'rust'
