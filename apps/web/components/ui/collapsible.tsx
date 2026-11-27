"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

import { cn } from "@/lib/utils"

/**
 * A disclosure: a trigger that shows or hides a panel. The trigger is a
 * button with `aria-expanded` (and `aria-controls` while open), so Enter and
 * Space toggle it; open it from code with the root's `open`.
 */
function Collapsible(props: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  className,
  ...props
}: Omit<CollapsiblePrimitive.Trigger.Props, "className"> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn("cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60", className)}
      {...props}
    />
  )
}

/**
 * The panel eases its height and opacity from where they are, so a toggle
 * mid-way reverses without a jump; under reduced motion it shows and hides
 * at once (globals.css). Closed, it stays in the page as
 * `hidden="until-found"`: what is inside keeps its state, the browser's find
 * opens it, and a field in it can be found to be revealed. `overflow: clip`
 * (not `hidden`) keeps sticky content inside it sticking to the page, and
 * the clip margin keeps a child's shadow and focus ring.
 */
function CollapsiblePanel({
  className,
  hiddenUntilFound = true,
  ...props
}: Omit<CollapsiblePrimitive.Panel.Props, "className"> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      hiddenUntilFound={hiddenUntilFound}
      className={cn(
        "h-(--collapsible-panel-height) overflow-clip [overflow-clip-margin:0.5rem]",
        "transition-[height,opacity] duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)]",
        "data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 data-ending-style:duration-[180ms]",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
