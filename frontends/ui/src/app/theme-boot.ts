/**
 * Theme boot: the dark/light decision made BEFORE the first paint.
 *
 * The theme is a client-only fact (a persisted choice in localStorage, or the
 * OS preference), so the server renders without `.dark`. Applied from a React
 * effect, that meant every dark-mode load painted the light paper first and
 * flipped to charcoal once the bundle had hydrated — about 700ms of white in
 * dev, a visible flash on any slow phone. The script below runs synchronously
 * while the browser parses `<head>`, so the very first frame is already in the
 * right theme. `providers.tsx` keeps owning the theme after that (toggles, the
 * OS flipping, the server-side preference arriving) and re-applies it in a
 * layout effect, because React's dev remount resets `<html>`'s attributes.
 *
 * The script reads the layout store's persist entry directly. It cannot import
 * the store (it runs before any bundle), so the key and the shape
 * (`{ state: { theme } }`, zustand's persist envelope) are restated here;
 * `theme-boot.spec.ts` writes through the real store and runs this script, so a
 * renamed key or a changed envelope fails a spec instead of bringing the flash
 * back silently.
 */

/** The zustand `persist` name of the layout store (`features/layout/store.ts`). */
export const LAYOUT_STORE_KEY = 'grid-layout'

/**
 * The browser-chrome colour per theme: `--background` in `styles/tokens.css`
 * (`#f6f6f4` warm paper, `#191816` warm charcoal). Restated as hex because a
 * `<meta name="theme-color">` is read by the browser UI, not by our CSS, so it
 * cannot resolve a custom property. Retune both together.
 */
export const THEME_COLOR = { light: '#f6f6f4', dark: '#191816' } as const

/**
 * Plain ES5 on purpose: it is shipped as a string and runs before any
 * polyfill or bundle. Every read is guarded — private windows throw on
 * localStorage access, and a corrupt entry must fall back to the OS
 * preference, never break the page. Same rule as `useThemeEffect` in
 * providers.tsx: anything that is not an explicit 'light' or 'dark' is
 * 'system', which follows the OS.
 */
export const THEME_BOOT_SCRIPT = `(function(){var t;try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(
  LAYOUT_STORE_KEY
)})||"null");t=s&&s.state&&s.state.theme}catch(e){}var dark=t==="dark"||(t!=="light"&&!!window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",dark)})()`
