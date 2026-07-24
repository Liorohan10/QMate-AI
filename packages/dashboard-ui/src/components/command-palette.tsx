import { useState, useEffect, useRef, useCallback } from "react"
import { useNavigate } from "react-router"
import { Play, FileText, BarChart3, SlidersHorizontal, Search, BrainCircuit, LifeBuoy } from "lucide-react"
import {
  fetchMemoryCatalog,
  fetchRuns,
  fetchTestFiles,
  type MemoryCatalogProduct,
  type RunRow,
  type TestFileInfo,
} from "@/lib/api"
import { getConfigCommandLabel, searchConfigNavigationItems } from "@/lib/config-navigation"
import { routes } from "@/lib/routes"
import { useProductTour } from "@/components/product-tour"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"

const pages = [
  { title: "Runs", url: routes.runs, icon: Play },
  { title: "Tests", url: routes.tests, icon: FileText },
  { title: "Memory", url: routes.memory, icon: BrainCircuit },
  { title: "Insights", url: routes.insights, icon: BarChart3 },
  { title: "Config", url: routes.config, icon: SlidersHorizontal },
]

const createActions = [
  {
    title: "New Test",
    url: routes.testNew,
    icon: FileText,
    value: "create add new test tests yaml",
  },
]

interface SearchResults {
  runs: RunRow[]
  tests: TestFileInfo[]
  memoryProducts: MemoryCatalogProduct[]
}

function emptySearchResults(): SearchResults {
  return { runs: [], tests: [], memoryProducts: [] }
}

function summarizeTargetReferences(targetReferences: string[]) {
  const visibleReferences = targetReferences.slice(0, 3)
  const remainingCount = targetReferences.length - visibleReferences.length
  if (remainingCount <= 0) return visibleReferences.join(", ")
  return `${visibleReferences.join(", ")}, +${remainingCount} more`
}

function buildCommandValue(...values: Array<string | string[] | null | undefined>): string {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean)
    .join(" ")
}

