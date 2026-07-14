// @vitest-environment jsdom

import { act, cloneElement, isValidElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sidebarMock = vi.hoisted(() => ({
  state: "expanded" as "expanded" | "collapsed",
  toggleSidebar: vi.fn(),
  fetchAppMetadata: vi.fn(),
  restartTour: vi.fn(),
}))

function icon(name: string) {
  return ({ className }: { className?: string }) => <svg data-icon={name} className={className} />
}

vi.mock("lucide-react", () => ({
  Play: icon("Play"),
  FileText: icon("FileText"),
  Webhook: icon("Webhook"),
  Wrench: icon("Wrench"),
  FolderOpen: icon("FolderOpen"),
  BrainCircuit: icon("BrainCircuit"),
  BarChart3: icon("BarChart3"),
  SlidersHorizontal: icon("SlidersHorizontal"),
  Sun: icon("Sun"),
  Moon: icon("Moon"),
  ChevronLeft: icon("ChevronLeft"),
  ChevronRight: icon("ChevronRight"),
  Bug: icon("Bug"),
  LifeBuoy: icon("LifeBuoy"),
}))

vi.mock("react-icons/fa", () => ({
  FaGithub: icon("Github"),
}))

vi.mock("@/components/icons/vostride-logo", () => ({
  VostrideLogo: ({ className }: { className?: string }) => <div data-testid="logo" className={className} />,
}))

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    theme: "light",
    setTheme: vi.fn(),
  }),
}))

vi.mock("@/components/product-tour", () => ({
  useProductTour: () => ({
    restartTour: sidebarMock.restartTour,
  }),
}))

vi.mock("@/lib/api", () => ({
  fetchAppMetadata: sidebarMock.fetchAppMetadata,
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => {
    if (asChild && isValidElement<{ "data-dropdown-trigger"?: string }>(children)) {
      return cloneElement(children, { "data-dropdown-trigger": "true" })
    }

    return <button type="button">{children}</button>
  },
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="help-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    asChild,
    onSelect,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    onSelect?: () => void
  } & React.HTMLAttributes<HTMLElement>) => {
    if (asChild && isValidElement<Record<string, unknown>>(children)) {
      return cloneElement(children, props)
    }

    return (
      <button type="button" onClick={() => onSelect?.()} {...props}>
        {children}
      </button>
    )
  },
}))

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarSeparator: ({
    className,
    style,
  }: {
    className?: string
    style?: React.CSSProperties
  }) => <hr data-testid="sidebar-separator" className={className} style={style} />,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    asChild,
    tooltip,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    tooltip?: string
  } & React.HTMLAttributes<HTMLElement>) => {
    if (asChild && isValidElement<{ "data-tooltip"?: string } & Record<string, unknown>>(children)) {
      return cloneElement(children, { "data-tooltip": tooltip, ...props })
    }

    return (
      <button type="button" data-tooltip={tooltip} {...props}>
        {children}
      </button>
    )
  },
  SidebarRail: () => null,
  useSidebar: () => ({
    state: sidebarMock.state,
    toggleSidebar: sidebarMock.toggleSidebar,
  }),
}))

import { AppSidebar } from "@/components/app-sidebar"

describe("AppSidebar", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    sidebarMock.state = "expanded"
    sidebarMock.toggleSidebar.mockReset()
    sidebarMock.fetchAppMetadata.mockReset()
    sidebarMock.restartTour.mockReset()
    sidebarMock.fetchAppMetadata.mockResolvedValue({ version: "0.1.18" })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderSidebar(path = "/runs") {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <AppSidebar />
        </MemoryRouter>,
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it("renders the Memory nav item with the BrainCircuit icon", async () => {
    await renderSidebar("/memory")

    const memoryLink = container.querySelector('a[href="/memory"]')
    expect(memoryLink).not.toBeNull()
    expect(memoryLink?.textContent).toContain("Memory")
    expect(memoryLink?.querySelector('[data-icon="BrainCircuit"]')).not.toBeNull()
  })

  it("adds approved product tour anchors to primary nav items only", async () => {
    await renderSidebar()

    const expectedAnchors = [
      { href: "/runs", title: "Runs", tourId: "tour-nav-runs" },
      { href: "/tests", title: "Tests", tourId: "tour-nav-tests" },
      { href: "/memory", title: "Memory", tourId: "tour-nav-memory" },
      { href: "/config", title: "Config", tourId: "tour-nav-config" },
    ]

    for (const { href, title, tourId } of expectedAnchors) {
      const navLink = Array.from(container.querySelectorAll(`a[href="${href}"]`)).find((link) =>
        link.textContent?.includes(title),
      )
      expect(navLink?.getAttribute("data-tour-id")).toBe(tourId)
    }

    expect(container.querySelector('a[href="/insights"]')?.getAttribute("data-tour-id")).toBeNull()
  })
})
