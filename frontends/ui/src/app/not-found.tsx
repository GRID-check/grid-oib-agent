import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { StatusScreen } from '@/components/brand/status-screen'

export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      title="We couldn't find that"
      description="The page or project you're looking for doesn't exist, or you no longer have access to it."
      actions={
        <Button asChild>
          <Link href="/app/projects">Back to projects</Link>
        </Button>
      }
    />
  )
}
