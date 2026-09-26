/*
 * Page changes as cross-document view transitions: which kind of change this
 * is, and which title flies from the card to the page.
 *
 * Inlined into <head> by BaseLayout (a classic, render-blocking script), not
 * bundled as a module: `pagereveal` fires at the new page's first rendering
 * opportunity, which is before any deferred module has run, so a listener
 * added from a module arrives after the event. The styles are in global.css
 * ("Page transitions"); the choice of native transitions over Astro's
 * ClientRouter is argued in docs/ux/motion.md.
 *
 * Browsers without cross-document view transitions (Firefox, as of writing)
 * never fire these events and simply navigate.
 */
;(() => {
  window.__pageSettled = Promise.resolve()
  if (!('onpagereveal' in window)) return

  const TITLE = 'post-title'
  const path = (url) => (url ? new URL(url).pathname : '')
  const isEn = (p) => p === '/en' || p === '/en/' || p.startsWith('/en/')
  const inBlog = (p) => /^\/(en\/)?blog\//.test(p)
  const isArticle = () => Boolean(document.querySelector('meta[property="og:type"][content="article"]'))

  /** The heading of the card on this page that links to `to`, if any. */
  const cardTitle = (to) => {
    if (!to) return null
    for (const a of document.querySelectorAll('main a[href]')) {
      if (a.getAttribute('href') === to) return a.querySelector('h2, h3')
    }
    return null
  }

  let named = []
  const name = (el) => {
    if (!el) return
    el.style.viewTransitionName = TITLE
    named.push(el)
  }
  const unname = () => {
    named.forEach((el) => (el.style.viewTransitionName = ''))
    named = []
  }

  /**
   * forward: a new sheet laid over the old one; back: the top sheet taken away;
   * lang: the same sheet in the other language, crossfaded in place.
   */
  const kindOf = (activation, from, to) => {
    if (isEn(from) !== isEn(to)) return 'lang'
    const back =
      activation.navigationType === 'traverse' &&
      activation.entry && activation.from &&
      activation.entry.index < activation.from.index
    return back ? 'back' : 'forward'
  }

  // The page being left.
  window.addEventListener('pageswap', (e) => {
    if (!e.viewTransition || !e.activation) return
    const from = location.pathname
    const to = path(e.activation.entry && e.activation.entry.url)
    const kind = kindOf(e.activation, from, to)
    e.viewTransition.types.add(kind)
    if (kind === 'lang') return
    const card = cardTitle(to)
    if (card) name(card)
    else if (isArticle() && inBlog(to)) name(document.querySelector('main h1'))
  })

  // The page arriving.
  window.addEventListener('pagereveal', (e) => {
    if (!e.viewTransition) return
    const act = window.navigation && navigation.activation
    if (!act) return
    const from = path(act.from && act.from.url)
    const to = location.pathname
    const kind = kindOf(act, from, to)
    e.viewTransition.types.add(kind)
    // Anything that plays on arrival (the ink pass) waits for the sheet to land.
    window.__pageSettled = e.viewTransition.finished.catch(() => {})
    e.viewTransition.finished.finally(unname)
    if (kind === 'lang') return
    if (isArticle() && inBlog(from)) name(document.querySelector('main h1'))
    else name(cardTitle(from))
  })

  // A page left for the bfcache keeps the names it was given on the way out;
  // two elements with one name on the next transition would cancel it.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) unname()
  })
})()
