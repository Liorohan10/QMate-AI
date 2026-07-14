import { useRef, useCallback, useMemo } from 'react'
import { AlertCircle, Plus, Info } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StepCardEditor } from '@/components/step-card-editor'
import type { StepCardLiveStatus } from '@/components/step-card-editor'
import type { EditorStep } from '@/hooks/use-live-editor'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'
import type { Selection } from '@/lib/selection'
import { TestMetadataForm } from '@/components/test-metadata-form'
import {
  yamlToFormState,
  updateYamlField,
  updateYamlStep,
  updateYamlStepOverride,
  deleteYamlStep,
  addYamlStep,
  reorderYamlList,
  type TestFormState,
} from '@/lib/test-yaml-serializer'

interface VisualBuilderProps {
  content: string
  onChange: (yaml: string) => void
  isCreateMode?: boolean
  disabled?: boolean
  showLiveStepActions?: boolean
  canRunLiveStep?: boolean
  liveEditorSteps?: EditorStep[]
  draftStepIds?: string[]
  onRunLiveStep?: (index: number) => void
  onCancelLiveStep?: (index: number) => void
  openStepSettingsId?: string | null
  onOpenStepSettingsChange?: (stepId: string | null) => void
  selection?: Selection | null
  onSelect?: (selection: Selection | null) => void
  variableSuggestions?: VariableSuggestion[]
}

export function VisualBuilder({
  content,
  onChange,
  isCreateMode,
  disabled = false,
  showLiveStepActions = false,
  canRunLiveStep = false,
  liveEditorSteps,
  draftStepIds,
  onRunLiveStep,
  onCancelLiveStep,
  openStepSettingsId,
  onOpenStepSettingsChange,
  selection,
  onSelect,
  variableSuggestions,
}: VisualBuilderProps) {
  const lastValidRef = useRef<TestFormState | null>(null)

  const formState = yamlToFormState(content)
  const yamlError = formState === null
  const display = formState ?? lastValidRef.current

  if (formState) {
    lastValidRef.current = formState
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleMetadataChange = useCallback(
    (field: string, value: string | string[]) => {
      const newYaml = updateYamlField(content, [field], value)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleStepChange = useCallback(
    (index: number, newValue: string) => {
      const newYaml = updateYamlStep(content, index, newValue)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleStepOverrideChange = useCallback(
    (index: number, field: string, value: unknown) => {
      const newYaml = updateYamlStepOverride(content, index, field, value)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleStepDelete = useCallback(
    (index: number) => {
      const newYaml = deleteYamlStep(content, index)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleAddStep = useCallback(() => {
    const newYaml = addYamlStep(content)
    onChange(newYaml)
  }, [content, onChange])

  const stepIds = useMemo(
    () => display?.steps.map((_, i) =>
      draftStepIds?.[i]
      ?? liveEditorSteps?.[i]?.id
      ?? `draft-step-${i}`,
    ) ?? [],
    [display?.steps, draftStepIds, liveEditorSteps],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (disabled || yamlError) return
      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = stepIds.indexOf(String(active.id))
      const newIndex = stepIds.indexOf(String(over.id))

      if (oldIndex === -1 || newIndex === -1) return

      const reorderedYaml = reorderYamlList(content, 'steps', oldIndex, newIndex)
      if (reorderedYaml !== content) {
        onChange(reorderedYaml)
      }
    },
    [content, disabled, onChange, stepIds, yamlError],
  )

  return (
    <div className="flex flex-col">
      <div className="space-y-4 p-4">
        {yamlError && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span>YAML has errors — builder shows last valid state</span>
          </div>
        )}

        {display ? (
          <>
            <TestMetadataForm
              name={display.name}
              testId={display.testId}
              target={display.target}
              context={display.context}
              isCreateMode={isCreateMode ?? false}
              onChange={handleMetadataChange}
              disabled={disabled || yamlError}
            />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Steps
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[250px] text-[13px]">
                      Plain-English instructions the AI agent executes in order. Each step is interpreted and acted upon independently.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  {display.steps.length} {display.steps.length === 1 ? 'step' : 'steps'}
                </span>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={stepIds}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {display.steps.map((step, i) => (
                      (() => {
                        const liveStep = liveEditorSteps?.[i]
                        const stepId = stepIds[i] ?? liveStep?.id ?? `draft-step-${i}`
                        const selectedSubActionIndex = selection?.type === 'subaction' && selection.stepId === stepId
                          ? selection.subIndex
                          : null
                        const isSelected = selection?.type === 'step'
                          ? selection.stepId === stepId
                          : selection?.type === 'subaction'
                            ? selection.stepId === stepId
                            : false
                        const liveStatus: StepCardLiveStatus = liveStep?.status ?? 'idle'

                        return (
                          <StepCardEditor
                            key={stepId}
                            id={stepId}
                            index={i}
                            value={step.text}
                            overrides={step.overrides}
                            onChange={handleStepChange}
                            onOverrideChange={handleStepOverrideChange}
                            onDelete={handleStepDelete}
                            disabled={disabled || yamlError}
                            liveStatus={liveStatus}
                            showLiveControls={showLiveStepActions}
                            canRunLiveStep={canRunLiveStep && !!step.text.trim()}
                            onRunLiveStep={onRunLiveStep}
                            onCancelLiveStep={onCancelLiveStep}
                            stepError={liveStep?.error}
                            isSettingsOpen={openStepSettingsId === stepId}
                            onToggleSettings={(nextStepId) =>
                                onOpenStepSettingsChange?.(
                                  openStepSettingsId === nextStepId ? null : nextStepId,
                                )
                            }
                            isSelected={isSelected}
                            onSelectStep={(selectedStepId) => onSelect?.({ type: 'step', stepId: selectedStepId })}
                            subActions={liveStep?.subActionsData ?? null}
                            selectedSubActionIndex={selectedSubActionIndex}
                            onSelectSubAction={(selectedStepId, subIndex) =>
                              onSelect?.({ type: 'subaction', stepId: selectedStepId, subIndex })
                            }
                            suggestions={variableSuggestions}
                          />
                        )
                      })()
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={handleAddStep}
                disabled={disabled || yamlError}
              >
                <Plus className="size-3.5" />
                Add Step
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            Enter valid YAML to use the visual builder
          </div>
        )}
      </div>
    </div>
  )
}
