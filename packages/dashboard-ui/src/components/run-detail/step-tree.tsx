import { useMemo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { StepTreeItem } from "./step-tree-item"
import type { ExecutionLogEntry } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import { hasStepId, type Selection } from "@/lib/selection"

interface StepTreeProps {
  steps: DisplayStep[]
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
  inlineLogs?: ExecutionLogEntry[]
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {title}
    </div>
  )
}

export function StepTree({
  steps,
  selection,
  onSelect,
  inlineLogs = []
}: StepTreeProps) {
  const logsByStep = useMemo(() => {
    const map = new Map<string, ExecutionLogEntry[]>()
    for (const log of inlineLogs) {
      if (!log.stepId) continue
      const stepOrder = Number(log.stepId)
      const stepAtIndex = steps.find((step) => {
        if (step.rawRunId && log.runId && step.rawRunId !== log.runId) return false
        return step.rawStepOrder === stepOrder
      })
      const key = stepAtIndex?.id ?? log.stepId
      const existing = map.get(key) ?? []
      existing.push(log)
      map.set(key, existing)
    }
    return map
  }, [inlineLogs, steps])

  if (steps.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No steps were executed.
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div>
        <SectionHeading title="Steps" />
        <ul role="tree" aria-label="Test steps" className="py-1">
          {steps.map((step) => (
            <StepTreeItem
              key={step.id}
              step={step}
              isSelected={hasStepId(selection) && selection.stepId === step.id}
              isExpanded={true}
              selection={selection}
              onSelect={onSelect}
              inlineLogs={logsByStep.get(step.id) ?? []}
            />
          ))}
        </ul>
      </div>
    </ScrollArea>
  )
}
