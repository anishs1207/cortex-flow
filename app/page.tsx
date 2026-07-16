"use client"

import React, { useState } from "react"
import {
  LayoutGrid,
  Workflow as WorkflowIcon,
  MessageSquare,
  Video,
  Settings,
  Zap,
  ChevronLeft,
  ChevronRight
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

// Import Machine Components
import CanvasChatBoard from "@/components/canvas/CanvasChat"
import { WorkflowBuilder } from "@/components/workflows"
import { ReactFlowProvider } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import ExplainerVideoGenerator from "../components/explainer-video/explainer-video-generator"
import { ChatSidebar, ChatContent, Sheets, SidebarRight } from "@/components/chat"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"

// Types
type MachineId = "canvas" | "workflow" | "chat" | "explainer"

interface Machine {
  id: MachineId
  name: string
  icon: React.ElementType
  description: string
  color: string
}

const machines: Machine[] = [
  {
    id: "canvas",
    name: "Canvas",
    icon: LayoutGrid,
    description: "Spatial Node-based Chat",
    color: "from-blue-500 to-cyan-500",
  },
  {
    id: "workflow",
    name: "Workflow",
    icon: WorkflowIcon,
    description: "Agentic AI Builder",
    color: "from-purple-500 to-pink-500",
  },
  {
    id: "chat",
    name: "Pipeline",
    icon: MessageSquare,
    description: "Lead Gen Spreadsheet",
    color: "from-emerald-500 to-teal-500",
  },
  {
    id: "explainer",
    name: "Explainer",
    icon: Video,
    description: "AI Video Generator",
    color: "from-orange-500 to-red-500",
  },
]

// Helper function for Chat machine
function createEmptyTable(rows = 1, columns = 7) {
  const table = []
  for (let r = 0; r < rows; r++) {
    const row = []
    for (let c = 0; c < columns; c++) {
      row.push({ value: "" })
    }
    table.push(row)
  }
  return table
}

export default function UnifiedMachine() {
  const [activeMachine, setActiveMachine] = useState<MachineId>("canvas")
  const [data, setData] = useState<Array<Array<{ value: string | number }>>>(createEmptyTable(20, 10))
  const [open, setOpen] = useState(true)
  const [toggleY, setToggleY] = useState(32) // Default top: 32px (top-8)
  const [isDragging, setIsDragging] = useState(false)

  // Handle Dragging
  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return
      setToggleY(Math.max(20, Math.min(window.innerHeight - 60, e.clientY - 18)))
    }
    const handleMouseUp = () => setIsDragging(false)

    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove)
      window.addEventListener("mouseup", handleMouseUp)
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isDragging])

  const renderMachineContent = () => {
    switch (activeMachine) {
      case "canvas":
        return <CanvasChatBoard />
      case "workflow":
        return (
          <ReactFlowProvider>
            <WorkflowBuilder />
          </ReactFlowProvider>
        )
      case "chat":
        return (
          <SidebarProvider>
            <ChatSidebar />
            <SidebarInset className="flex flex-col min-w-0 overflow-hidden h-screen">
              <div className="flex flex-row m-0">
                <ChatContent />
                <Sheets data={data} setData={setData} />
              </div>
            </SidebarInset>
            <SidebarRight data={data} setData={setData} />
          </SidebarProvider >
        )
      case "explainer":
        return (
          <div className="min-h-screen bg-background pt-8">
            <ExplainerVideoGenerator />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen w-screen overflow-hidden bg-background text-zinc-900 dark:text-zinc-100 font-sans selection:bg-indigo-500/30 transition-colors duration-300">

        {/* Premium Floating Toggle Button (Movable) */}
        <button
          onMouseDown={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onClick={(e) => {
            if (isDragging) e.stopPropagation()
            else setOpen(!open)
          }}
          style={{ top: `${toggleY}px` }}
          className={cn(
            "fixed cursor-grab z-[60] w-9 h-9 rounded-full flex items-center justify-center transition-all duration-700 ease-[cubic-bezier(0.23,1,0.32,1)]",
            isDragging && "cursor-grabbing scale-110 duration-75",
            "bg-white/10 dark:bg-zinc-900/10 hover:bg-white/20 dark:hover:bg-zinc-900/20 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-white/20 dark:border-white/5",
            "text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white",
            open ? "left-[84px] rotate-0" : "left-8 rotate-180"
          )}
        >
          <ChevronLeft className="w-4 h-4 pointer-events-none" />
        </button>

        {/* High-End Glass Sidebar */}
        <nav
          className={cn(
            "fixed top-0 left-0 h-screen z-50 flex flex-col items-center py-14 gap-14",
            "w-24 transition-all duration-700 ease-[cubic-bezier(0.23,1,0.32,1)]",
            // Advanced glass layer with vertical gradient and extreme blur
            "bg-gradient-to-b from-white/5 via-white/[0.02] to-white/5 dark:from-zinc-900/10 dark:via-transparent dark:to-zinc-900/10",
            "backdrop-blur-3xl border-r border-white/10 dark:border-white/5 shadow-[40px_0_100px_-20px_rgba(0,0,0,0.1)]",
            open ? "translate-x-0" : "-translate-x-full"
          )}
        >
          {/* Brand Mark with Glow */}
          {/* <div className="flex items-center justify-center mb-4">
            <div className="relative group">
              <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg blur opacity-25 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
              <div className="relative px-3 py-1 bg-white dark:bg-zinc-900 ring-1 ring-zinc-900/5 dark:ring-white/10 rounded-lg leading-none flex items-center justify-center">
                <span className="text-sm font-black tracking-tighter text-zinc-900 dark:text-white">
                  CORTEX<span className="text-blue-600">FLOW</span>
                </span>
              </div>
            </div>
          </div> */}

          <div className="flex-1 flex flex-col gap-10">
            {machines.map((machine) => {
              const Icon = machine.icon
              const isActive = activeMachine === machine.id

              return (
                <Tooltip key={machine.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setActiveMachine(machine.id)}
                      className={cn(
                        "group relative w-12 cursor-pointer h-12 flex items-center justify-center transition-all duration-500 ease-out",
                        isActive ? "scale-110" : "hover:scale-105"
                      )}
                    >
                      {/* Active Indicator Ring */}
                      <div className={cn(
                        "absolute inset-0 rounded-full border transition-all duration-700",
                        isActive
                          ? "border-zinc-900/5 dark:border-white/10 scale-125 opacity-100 bg-gradient-to-tr from-zinc-900/[0.03] to-transparent dark:from-white/5 dark:to-transparent"
                          : "border-transparent scale-50 opacity-0 group-hover:scale-110 group-hover:opacity-100 group-hover:border-zinc-900/5 dark:group-hover:border-white/5"
                      )} />

                      <Icon
                        className={cn(
                          "relative z-10 w-5 h-5 transition-all duration-500",
                          isActive
                            ? "text-zinc-900 dark:text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.3)]"
                            : "text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-900 dark:group-hover:text-zinc-300"
                        )}
                      />
                    </button>
                  </TooltipTrigger>

                  <TooltipContent
                    side="right"
                    sideOffset={24}
                    className="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-3xl border border-white/20 dark:border-white/10 text-zinc-900 dark:text-white px-5 py-3 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-left-2 duration-300"
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-bold text-sm tracking-tight">
                        {machine.name}
                      </span>
                      <span className="text-[10px] text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.15em] font-bold">
                        {machine.description}
                      </span>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </nav>

        {/* Main Content Area */}
        <main
          className={cn(
            "flex-1 relative flex flex-col overflow-y-auto transition-all duration-700 ease-[cubic-bezier(0.23,1,0.32,1)]",
            open ? "pl-24" : "pl-0"
          )}
        >
          <div className="flex-1 relative">
            <div className="w-full h-full relative z-10">
              {renderMachineContent()}
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider >
  )
}

