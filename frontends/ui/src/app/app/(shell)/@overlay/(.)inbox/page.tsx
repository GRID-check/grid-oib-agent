/**
 * The Postfach, intercepted: a soft navigation to `/app/inbox` renders the
 * sheet here, above whatever page the reader was on, while the URL is the
 * inbox's own. A hard load takes the real page instead (`../../inbox`).
 */
import type { JSX } from 'react'
import { InboxSheet } from '../../inbox/inbox-sheet'

export default function InboxOverlayPage(): JSX.Element {
  return <InboxSheet standalone={false} />
}
