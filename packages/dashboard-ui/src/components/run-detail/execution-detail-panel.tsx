import { Terminal, Shield, Cpu, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn, formatDuration } from "@/lib/utils"
import type { ExecutionLogEntry } from "@/lib/api"

interface ExecutionDetailPanelProps {
  log: ExecutionLogEntry
}

export function ExecutionDetailPanel({ log }: ExecutionDetailPanelProps) {
  const hasOutputs = Boolean(log.stdout || log.stderr)

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Terminal className="h-4.5 w-4.5 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate leading-none mb-1">
              {log.name}
            </h3>
            <p className="text-[11px] text-muted-foreground font-mono truncate">
              ID: {log.id}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted-foreground">
            {formatDuration(log.duration)}
          </span>
          <Badge
            className={cn(
              log.status === "passed"
                ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                : log.status === "running"
                  ? "bg-blue-500/10 text-blue-500 border-blue-500/20 animate-pulse"
                  : "bg-destructive/10 text-destructive border-destructive/20"
            )}
            variant="outline"
          >
            {log.status === "passed" ? (
              <CheckCircle2 className="mr-1 h-3 w-3 shrink-0" />
            ) : log.status === "running" ? (
              <RefreshCw className="mr-1 h-3 w-3 shrink-0 animate-spin" />
            ) : (
              <AlertTriangle className="mr-1 h-3 w-3 shrink-0" />
            )}
            {log.status}
          </Badge>
        </div>
      </div>

      {/* Main Content */}
      <ScrollArea className="flex-1">
        <div className="space-y-6 p-4">
          {/* Metadata Section */}
          <div className="grid grid-cols-2 gap-4 rounded-lg border bg-card/40 p-4">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Execution Type
              </span>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                <Cpu className="h-4 w-4 text-primary shrink-0" />
                <span className="capitalize">{log.type}</span>
              </div>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Phase
              </span>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                <Shield className="h-4 w-4 text-primary shrink-0" />
                <span className="capitalize">{log.phase}</span>
              </div>
            </div>
          </div>

          {/* Captured Variables */}
          {log.variables && Object.keys(log.variables).length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Captured Variables
              </h4>
              <div className="rounded-md border bg-muted/15 font-mono text-xs divide-y">
                {Object.entries(log.variables).map(([key, val]) => (
                  <div key={key} className="flex p-2.5">
                    <span className="font-semibold text-primary w-1/3 truncate pr-2">
                      {key}
                    </span>
                    <span className="text-muted-foreground flex-1 break-all select-all">
                      {val}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Return Data */}
          {log.returnData !== undefined && log.returnData !== null && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Return Value
              </h4>
              <pre className="rounded-md border bg-muted/30 p-3 font-mono text-xs overflow-x-auto text-foreground/90">
                {typeof log.returnData === "object"
                  ? JSON.stringify(log.returnData, null, 2)
                  : String(log.returnData)}
              </pre>
            </div>
          )}

          {/* Console / Outputs */}
          {hasOutputs ? (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Console Output
              </h4>

              {log.stdout && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground/60 uppercase">
                    stdout
                  </div>
                  <pre className="rounded-md border border-border/80 bg-neutral-950 dark:bg-neutral-900/60 p-3 font-mono text-xs overflow-x-auto text-neutral-200 leading-relaxed shadow-inner">
                    {log.stdout}
                  </pre>
                </div>
              )}

              {log.stderr && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium text-destructive/70 uppercase">
                    stderr
                  </div>
                  <pre className="rounded-md border border-destructive/20 bg-destructive/5 p-3 font-mono text-xs overflow-x-auto text-destructive dark:text-red-400 leading-relaxed">
                    {log.stderr}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed rounded-lg bg-muted/10">
              <Terminal className="h-6 w-6 text-muted-foreground/45 mb-2" />
              <p className="text-xs text-muted-foreground">
                No logs recorded for this execution
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
