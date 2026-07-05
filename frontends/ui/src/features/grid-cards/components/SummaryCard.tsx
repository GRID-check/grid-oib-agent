import { type FC } from 'react'
import { Card } from '@/components/ui/card'
import type { SummaryCardData } from '../types'

export const SummaryCard: FC<SummaryCardData> = ({ title, content, key_points }) => {
  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 gap-2 p-5 shadow-xs">
      <p className="text-sm font-semibold text-foreground">{title}</p>

      {content && <p className="text-sm leading-relaxed text-muted-foreground">{content}</p>}

      {key_points && key_points.length > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {key_points.map((point, index) => (
            <li key={`${point}-${index}`} className="text-sm text-muted-foreground">
              {point}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
