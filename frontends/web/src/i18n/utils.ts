import { ui, defaultLang, showDefaultLang, languages, type Locale } from './ui'

export function getLangFromUrl(url: URL): Locale {
  const [, lang] = url.pathname.split('/')
  if (lang in languages) return lang as Locale
  return defaultLang
}

export function useTranslations(lang: Locale) {
  return ui[lang]
}

export function useTranslatedPath(lang: Locale) {
  return function translatePath(path: string, l: Locale = lang) {
    return !showDefaultLang && l === defaultLang ? path : `/${l}${path}`
  }
}

export function getPathWithoutLocale(pathname: string): string {
  return pathname.replace(/^\/en(?=\/|$)/, '') || '/'
}

export function getLocalizedPath(path: string, lang: Locale): string {
  return !showDefaultLang && lang === defaultLang ? path : `/${lang}${path}`
}
