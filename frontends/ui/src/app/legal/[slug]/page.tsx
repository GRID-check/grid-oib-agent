/**
 * Legal document page — renders one legal document (`/legal/imprint`,
 * `/legal/privacy`, `/legal/terms`, `/legal/ai-transparency`,
 * `/legal/subprocessors`) in the visitor's locale.
 *
 * Public and unauthenticated by design: imprint and privacy information must
 * be reachable without signing in (ECG §5, DSGVO Art. 13).
 */

import { type ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLegalDocument, legalNavEntries } from '@/lib/legal'
import { isLegalSlug } from '@/lib/legal/types'
import { getLocale, getTranslations } from '@/i18n/server'

interface LegalPageProps {
  params: Promise<{ slug: string }>
}

const LegalPage = async ({ params }: LegalPageProps): Promise<ReactNode> => {
  const { slug } = await params
  if (!isLegalSlug(slug)) notFound()

  const locale = await getLocale()
  const t = await getTranslations('legal')
  const doc = getLegalDocument(locale, slug)

  return (
    <article>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{doc.title}</h1>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('updatedLabel')} {doc.updated}
      </p>
      {doc.intro ? (
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{doc.intro}</p>
      ) : null}

      {doc.sections.map((section, index) => (
        <section key={section.heading ?? index} className="mt-8">
          {section.heading ? (
            <h2 className="text-lg font-medium tracking-tight">{section.heading}</h2>
          ) : null}
          {section.paragraphs?.map((paragraph) => (
            <p key={paragraph} className="mt-3 text-sm leading-relaxed">
              {paragraph}
            </p>
          ))}
          {section.list ? (
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {section.table ? (
            <div className="mt-4 overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    {section.table.headers.map((header) => (
                      <th key={header} className="px-3 py-2 font-medium">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.table.rows.map((row) => (
                    <tr key={row.join('|')} className="border-b border-border last:border-b-0">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-2 align-top">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {section.notice ? (
            <p className="mt-4 rounded-md border border-border bg-muted/50 p-4 text-sm leading-relaxed">
              {section.notice}
            </p>
          ) : null}
        </section>
      ))}

      <nav aria-label={t('nav.otherDocuments')} className="mt-12 border-t border-border pt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('nav.otherDocuments')}
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {legalNavEntries(locale)
            .filter((entry) => entry.slug !== slug)
            .map((entry) => (
              <li key={entry.slug}>
                <Link
                  href={`/legal/${entry.slug}`}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {entry.title}
                </Link>
              </li>
            ))}
        </ul>
      </nav>
    </article>
  )
}

export default LegalPage
