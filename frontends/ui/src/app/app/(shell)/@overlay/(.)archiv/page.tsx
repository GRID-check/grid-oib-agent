/**
 * The Archiv, intercepted: a soft navigation to `/app/archiv` renders the
 * sheet here, above whatever page the reader was on, while the URL is the
 * Archiv's own. A hard load takes the real page instead (`../../archiv`),
 * which renders the same sheet standing alone.
 */
import { ArchivSheet } from '../../archiv/archiv-sheet'

export default function ArchivOverlayPage(): JSX.Element {
  return <ArchivSheet standalone={false} />
}
