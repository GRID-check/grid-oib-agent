'use client'

import * as React from 'react'
import { GripVertical } from 'lucide-react'
import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps): React.JSX.Element {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  )
}

function ResizablePanel(props: ResizablePrimitive.PanelProps): React.JSX.Element {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}): React.JSX.Element {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'group/separator relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2',
        // The seam is a hairline at rest and stays one. It used to jump to
        // `foreground` — near-black, the heaviest line on the page — the moment
        // a pointer came near it. It warms on approach instead, and goes to
        // full ink only while it is actually being dragged, which is the one
        // moment the reader wants to see exactly where the edge is.
        'transition-colors duration-quick ease-out motion-reduce:transition-none',
        'hover:bg-foreground/40 active:bg-foreground/70 data-[separator=active]:bg-foreground/70',
        'focus-visible:outline-none',
        FOCUS_RING,
        'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2',
        '[&[aria-orientation=horizontal]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          // Shown when it is reached for, not always. A grip pill parked
          // half-way down a 1px line is a permanent artifact hanging in the
          // seam between two surfaces, and it sits PROUD of that line on both
          // sides — so it reads as debris in whichever pane the eye is in.
          // Hover, keyboard focus and the drag itself all bring it up, and the
          // cursor already makes the same promise on approach.
          className={cn(
            'z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-border bg-background text-foreground',
            'opacity-0 transition-opacity duration-quick ease-out motion-reduce:transition-none',
            'group-hover/separator:opacity-100 group-focus-visible/separator:opacity-100',
            'group-active/separator:opacity-100 group-data-[separator=active]/separator:opacity-100',
          )}
        >
          <GripVertical className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