function matchesCommandQuery(values: Array<string | null | undefined>, lowerQuery: string): boolean {
  return values.some((value) => value?.toLowerCase().includes(lowerQuery))
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResults>(() => emptySearchResults())
  const [isSearching, setIsSearching] = useState(false)
  const navigate = useNavigate()
  const { restartTour } = useProductTour()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestRef = useRef(0)
  const configResults = searchConfigNavigationItems(searchQuery)

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  const doSearch = useCallback(async (query: string, requestId: number) => {
    if (query.length < 2) {
      if (requestId === searchRequestRef.current) {
        setSearchResults(emptySearchResults())
        setIsSearching(false)
      }
      return
    }
    if (requestId === searchRequestRef.current) setIsSearching(true)
    try {
      const [runsData, testsData, memoryData] = await Promise.all([
        fetchRuns({ name: query, limit: 5 }),
        fetchTestFiles(),
        fetchMemoryCatalog().catch(() => ({ products: [] })),
      ])
      const lowerQuery = query.toLowerCase()
      const filteredTests = testsData.files
        .filter((test) => matchesCommandQuery([
          test.name,
          test.path,
          test.testId,
          test.targetName,
          test.platform,
        ], lowerQuery))
        .slice(0, 5)
      const filteredMemoryProducts = memoryData.products
        .filter((product) =>
          product.productKey.toLowerCase().includes(lowerQuery)
          || product.targetReferences.some((targetReference) => targetReference.toLowerCase().includes(lowerQuery)),
        )
        .slice(0, 5)
      if (requestId !== searchRequestRef.current) return
      setSearchResults({
        runs: runsData.runs,
        tests: filteredTests,
        memoryProducts: filteredMemoryProducts,
      })
    } catch {
      if (requestId === searchRequestRef.current) setSearchResults(emptySearchResults())
    } finally {
      if (requestId === searchRequestRef.current) setIsSearching(false)
    }
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    if (searchQuery.length < 2) {
      setSearchResults(emptySearchResults())
      setIsSearching(false)
      return
    }
    timerRef.current = setTimeout(() => doSearch(searchQuery, requestId), 200)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [searchQuery, doSearch])

  const closeAndReset = useCallback(() => {
    searchRequestRef.current += 1
    if (timerRef.current) clearTimeout(timerRef.current)
    setOpen(false)
    setSearchQuery("")
    setSearchResults(emptySearchResults())
    setIsSearching(false)
  }, [])

  function handleSelect(url: string) {
    navigate(url)
    closeAndReset()
  }

  function handleTakeProductTour() {
    restartTour()
    closeAndReset()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search runs, tests, memory, pages..."
      className="top-[18vh] translate-y-0"
    >
      <CommandInput
        placeholder="Search runs, tests, memory, pages..."
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList className="min-h-[320px]">
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Pages">
          {pages.map((page) => (
            <CommandItem
              key={page.url}
              value={`page-${page.title}`}
              onSelect={() => handleSelect(page.url)}
            >
              <page.icon />
              <span>{page.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Create">
          {createActions.map((action) => (
            <CommandItem
              key={action.url}
              value={action.value}
              onSelect={() => handleSelect(action.url)}
            >
              <action.icon />
              <span>{action.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Help">
          <CommandItem
            value="help take product tour onboarding QMate AI"
            data-tour-id="tour-command-product-tour"
            onSelect={handleTakeProductTour}
          >
            <LifeBuoy />
            <span>Take product tour</span>
          </CommandItem>
        </CommandGroup>

        {searchResults.runs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Runs">
              {searchResults.runs.map((run) => (
                <CommandItem
                  key={run.id}
                  value={`run-${run.id}-${run.name}`}
                  onSelect={() => handleSelect(routes.runDetail(run.id))}
                >
                  <Play />
                  <span className="truncate">{run.name}</span>
                  <span className={`ml-auto text-xs ${run.status === "passed" ? "text-green-500" : run.status === "failed" ? "text-red-500" : "text-muted-foreground"}`}>
                    {run.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searchResults.tests.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tests">
              {searchResults.tests.map((test) => (
                <CommandItem
                  key={test.path}
                  value={buildCommandValue("test", test.testId, test.name, test.path, test.targetName, test.platform)}
                  onSelect={() => handleSelect(routes.testView(test.testId ?? test.path))}
                >
                  <FileText />
                  <span className="min-w-0 flex-1 truncate" title={test.name || test.path}>
                    {test.name || test.path}
                  </span>
                  {test.path && test.path !== test.name ? (
                    <span className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground" title={test.path}>
                      {test.path}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searchResults.memoryProducts.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Memory">
              {searchResults.memoryProducts.map((product) => {
                const targetSummary = summarizeTargetReferences(product.targetReferences)
                return (
                  <CommandItem
                    key={product.productKey}
                    value={`memory-${product.productKey}-${product.targetReferences.join(" ")}`}
                    onSelect={() => handleSelect(routes.memoryProduct(product.productKey))}
                  >
                    <BrainCircuit />
                    <span className="truncate">{product.productKey}</span>
                    {targetSummary && (
                       <span
                         className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground"
                         title={product.targetReferences.join(", ")}
                       >
                         {targetSummary}
                       </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        )}

        {configResults.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Config">
              {configResults.map((item) => (
                <CommandItem
                  key={`${item.bucket}-${item.item}`}
                  value={buildCommandValue(
                    "config",
                    item.bucket,
                    item.bucketLabel,
                    item.item,
                    item.itemLabel,
                    item.title,
                    item.description,
                    item.aliases,
                    item.fieldPaths,
                    getConfigCommandLabel(item),
                  )}
                  onSelect={() => handleSelect(routes.configItem(item.bucket, item.item))}
                >
                  <SlidersHorizontal />
                  <span>{getConfigCommandLabel(item)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {isSearching && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <Search className="inline size-4 mr-1 animate-pulse" />
            Searching...
          </div>
        )}
      </CommandList>
    </CommandDialog>
  )
}
