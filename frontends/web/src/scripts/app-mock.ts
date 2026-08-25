/**
 * Makes the app mock answerable.
 *
 * Two interactions, both of them real ones from the product: picking a question
 * runs it, and touching a citation marker lights the source it belongs to. The
 * panel is fully rendered and readable before any of this attaches — with the
 * script blocked it is simply the first question and its answer, which is a
 * fair thing to be.
 */
export function initAppMock() {
  const root = document.querySelector<HTMLElement>('[data-app-mock]')
  if (!root) return

  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-turn-panel]'))
  const picks = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-turn-pick]'))

  const show = (index: string) => {
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.turnPanel !== index
    })
    picks.forEach((pick) => {
      pick.toggleAttribute('data-active', pick.dataset.turnPick === index)
    })
  }

  picks.forEach((pick) => {
    pick.addEventListener('click', () => show(pick.dataset.turnPick ?? '0'))
  })

  // A marker and its chip are the same fact in two places, which is exactly what
  // the product's citation model says: every [n] anchors to the document chip
  // that carries it. Lighting one from the other makes that legible in a glance
  // instead of asking the reader to match numbers.
  const light = (mark: string | undefined, on: boolean) => {
    if (!mark) return
    const [turn, n] = mark.split('-')
    root.querySelectorAll<HTMLElement>(`[data-source^="${turn}-"]`).forEach((chip) => {
      const carries = (chip.dataset.source ?? '').slice(turn.length + 1).split(',')
      if (carries.includes(n)) chip.toggleAttribute('data-lit', on)
    })
  }

  root.querySelectorAll<HTMLElement>('[data-mark]').forEach((el) => {
    const mark = el.dataset.mark
    const enter = () => light(mark, true)
    const leave = () => light(mark, false)
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    el.addEventListener('focus', enter)
    el.addEventListener('blur', leave)
    el.addEventListener('click', enter)
  })
}
