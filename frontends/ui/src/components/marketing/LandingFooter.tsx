/**
 * LandingFooter — a minimal, quiet footer: brand mark, a one-line description,
 * and the domain sources Grid is grounded in, under a hairline top border.
 */

import { type FC } from 'react'
import { Logo } from '@/components/brand/logo'

export const LandingFooter: FC = () => {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-12 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex flex-col gap-2">
          <Logo kind="horizontal" size="small" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Building-compliance answers for Austrian architects, grounded in the code.
          </p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Sources: OIB-Richtlinien &middot; RIS &middot; your project documents
        </p>
      </div>
    </footer>
  )
}
