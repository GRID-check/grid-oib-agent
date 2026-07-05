/**
 * /app index — the authenticated area has no standalone landing, so send
 * visitors straight to the project workspace.
 */

import { redirect } from 'next/navigation'

const AppIndexPage = (): never => {
  redirect('/app/projects')
}

export default AppIndexPage
