/**
 * The shapes the project mail inbox passes between its stages: the sender
 * verdict (`./sender-auth`), the parsed and selected mail (`./mime`), and the
 * skip reasons the notification reports.
 *
 * Types only, so every stage and its specs can import them without pulling in
 * a parser or a resolver.
 */

/**
 * Whether the mail provably comes from its From address.
 *
 * `temperror` is not a refusal: DNS or the verifier could not decide, so the
 * webhook answers 503 and the sending server retries. Only `fail` refuses.
 */
export type SenderVerdict =
  | { verdict: 'pass'; fromAddress: string; fromName: string | null }
  | { verdict: 'fail'; reason: string }
  | { verdict: 'temperror'; reason: string }

/**
 * Why a part of the mail was not filed. The first eight come from selection
 * (`./mime`); `type`, `size` and `quota` from filing (`uploadDocument`).
 */
export type SkipReason =
  | 'embedded'
  | 'tnef'
  | 'signature'
  | 'encrypted'
  | 'calendar'
  | 'empty'
  | 'unknown-type'
  | 'limit'
  | 'type'
  | 'size'
  | 'quota'

export interface SelectedAttachment {
  filename: string
  contentType: string
  content: Uint8Array
  /** Hex sha256 of `content`. */
  sha256: string
}

export interface ParsedMail {
  messageId: string | null
  /** Reply and forward prefixes stripped, cut by grapheme to 120. */
  subject: string | null
  fromName: string | null
  attachments: SelectedAttachment[]
  skipped: { filename: string; reason: SkipReason }[]
}
