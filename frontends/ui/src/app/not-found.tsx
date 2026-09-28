import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { RisoPrint } from '@/components/brand/riso-print'
import { StatusScreen } from '@/components/brand/status-screen'
import { getTranslations } from '@/i18n/server'

export default async function NotFound() {
  const t = await getTranslations('errors')
  return (
    <StatusScreen
      // An empty plot with one column never given a house: "not in the plan".
      art={<RisoPrint id="vignetten/bauplatz/empty" />}
      code={t('notFound.code')}
      title={t('notFound.title')}
      description={t('notFound.description')}
      actions={
        <Button asChild>
          <Link href="/app/projects">{t('notFound.action')}</Link>
        </Button>
      }
    />
  )
}
