'use client'

/**
 * The notification offer for people who never open the inbox (ADR-0112).
 *
 * The inbox makes the offer as a quiet card (`./notification-prompt`), which
 * reaches only people who go there. The person who needs a notification most is
 * the one who does not: so the shell makes the SAME offer once, as a toast, the
 * moment its badge goes from nothing to something waiting —
 * „Anna Weber hat Sie erwähnt. Möchten Sie auf diesem Gerät benachrichtigt
 * werden?“ [Einschalten] [Nicht jetzt].
 *
 * It is the prompt's offer, not a second one: due under the same rule
 * (`promptIsDue`), turned on by the same hook from the person's click, and
 * silenced by the same dismissal (`usePushPromptDismissal`). Made at most once
 * per browser session, so a person who lets it pass is asked again another day
 * rather than on every page.
 *
 * Renders nothing. Mounted once in the signed-in shell beside `PushLifecycle`,
 * only where the deployment sends notifications and the inbox is reachable.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import { toast } from 'sonner'

import { useTranslations } from '@/i18n'
import { inboxClient, type InboxClient } from '@/lib/inbox/client'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { usePushNotifications } from '../hooks/use-push-notifications'
import { promptIsDue, usePromptOnScreen, usePushPromptDismissal } from './notification-prompt'

const SHOWN_KEY = 'piloti.push-offer.shown'
const TOAST_ID = 'piloti-push-offer'
/** Long enough to read two sentences and decide; a toast, not a dialog. */
const OFFER_MS = 20_000

function shownThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SHOWN_KEY) === '1'
  } catch {
    return false
  }
}

function markShown(): void {
  try {
    window.sessionStorage.setItem(SHOWN_KEY, '1')
  } catch {
    // Blocked storage: the in-memory guard below still holds for this page.
  }
}

/** Who to name: the newest thing waiting on the person, if a person caused it. */
async function newestAsker(client: InboxClient): Promise<{ actor: string | null; mentioned: boolean }> {
  try {
    // A request, never an FYI: the sentence must not name someone who only replied.
    const page = await client.list({ filter: 'requests' })
    const newest = page.items[0]
    return { actor: newest?.actorName ?? null, mentioned: newest?.type === 'mention.requested' }
  } catch {
    return { actor: null, mentioned: false }
  }
}

export function InboxPushOffer({
  enabled,
  client = inboxClient,
}: {
  enabled: boolean
  client?: InboxClient
}): JSX.Element | null {
  const { pending } = useInboxBadge(enabled, client)
  const { dismissed } = usePushPromptDismissal()
  // The badge's last count. Starts at 0, so a first read that finds something
  // waiting is the step from nothing to something, as a later arrival is. The
  // step is remembered while something still waits, so a dismissal read a
  // moment later does not lose it.
  const previous = useRef(0)
  const rose = useRef(false)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (previous.current === 0 && pending > 0) rose.current = true
    if (pending === 0) rose.current = false
    previous.current = pending
    if (enabled && rose.current && !dismissed && !shownThisSession()) setArmed(true)
  }, [enabled, pending, dismissed])

  // The device's state is read only once there is something to offer: three
  // requests on every page for an offer made once would be the wrong price.
  return armed ? <OfferWhenDue client={client} /> : null
}

/** Reads this device, and makes the offer once if it is due. */
function OfferWhenDue({ client }: { client: InboxClient }): JSX.Element | null {
  const t = useTranslations('notifications')
  const push = usePushNotifications()
  const { dismissed, dismiss } = usePushPromptDismissal()
  const promptOnScreen = usePromptOnScreen()
  const offered = useRef(false)
  // The newest hook result, for the toast's buttons: the toast outlives the
  // render that made it.
  const latest = useRef({ push, dismiss })
  useEffect(() => {
    latest.current = { push, dismiss }
  }, [push, dismiss])

  // The inbox's own card is the offer while the inbox is open: the toast
  // stands down, and goes if it was already up.
  useEffect(() => {
    if (promptOnScreen) toast.dismiss(TOAST_ID)
  }, [promptOnScreen])

  useEffect(() => {
    if (offered.current || !promptIsDue(push, dismissed) || shownThisSession()) return
    if (promptOnScreen) {
      offered.current = true
      markShown()
      return
    }
    offered.current = true
    markShown()
    void newestAsker(client).then(({ actor, mentioned }) => {
      const message = actor
        ? t(mentioned ? 'offer.mentioned' : 'offer.actor', { actor })
        : t('offer.someone')
      toast(message, {
        id: TOAST_ID,
        duration: OFFER_MS,
        action: { label: t('offer.turnOn'), onClick: () => void latest.current.push.enable() },
        cancel: { label: t('offer.notNow'), onClick: () => latest.current.dismiss() },
      })
    })
  }, [push, dismissed, promptOnScreen, client, t])

  return null
}
