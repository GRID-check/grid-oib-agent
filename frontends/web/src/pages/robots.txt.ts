import type { APIRoute } from 'astro'

/**
 * robots.txt, built so the sitemap URL follows `site` (PUBLIC_SITE_URL).
 *
 * The AI crawlers get their own groups on purpose. A crawler that finds a
 * group naming it ignores the `*` group, so each one repeats the same
 * disallows; naming them says that being read and cited by answer engines is
 * wanted, and a later decision to block one is a one-line change here.
 */
const DISALLOW = ['/keystatic/', '/api/', '/sign-in']

const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
]

export const GET: APIRoute = ({ site }) => {
  const rules = DISALLOW.map((path) => `Disallow: ${path}`).join('\n')
  const groups = ['*', ...AI_CRAWLERS].map((agent) => `User-agent: ${agent}\nAllow: /\n${rules}`)
  const body = [
    '# Public pages are open to search engines and to AI answer engines alike.\n' +
      '# The editor (/keystatic), its API and the sign-in hand-off are not pages.',
    ...groups,
    `Sitemap: ${new URL('/sitemap-index.xml', site).href}`,
  ].join('\n\n')
  return new Response(`${body}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
