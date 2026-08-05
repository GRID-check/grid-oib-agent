/**
 * Sign-in link pending state.
 *
 * The link leaves this site for the app, which spends ~1s in server round
 * trips before the WorkOS login page paints — longer on mobile, where the app
 * is a fresh origin and the connection is cold. The browser keeps showing this
 * page for that whole stretch, so with no feedback the button reads as broken
 * and gets clicked again.
 *
 * The spinner is decorative. The global `prefers-reduced-motion` rule in
 * global.css freezes every animation with `!important`, so for those visitors
 * it renders as a static ring — the swapped label, not the spin, is what
 * carries the meaning.
 */
export function initSignIn() {
  const link = document.querySelector<HTMLAnchorElement>('[data-sign-in]')
  if (!link) return

  const label = link.querySelector<HTMLElement>('[data-sign-in-label]')
  const spinner = link.querySelector<HTMLElement>('[data-sign-in-spinner]')
  const icon = link.querySelector<HTMLElement>('[data-sign-in-icon]')
  const pendingLabel = link.dataset.signInPending
  if (!label || !spinner || !icon || !pendingLabel) return

  const idleLabel = label.textContent ?? ''

  const setPending = (pending: boolean) => {
    label.textContent = pending ? pendingLabel : idleLabel
    spinner.classList.toggle('hidden', !pending)
    // Below sm the icon is the only visible part, so the spinner has to take
    // its place rather than sit beside it — otherwise the row grows mid-click.
    icon.classList.toggle('hidden', pending)
    link.setAttribute('aria-busy', String(pending))
  }

  link.addEventListener('click', (event) => {
    // A modified click opens a new tab and leaves this page where it is —
    // showing "redirecting" on a page that is not going anywhere would lie.
    const opensElsewhere =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
    if (event.defaultPrevented || opensElsewhere) return
    setPending(true)
  })

  // Back/forward restores this page from the bfcache exactly as it was left,
  // spinner still running on a navigation that already finished.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) setPending(false)
  })
}
