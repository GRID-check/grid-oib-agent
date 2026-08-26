import * as React from 'react'

import { cn } from '@/lib/utils'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      data-slot="input"
      ref={ref}
      className={cn(
        // 16px WHERE A SOFT KEYBOARD IS, which is a pointer question and not a
        // width one. iOS Safari zooms the page in when a field under 16px takes
        // focus, and it does not zoom back out — so the floor has to hold
        // wherever that keyboard can appear.
        //
        // This was `text-base … md:text-sm`, which asks about the viewport, and
        // the viewport is the wrong axis twice over: a coarse-pointer TABLET
        // past `md` fell back to 14px and still zoomed (the case that got this
        // reviewed), while a narrow desktop WINDOW got phone-sized type it had
        // no use for. `text-sm` + `pointer-coarse:text-base` asks what is
        // driving the pointer, which is the same axis the touch sizes use.
        // 40px is under the 44px touch floor — see the Button size comment.
        'file:text-foreground placeholder:text-muted-foreground border-input flex h-10 w-full min-w-0 rounded-xl border bg-input-background px-3.5 py-1 text-sm transition-[color,box-shadow,border-color] duration-200 outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:text-base',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:ring-offset-0',
        'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        className
      )}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input }
