import type { PluggableList } from 'unified'

export interface MarkdownRendererProps {
  /** Markdown content to render */
  content: string
  /** Whether content is still streaming (affects rendering optimization) */
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
   * list; a new array identity re-parses the document.
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
