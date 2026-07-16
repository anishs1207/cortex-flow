"use client"

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { v4 as uuidv4 } from "uuid"
import { Button } from "@/components/ui/button"
import {
    PromptInput,
    PromptInputTextarea,
    PromptInputActions,
} from "@/components/ui/prompt-input"
import {
    Plus,
    ArrowUp,
    GripHorizontal,
    MousePointer2,
    X,
    LocateFixed,
    Combine,
    BrainCircuit,
    Layers,
    CheckCircle2,
    Split,
    LayoutTemplate,
    StickyNote,
    Undo2,
    Redo2,
    Search,
    Type,
    Copy,
    Check,
    Lock,
    Unlock,
    Download,
    MessageSquare
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Markdown } from "@/components/ui/markdown"
import { Textarea } from "@/components/ui/textarea"
import ModeToggle from "../chat/ModeToggle"

/* ---------------- DOMAIN TYPES ---------------- */

type Role = "user" | "assistant"

interface ChatMessage {
    id: string
    role: Role
    content: string
    modelName?: string // For multi-model responses
    isWinner?: boolean // For panel voting
    voteCount?: number // For panel voting
}

type NodeVariant = "standard" | "multi-model" | "panel-vote" | "note"

interface ChatNode {
    id: string
    variant: NodeVariant
    parents: string[]
    position: { x: number; y: number }
    messages: {
        id: string
        role: "user"
        content: string
    }[] // User input is single stream
    responses: {
        id: string
        modelResponses: ChatMessage[] // Array for multi-model/vote
    }[]
    width: number
    height: number
    activeModelIndex: number // For paging or highlighting
    noteText?: string // For note variants
}

/* ---------------- CONSTANTS ---------------- */

const NODE_WIDTH_STANDARD = 400
const NODE_WIDTH_MULTI = 800 // Wider for side-by-side
const DEFAULT_NODE_HEIGHT = 500
const MINI_MAP_SIZE = 150

const AVAILABLE_MODELS = [
    { id: "gemma-3-27b", name: "Gemma 3 27B", color: "bg-blue-500/10 border-blue-500/50" },
    { id: "gpt-4o", name: "GPT-4o", color: "bg-green-500/10 border-green-500/50" },
    { id: "claude-3.5", name: "Claude 3.5", color: "bg-orange-500/10 border-orange-500/50" },
    { id: "deepseek", name: "DeepSeek", color: "bg-purple-500/10 border-purple-500/50" },
    { id: "llama-3", name: "Llama 3", color: "bg-indigo-500/10 border-indigo-500/50" },
]

/* ---------------- UTILS ---------------- */

function generateId() {
    return uuidv4()
}

/* ---------------- COMPONENTS ---------------- */

// 1. MINI MAP 
function MiniMap({ nodes, camera, onNavigate }: { nodes: ChatNode[], camera: { x: number, y: number, scale: number }, onNavigate: (_x: number, _y: number) => void }) {
    // Safe window dimensions for SSR
    const [windowSize, setWindowSize] = useState({ w: 1200, h: 800 })
    useEffect(() => {
        const update = () => setWindowSize({ w: window.innerWidth, h: window.innerHeight })
        update()
        window.addEventListener("resize", update)
        return () => window.removeEventListener("resize", update)
    }, [])

    // Calculate bounding box
    const bounds = useMemo(() => {
        if (nodes.length === 0) return { minX: 0, maxX: 1000, minY: 0, maxY: 1000 }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        nodes.forEach(n => {
            minX = Math.min(minX, n.position.x)
            maxX = Math.max(maxX, n.position.x + n.width)
            minY = Math.min(minY, n.position.y)
            maxY = Math.max(maxY, n.position.y + n.height)
        })
        return {
            minX: minX - 500,
            maxX: maxX + 500,
            minY: minY - 500,
            maxY: maxY + 500
        }
    }, [nodes])

    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    const scale = Math.min(MINI_MAP_SIZE / width, MINI_MAP_SIZE / height)

    return (
        <div className="absolute bottom-4 right-4 bg-background/90 border rounded-lg shadow-xl p-2 z-50 overflow-hidden"
            style={{ width: MINI_MAP_SIZE, height: MINI_MAP_SIZE }}>
            <div className="relative w-full h-full bg-muted/20 rounded cursor-pointer"
                onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const clickX = e.clientX - rect.left
                    const clickY = e.clientY - rect.top
                    // Convert back to canvas space
                    const targetX = bounds.minX + (clickX / scale)
                    const targetY = bounds.minY + (clickY / scale)
                    onNavigate(-targetX + windowSize.w / 2, -targetY + windowSize.h / 2)
                }}
            >
                {nodes.map(node => (
                    <div
                        key={node.id}
                        className="absolute bg-primary/40 rounded-sm"
                        style={{
                            left: (node.position.x - bounds.minX) * scale,
                            top: (node.position.y - bounds.minY) * scale,
                            width: node.width * scale,
                            height: node.height * scale
                        }}
                    />
                ))}
                {/* Viewport Indicator */}
                <div
                    className="absolute border-2 border-red-500 rounded-sm pointer-events-none"
                    style={{
                        left: (-camera.x - bounds.minX) * scale, // approximate inverse
                        top: (-camera.y - bounds.minY) * scale,
                        width: (windowSize.w / camera.scale) * scale,
                        height: (windowSize.h / camera.scale) * scale
                    }}
                />
            </div>
        </div>
    )
}

// 2. TEXT SELECTION TOOLTIP
function SelectionTooltip({ position, onBranch }: { position: { x: number, y: number } | null, onBranch: () => void }) {
    if (!position) return null
    return (
        <div
            className="fixed z-[100] bg-foreground text-background text-xs px-2 py-1 rounded shadow-lg flex items-center gap-2 cursor-pointer hover:bg-foreground/90 transition-all animate-in fade-in zoom-in duration-200"
            style={{ left: position.x, top: position.y - 40 }}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onBranch() }}
        >
            <Split className="w-3 h-3" /> Branch Selection
        </div>
    )
}

// 3. NODE CARD
interface ChatNodeCardProps {
    node: ChatNode
    scale: number
    isSelected: boolean
    onSend: (_nodeId: string, _text: string) => void
    onBranch: (_nodeId: string) => void
    onBranchFromText: (_nodeId: string, _text: string) => void
    onDelete: (_nodeId: string) => void
    onStartDrag: (_e: React.MouseEvent, _nodeId: string) => void
    onSelect: (_nodeId: string) => void
    onResize: (_nodeId: string, _height: number) => void
    onMerge: (_nodeId: string) => void
    onUpdateNode: (_nodeId: string, _updates: Partial<ChatNode>) => void
    onBranchToNote: (_nodeId: string, _content: string) => void
    searchQuery?: string
}

function ChatNodeCard({
    node,
    scale,
    isSelected,
    onSend,
    onBranch,
    onBranchFromText,
    onDelete,
    onStartDrag,
    onSelect,
    onResize,
    onMerge,
    onUpdateNode,
    onBranchToNote,
    searchQuery = ""
}: ChatNodeCardProps) {
    const [input, setInput] = useState("")
    const [selectionPos, setSelectionPos] = useState<{ x: number, y: number } | null>(null)
    const [selectedText, setSelectedText] = useState("")
    const [isEditingNote, setIsEditingNote] = useState(true)
    const [isCopied, setIsCopied] = useState(false)
    const scrollRef = useRef<HTMLDivElement>(null)

    // Auto-scroll logic
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [node.messages, node.responses])

    const handleSubmit = () => {
        if (!input.trim()) return
        onSend(node.id, input)
        setInput("")
    }

    // Text Selection Logic
    const handleMouseUp = () => {
        const selection = window.getSelection()
        if (selection && selection.toString().length > 3) {
            const range = selection.getRangeAt(0)
            const rect = range.getBoundingClientRect()
            setSelectionPos({ x: rect.left + rect.width / 2, y: rect.top })
            setSelectedText(selection.toString())
        } else {
            setSelectionPos(null)
            setSelectedText("")
        }
    }

    // Resizing Logic
    const handleResizeMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation() // Stop panning
        const startY = e.clientY
        const startH = node.height

        const onMouseMove = (ev: MouseEvent) => {
            const newH = Math.max(300, startH + (ev.clientY - startY) / scale)
            onResize(node.id, newH)
        }

        const onMouseUp = () => {
            window.removeEventListener("mousemove", onMouseMove)
            window.removeEventListener("mouseup", onMouseUp)
        }

        window.addEventListener("mousemove", onMouseMove)
        window.addEventListener("mouseup", onMouseUp)
    }

    // Render logic per variant
    const renderResponses = () => {
        // We interleave messages and response blocks
        // Ideally we map messages, and for each message check if there's a corresponding response block
        // For simplicity, let's assume strict pair order for this demo: User Msg -> Response Block

        return node.messages.map((msg, idx) => {
            const responseBlock = node.responses[idx]

            return (
                <div key={msg.id} className="space-y-4 mb-6">
                    {/* USER MSG */}
                    <div className="flex justify-end">
                        <div className="bg-primary text-primary-foreground px-3 py-2 rounded-lg text-sm max-w-[90%] shadow-sm">
                            {msg.content}
                        </div>
                    </div>

                    {/* RESPONSE BLOCK */}
                    {responseBlock && (
                        <div className={cn(
                            "w-full",
                            node.variant === "multi-model" && "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2",
                            node.variant === "panel-vote" && "grid grid-cols-1 gap-4"
                        )}>
                            {responseBlock.modelResponses.map((res, rIdx) => (
                                <div
                                    key={rIdx}
                                    className={cn(
                                        "rounded-lg p-3 text-sm border relative group",
                                        node.variant === "panel-vote" && res.isWinner && "ring-2 ring-green-500 bg-green-500/10"
                                    )}
                                >
                                    <div className="flex items-center justify-between mb-2 border-b pb-1 opacity-70">
                                        <span className="text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                                            {node.variant === "panel-vote" ? <BrainCircuit size={12} /> : <Layers size={12} />}
                                            {res.modelName}
                                        </span>
                                        {node.variant === "panel-vote" && (
                                            <span className="text-[10px] bg-background px-1 rounded border">
                                                {res.voteCount} votes
                                            </span>
                                        )}
                                    </div>
                                    <div className="prose prose-sm dark:prose-invert max-w-none break-words"><Markdown>{res.content}</Markdown></div>

                                    {/* Vote highlight or Panel actions */}
                                    <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 text-muted-foreground hover:text-amber-500"
                                            onClick={() => onBranchToNote(node.id, res.content)}
                                            title="Copy to Note"
                                        >
                                            <StickyNote size={12} />
                                        </Button>
                                    </div>

                                    {node.variant === "panel-vote" && res.isWinner && (
                                        <div className="absolute -top-2 -right-2 bg-green-500 text-white rounded-full p-1 shadow">
                                            <CheckCircle2 size={12} />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )
        })
    }

    const isMatch = useMemo(() => {
        if (!searchQuery) return false
        const query = searchQuery.toLowerCase()
        const messageMatch = node.messages.some(m => m.content.toLowerCase().includes(query))
        const responseMatch = node.responses.some(r => r.modelResponses.some(mr => mr.content.toLowerCase().includes(query)))
        const noteMatch = node.noteText?.toLowerCase().includes(query)
        return messageMatch || responseMatch || noteMatch
    }, [node, searchQuery])

    return (
        <>
            <SelectionTooltip
                position={selectionPos}
                onBranch={() => {
                    onBranchFromText(node.id, selectedText);
                    setSelectionPos(null);
                    window.getSelection()?.removeAllRanges();
                }}
            />

            <div
                className={cn(
                    "node-card absolute flex flex-col bg-card border rounded-xl overflow-hidden transition-all duration-300",
                    isSelected
                        ? "shadow-2xl ring-2 ring-primary border-primary z-50 scale-[1.02]"
                        : "shadow-md hover:shadow-xl border-border z-10",
                    isMatch && "ring-4 ring-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.4)] z-50"
                )}
                style={{
                    left: node.position.x,
                    top: node.position.y,
                    width: node.width,
                    height: node.height,
                    transformOrigin: "top left",
                }}
                onMouseDown={() => {
                    onSelect(node.id)
                }}
            >
                {/* HEAD */}
                <div
                    onMouseDown={(e) => onStartDrag(e, node.id)}
                    className={cn(
                        "h-10 border-b flex items-center justify-between px-3 cursor-grab active:cursor-grabbing select-none transition-colors",
                        isSelected ? "bg-primary/10" : "bg-muted/30"
                    )}
                >
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        <GripHorizontal className="w-4 h-4 opacity-50" />
                        <span>{node.variant.toUpperCase()} CHAT</span>
                    </div>
                    <div className="flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
                        {node.parents.length > 0 && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-blue-500"
                                onClick={() => onMerge(node.id)}
                                title="Merge to Parent"
                            >
                                <Combine className="w-4 h-4" />
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-primary"
                            onClick={() => onBranch(node.id)}
                            title="Branch new thread"
                        >
                            <Plus className="w-4 h-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                                e.stopPropagation()
                                onDelete(node.id)
                            }}
                            title="Delete thread"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {/* BODY (NOTE VARIANT) */}
                {node.variant === "note" && (
                    <div className="flex-1 p-0 flex flex-col bg-amber-50/30 dark:bg-amber-900/5 cursor-default" onMouseDown={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/20">
                            <div className="flex items-center gap-1.5">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn("h-7 px-2 text-[10px] gap-1", isEditingNote && "bg-background shadow-sm")}
                                    onClick={() => setIsEditingNote(true)}
                                >
                                    <Type size={10} /> Edit
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn("h-7 px-2 text-[10px] gap-1", !isEditingNote && "bg-background shadow-sm")}
                                    onClick={() => setIsEditingNote(false)}
                                >
                                    <Layers size={10} /> Preview
                                </Button>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => {
                                    navigator.clipboard.writeText(node.noteText || "")
                                    setIsCopied(true)
                                    setTimeout(() => setIsCopied(false), 2000)
                                }}
                            >
                                {isCopied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                            </Button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                            {isEditingNote ? (
                                <Textarea
                                    value={node.noteText || ""}
                                    onChange={(e) => onUpdateNode(node.id, { noteText: e.target.value })}
                                    placeholder="Type a note (Markdown supported)..."
                                    className="w-full h-full bg-transparent border-none focus-visible:ring-0 resize-none text-sm font-medium p-0"
                                />
                            ) : (
                                <div className="prose prose-sm dark:prose-invert max-w-none">
                                    <Markdown>{node.noteText || "_No content yet._"}</Markdown>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* BODY (CHAT VARIANTS) */}
                {node.variant !== "note" && (
                    <div
                        ref={scrollRef}
                        className="flex-1 overflow-y-auto p-4 bg-background/50"
                        onWheel={(e) => e.stopPropagation()}
                        onMouseUp={handleMouseUp}
                        // onMouseDown to propagate selection clearing is handled by standard browser behavior usually,
                        // but we need to ensure we don't start dragging
                        onMouseDown={e => e.stopPropagation()}
                    >
                        {node.messages.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-sm italic opacity-70">
                                <MousePointer2 className="w-8 h-8 mb-2 opacity-20" />
                                <p>Start a conversation</p>
                                <div className="text-[10px] mt-2 opacity-60">Try &quot;/multi&quot; or &quot;/vote&quot; in prompt</div>
                            </div>
                        ) : renderResponses()}
                    </div>
                )}

                {/* FOOTER (CHAT ONLY) */}
                {node.variant !== "note" && (
                    <div className="p-0 border-t bg-background" onMouseDown={e => e.stopPropagation()}>
                        <PromptInput
                            value={input}
                            onValueChange={setInput}
                            onSubmit={handleSubmit}
                            className="border-none rounded-none focus-within:ring-0 bg-transparent"
                        >
                            <PromptInputTextarea
                                placeholder={`Reply (${node.variant})...`}
                                className="min-h-[50px] max-h-[100px] text-sm py-3 resize-none bg-transparent"
                            />
                            <PromptInputActions className="pb-2 pr-2">
                                <Button
                                    size="icon"
                                    className={cn(
                                        "h-8 w-8 rounded-full transition-all",
                                        input.trim() ? "opacity-100 scale-100" : "opacity-0 scale-90"
                                    )}
                                    onClick={handleSubmit}
                                    disabled={!input.trim()}
                                >
                                    <ArrowUp className="w-4 h-4" />
                                </Button>
                            </PromptInputActions>
                        </PromptInput>
                    </div>
                )}

                {/* RESIZE HANDLE */}
                <div
                    className="absolute bottom-0 w-full h-1 bg-transparent hover:bg-primary/50 cursor-ns-resize z-50 group flex justify-center items-center"
                    onMouseDown={handleResizeMouseDown}
                >
                    <div className="w-8 h-1 bg-border rounded-full group-hover:bg-primary transition-colors" />
                </div>
            </div>
        </>
    )
}

/* ---------------- COMPONENT: MAIN CANVAS ---------------- */

export default function CanvasChatBoard() {
    const containerRef = useRef<HTMLDivElement>(null)

    // Camera State
    const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 })

    // Interaction State
    const [isPanning, setIsPanning] = useState(false)
    const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null)
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>("root")

    const lastMousePos = useRef({ x: 0, y: 0 })

    // Nodes State
    const [nodes, setNodes] = useState<ChatNode[]>([
        {
            id: "root",
            variant: "standard",
            parents: [],
            position: { x: 100, y: 100 },
            width: NODE_WIDTH_STANDARD,
            height: DEFAULT_NODE_HEIGHT,
            activeModelIndex: 0,
            messages: [
                { id: "1", role: "user", content: "Let's compare some models." }
            ],
            responses: [
                {
                    id: "r1",
                    modelResponses: [
                        { id: "mr1", role: "assistant", content: "Sure, try typing '/multi' to see different models stacked, or '/vote' to see a panel vote.", modelName: "Auto" }
                    ]
                }
            ]
        },
    ])

    // Undo/Redo/Search State
    const [history, setHistory] = useState<{ nodes: ChatNode[]; camera: { x: number; y: number; scale: number } }[]>([])
    const [redoHistory, setRedoHistory] = useState<{ nodes: ChatNode[]; camera: { x: number; y: number; scale: number } }[]>([])
    const [searchQuery, setSearchQuery] = useState("")

    // Persistence Layer: Load on Mount
    useEffect(() => {
        const savedNodes = localStorage.getItem("canvas-nodes")
        const savedCamera = localStorage.getItem("canvas-camera")
        if (savedNodes) setNodes(JSON.parse(savedNodes))
        if (savedCamera) setCamera(JSON.parse(savedCamera))
    }, [])

    // Persistence Layer: Save on Change
    useEffect(() => {
        localStorage.setItem("canvas-nodes", JSON.stringify(nodes))
        localStorage.setItem("canvas-camera", JSON.stringify(camera))
    }, [nodes, camera])

    const pushToHistory = useCallback(() => {
        setHistory(prev => [...prev.slice(-19), { nodes: JSON.parse(JSON.stringify(nodes)), camera: { ...camera } }])
        setRedoHistory([])
    }, [nodes, camera])

    const undo = useCallback(() => {
        if (history.length === 0) return
        const prev = history[history.length - 1]
        setRedoHistory(r => [...r, { nodes: JSON.parse(JSON.stringify(nodes)), camera: { ...camera } }])
        setNodes(prev.nodes)
        setCamera(prev.camera)
        setHistory(h => h.slice(0, -1))
    }, [history, nodes, camera])

    const redo = useCallback(() => {
        if (redoHistory.length === 0) return
        const next = redoHistory[redoHistory.length - 1]
        setHistory(h => [...h, { nodes: JSON.parse(JSON.stringify(nodes)), camera: { ...camera } }])
        setNodes(next.nodes)
        setCamera(next.camera)
        setRedoHistory(r => r.slice(0, -1))
    }, [redoHistory, nodes, camera])

    /* LOGIC: SEND MESSAGE */
    const sendMessage = async (nodeId: string, text: string) => {
        pushToHistory()
        // Detect Commands
        const node = nodes.find(n => n.id === nodeId)
        if (!node) return

        let nextVariant = node.variant
        let cleanText = text
        if (text.startsWith("/multi")) {
            nextVariant = "multi-model"
            cleanText = text.replace("/multi", "").trim()
        } else if (text.startsWith("/vote")) {
            nextVariant = "panel-vote"
            cleanText = text.replace("/vote", "").trim()
        } else if (text.startsWith("/std")) {
            nextVariant = "standard"
            cleanText = text.replace("/std", "").trim()
        }

        if (!cleanText) cleanText = "Demo Query"

        const userMsgId = generateId()
        const responseId = generateId()

        // Determine which models to call
        let selectedModelIds: string[]
        if (nextVariant === "multi-model") {
            selectedModelIds = AVAILABLE_MODELS.slice(0, 3).map(m => m.id)
        } else if (nextVariant === "panel-vote") {
            selectedModelIds = AVAILABLE_MODELS.map(m => m.id)
        } else {
            selectedModelIds = ["gemma-3-27b"]
        }

        // Immediately add user message + a loading placeholder
        const loadingResponses: ChatMessage[] = selectedModelIds.map(id => {
            const model = AVAILABLE_MODELS.find(m => m.id === id)
            return {
                id: generateId(),
                role: "assistant" as const,
                content: "Thinking…",
                modelName: model?.name || id
            }
        })

        setNodes(prev => prev.map(n => {
            if (n.id !== nodeId) return n
            return {
                ...n,
                variant: nextVariant,
                width: nextVariant === "multi-model" ? NODE_WIDTH_MULTI : NODE_WIDTH_STANDARD,
                messages: [...n.messages, { id: userMsgId, role: "user" as const, content: cleanText }],
                responses: [...n.responses, { id: responseId, modelResponses: loadingResponses }]
            }
        }))

        // Build conversation history from this node's messages
        const conversationHistory = node.messages.map(m => ({
            role: m.role,
            content: m.content
        }))

        // Call the backend API
        try {
            const res = await fetch("/api/canvas-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: cleanText,
                    variant: nextVariant,
                    models: selectedModelIds,
                    conversationHistory,
                }),
            })

            const data = await res.json()

            if (data.success && data.responses) {
                // Map API responses to ChatMessage format
                const realResponses: ChatMessage[] = data.responses.map((r: { modelId: string; displayName: string; content: string; voteCount?: number; isWinner?: boolean }) => ({
                    id: generateId(),
                    role: "assistant" as const,
                    content: r.content,
                    modelName: r.displayName,
                    voteCount: r.voteCount,
                    isWinner: r.isWinner,
                }))

                // Replace loading placeholder with real responses
                setNodes(prev => prev.map(n => {
                    if (n.id !== nodeId) return n
                    return {
                        ...n,
                        responses: n.responses.map(resp =>
                            resp.id === responseId
                                ? { ...resp, modelResponses: realResponses }
                                : resp
                        )
                    }
                }))
            } else {
                // Error from API — show error message
                setNodes(prev => prev.map(n => {
                    if (n.id !== nodeId) return n
                    return {
                        ...n,
                        responses: n.responses.map(resp =>
                            resp.id === responseId
                                ? {
                                    ...resp,
                                    modelResponses: [{
                                        id: generateId(),
                                        role: "assistant" as const,
                                        content: `⚠️ ${data.error || "Failed to get a response."}`,
                                        modelName: "System"
                                    }]
                                }
                                : resp
                        )
                    }
                }))
            }
        } catch (err) {
            // Network error
            setNodes(prev => prev.map(n => {
                if (n.id !== nodeId) return n
                return {
                    ...n,
                    responses: n.responses.map(resp =>
                        resp.id === responseId
                            ? {
                                ...resp,
                                modelResponses: [{
                                    id: generateId(),
                                    role: "assistant" as const,
                                    content: `⚠️ Network error: ${String(err)}`,
                                    modelName: "System"
                                }]
                            }
                            : resp
                    )
                }
            }))
        }
    }

    /* LOGIC: BRANCHING */
    const branchThread = (parentId: string, contextText: string | null = null) => {
        pushToHistory()
        const parent = nodes.find(n => n.id === parentId)
        if (!parent) return

        const newNodeId = generateId()

        // Smarter placement
        const children = nodes.filter(n => n.parents.includes(parentId));
        const targetX = parent.position.x + parent.width + 150
        let targetY = parent.position.y

        if (children.length > 0) {
            const lastChild = children[children.length - 1];
            targetY = lastChild.position.y + lastChild.height + 50;
        }

        const initialMessages: { id: string; role: "user"; content: string }[] = []
        if (contextText) {
            initialMessages.push({
                id: generateId(),
                role: "user",
                content: `Branching off: "...${contextText.slice(0, 50)}..."\n\nExplain this specific part.`
            })
        }

        const newNode: ChatNode = {
            id: newNodeId,
            variant: "standard",
            parents: [parentId],
            messages: initialMessages,
            responses: [],
            position: { x: targetX, y: targetY },
            width: NODE_WIDTH_STANDARD,
            height: DEFAULT_NODE_HEIGHT,
            activeModelIndex: 0
        }

        setNodes(prev => [...prev, newNode])
        setSelectedNodeId(newNodeId)
    }

    /* LOGIC: MERGE */
    const mergeNode = (nodeId: string) => {
        pushToHistory()
        const node = nodes.find(n => n.id === nodeId)
        if (!node || node.parents.length === 0) return

        const parentId = node.parents[0] // Simple primary parent merge

        setNodes(prev => {
            const parent = prev.find(n => n.id === parentId)
            const child = prev.find(n => n.id === nodeId)
            if (!parent || !child) return prev

            // Merge messages logic: Append child conversation to parent
            // In a real app complexity increases (interleaved timestamps?)
            const mergedMessages = [...parent.messages, ...child.messages]
            const mergedResponses = [...parent.responses, ...child.responses]

            return prev
                .map(n => {
                    if (n.id === parentId) {
                        return {
                            ...n,
                            messages: mergedMessages,
                            responses: mergedResponses,
                            // Ideally expand height or width
                            height: Math.max(n.height, child.height + 200)
                        }
                    }
                    return n
                })
                .filter(n => n.id !== nodeId) // Remove child
        })

        setSelectedNodeId(parentId)
    }

    /* LOGIC: BRANCH TO NOTE */
    const branchToNote = (nodeId: string, content: string) => {
        const id = generateId()
        const node = nodes.find(n => n.id === nodeId)
        if (!node) return

        const newNode: ChatNode = {
            id,
            variant: "note",
            parents: [nodeId],
            messages: [],
            responses: [],
            position: { x: node.position.x + node.width + 100, y: node.position.y },
            width: 300,
            height: 250,
            activeModelIndex: 0,
            noteText: content
        }
        setNodes(prev => [...prev, newNode])
        setSelectedNodeId(id)
    }

    /* LOGIC: DELETE */
    const deleteNode = (nodeId: string) => {
        pushToHistory()
        setNodes(prev => prev.filter(n => n.id !== nodeId).map(n => ({
            ...n,
            parents: n.parents.filter(pid => pid !== nodeId)
        })))
        if (selectedNodeId === nodeId) setSelectedNodeId(null)
    }

    /* LOGIC: TIDY CANVAS */
    const tidyCanvas = () => {
        pushToHistory()
        // Simple tree layout algorithm
        const HORIZONTAL_GAP = 150
        const VERTICAL_GAP = 50

        const levels: Record<string, number> = {}

        // 1. Determine Levels via BFS/DFS
        const calculateLevel = (nodeId: string, level: number) => {
            levels[nodeId] = Math.max(levels[nodeId] || 0, level)
            const children = nodes.filter(n => n.parents.includes(nodeId))
            children.forEach(c => calculateLevel(c.id, level + 1))
        }

        const roots = nodes.filter(n => n.parents.length === 0)
        roots.forEach(r => calculateLevel(r.id, 0))

        // 2. Position by level
        const newNodes = [...nodes].sort((a, b) => (levels[a.id] || 0) - (levels[b.id] || 0))

        // We want to center the tree
        const nodesByLevel: Record<number, ChatNode[]> = {}
        newNodes.forEach(n => {
            const l = levels[n.id] || 0
            if (!nodesByLevel[l]) nodesByLevel[l] = []
            nodesByLevel[l].push(n)
        })

        const updatedNodes = nodes.map(n => {
            const l = levels[n.id] || 0
            const nodesInLevel = nodesByLevel[l]
            const indexInLevel = nodesInLevel.findIndex(ln => ln.id === n.id)

            // Calculate X based on level
            const x = 100 + l * (NODE_WIDTH_STANDARD + HORIZONTAL_GAP)

            // Calculate Y based on index in level, centered around parent if possible
            // For now, simple stacked positioning
            const y = 100 + (indexInLevel * (DEFAULT_NODE_HEIGHT + VERTICAL_GAP))

            return { ...n, position: { x, y } }
        })

        setNodes(updatedNodes)
    }

    /* LOGIC: ADD NOTE */
    const addNote = () => {
        pushToHistory()
        const id = generateId()
        const newNode: ChatNode = {
            id,
            variant: "note",
            parents: [],
            messages: [],
            responses: [],
            position: { x: -camera.x / camera.scale + 100, y: -camera.y / camera.scale + 100 },
            width: 300,
            height: 250,
            activeModelIndex: 0,
            noteText: ""
        }
        setNodes(prev => [...prev, newNode])
        setSelectedNodeId(id)
    }

    /* LOGIC: ADD CHAT NODE */
    const addChatNode = () => {
        pushToHistory()
        const id = generateId()
        const newNode: ChatNode = {
            id,
            variant: "standard",
            parents: [],
            messages: [],
            responses: [],
            position: { x: -camera.x / camera.scale + 100, y: -camera.y / camera.scale + 100 },
            width: NODE_WIDTH_STANDARD,
            height: DEFAULT_NODE_HEIGHT,
            activeModelIndex: 0
        }
        setNodes(prev => [...prev, newNode])
        setSelectedNodeId(id)
    }

    /* EVENTS */
    // ... Copy existing event handlers from previous step with exact same logic, or slight tweaks
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Undo/Redo
            if ((e.ctrlKey || e.metaKey) && e.key === "z") {
                if (e.shiftKey) redo()
                else undo()
            }
            if ((e.ctrlKey || e.metaKey) && e.key === "y") {
                redo()
            }

            // Shortcuts while node is selected
            if (selectedNodeId) {
                if (e.key === "Delete" || e.key === "Backspace") {
                    // Check if not typing in an input
                    const target = e.target as HTMLElement
                    if (target.tagName !== "TEXTAREA" && target.tagName !== "INPUT") {
                        deleteNode(selectedNodeId)
                    }
                }
                if (e.key === "Escape") {
                    setSelectedNodeId(null)
                }
            }
        }
        window.addEventListener("keydown", handleKeyDown)
        return () => window.removeEventListener("keydown", handleKeyDown)
    }, [undo, redo, selectedNodeId, deleteNode])

    const handleWheel = useCallback((e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            const zoomSensitivity = 0.001
            setCamera(prev => {
                const newScale = Math.min(3, Math.max(0.2, prev.scale - e.deltaY * zoomSensitivity))
                return { ...prev, scale: newScale }
            })
        } else {
            const target = e.target as HTMLElement
            const scrollable = target.closest('.overflow-y-auto')
            if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return
            e.preventDefault()
            setCamera(prev => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }))
        }
    }, [])

    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        el.addEventListener("wheel", handleWheel, { passive: false })
        return () => el.removeEventListener("wheel", handleWheel)
    }, [handleWheel])

    const handleMouseDown = (e: React.MouseEvent) => {
        if (draggedNodeId) return
        if (!(e.target as HTMLElement).closest(".node-card")) {
            setSelectedNodeId(null)
            setIsPanning(true)
            lastMousePos.current = { x: e.clientX, y: e.clientY }
        }
    }

    const handleMouseMove = (e: React.MouseEvent) => {
        const dx = e.clientX - lastMousePos.current.x
        const dy = e.clientY - lastMousePos.current.y
        lastMousePos.current = { x: e.clientX, y: e.clientY }

        if (draggedNodeId) {
            setNodes(prev => prev.map(n => {
                if (n.id === draggedNodeId) {
                    return {
                        ...n,
                        position: {
                            x: n.position.x + dx / camera.scale,
                            y: n.position.y + dy / camera.scale
                        }
                    }
                }
                return n
            }))
        } else if (isPanning) {
            setCamera(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
        }
    }

    const handleMouseUp = () => {
        setIsPanning(false)
        setDraggedNodeId(null)
    }

    /* RENDER CONNECTIONS */
    const renderConnections = () => {
        return nodes.flatMap(node =>
            node.parents.map(parentId => {
                const parent = nodes.find(n => n.id === parentId)
                if (!parent) return null

                const isSelected = selectedNodeId === node.id || selectedNodeId === parentId
                const startX = parent.position.x + parent.width
                const startY = parent.position.y + 54
                const endX = node.position.x
                const endY = node.position.y + 54

                const dist = Math.abs(endX - startX)
                const cp1 = { x: startX + dist * 0.4, y: startY }
                const cp2 = { x: endX - dist * 0.4, y: endY }
                const pathData = `M ${startX} ${startY} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${endX} ${endY}`

                return (
                    <g key={`${parentId}-${node.id}`} className="group/conn">
                        <path d={pathData} stroke="transparent" strokeWidth="16" fill="none" className="pointer-events-auto hover:stroke-foreground/5 cursor-pointer" />
                        <path
                            d={pathData}
                            stroke={isSelected ? "currentColor" : "currentColor"}
                            strokeWidth={isSelected ? "3" : "2"}
                            strokeOpacity={isSelected ? "0.9" : "0.2"}
                            fill="none"
                            markerEnd={isSelected ? "url(#arrowhead-selected)" : "url(#arrowhead)"}
                            className={cn(
                                "transition-all duration-300",
                                isSelected ? "text-primary stroke-[3]" : "text-foreground group-hover/conn:stroke-primary group-hover/conn:stroke-2 group-hover/conn:stroke-opacity-50"
                            )}
                            strokeDasharray={isSelected ? "5,5" : "0"}
                        >
                            {isSelected && (
                                <animate
                                    attributeName="stroke-dashoffset"
                                    from="100"
                                    to="0"
                                    dur="3s"
                                    repeatCount="indefinite"
                                />
                            )}
                        </path>
                    </g>
                )
            })
        )
    }

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-muted/5 relative text-foreground font-sans">
            {/* UI LAYERS */}
            <div className="absolute top-4 left-4 z-50 flex items-center gap-2 p-1 bg-background/80 backdrop-blur border rounded-lg shadow-md">
                <Button variant="ghost" size="icon" onClick={() => setCamera({ x: 0, y: 0, scale: 1 })} title="Reset View">
                    <LocateFixed className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="icon" onClick={undo} disabled={history.length === 0} title="Undo (Ctrl+Z)">
                    <Undo2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={redo} disabled={redoHistory.length === 0} title="Redo (Ctrl+Y)">
                    <Redo2 className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="icon" onClick={tidyCanvas} title="Tidy Canvas">
                    <LayoutTemplate className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={addChatNode} title="Add Chat">
                    <MessageSquare className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={addNote} title="Add Note">
                    <StickyNote className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <div className="relative group transition-all duration-300 focus-within:w-64 w-40">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                    <input
                        type="text"
                        placeholder="Search nodes..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-muted/40 border-none rounded-md pl-8 pr-2 py-1.5 text-xs focus-visible:ring-1 focus-within:bg-background ring-primary outline-none transition-all"
                    />
                </div>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="icon" onClick={() => {
                    const blob = new Blob([JSON.stringify({ nodes, camera }, null, 2)], { type: "application/json" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = `canvas-export-${new Date().toISOString().split('T')[0]}.json`
                    a.click()
                }} title="Export Canvas">
                    <Download className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => {
                    if (confirm("Clear entire canvas? This cannot be undone.")) {
                        pushToHistory()
                        setNodes([])
                        setCamera({ x: 0, y: 0, scale: 1 })
                    }
                }} className="text-destructive hover:bg-destructive/10" title="Clear Canvas">
                    <X className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <ModeToggle />
                <div className="px-3 text-xs font-mono text-muted-foreground select-none">
                    {Math.round(camera.scale * 100)}%
                </div>
            </div>

            <MiniMap
                nodes={nodes}
                camera={camera}
                onNavigate={(x, y) => setCamera(prev => ({ ...prev, x, y }))}
            />

            {/* MAIN CANVAS */}
            <div
                ref={containerRef}
                className={cn(
                    "flex-1 relative overflow-hidden",
                    isPanning ? "cursor-grabbing" : "cursor-default"
                )}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                style={{
                    backgroundImage: "radial-gradient(circle, #88888844 1px, transparent 1px)",
                    backgroundSize: "24px 24px",
                    backgroundPosition: `${camera.x}px ${camera.y}px`
                }}
            >
                <div
                    style={{
                        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
                        transformOrigin: "0 0",
                        width: "100%",
                        height: "100%",
                    }}
                    className="absolute inset-0 pointer-events-none"
                >
                    <svg className="absolute top-[-10000px] left-[-10000px] w-[20000px] h-[20000px] overflow-visible pointer-events-none z-0">
                        <defs>
                            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                                <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" className="text-muted-foreground/40" />
                            </marker>
                            <marker id="arrowhead-selected" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                                <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" className="text-primary" />
                            </marker>
                        </defs>
                        <g transform={`translate(10000, 10000)`}>
                            {renderConnections()}
                        </g>
                    </svg>

                    <div className="pointer-events-auto relative z-10 w-full h-full">
                        {nodes.length === 0 && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                                <div className="bg-background/80 backdrop-blur-md border p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 pointer-events-auto animate-in fade-in zoom-in duration-500">
                                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                                        <MessageSquare className="w-8 h-8 text-primary" />
                                    </div>
                                    <div className="text-center">
                                        <h3 className="text-xl font-bold">Canvas is Empty</h3>
                                        <p className="text-muted-foreground text-sm">Start a new spatial conversation</p>
                                    </div>
                                    <Button onClick={addChatNode} className="rounded-full px-8 gap-2">
                                        <Plus className="w-4 h-4" /> New Chat
                                    </Button>
                                </div>
                            </div>
                        )}
                        {nodes.map(node => (
                            <ChatNodeCard
                                key={node.id}
                                node={node}
                                scale={camera.scale}
                                isSelected={selectedNodeId === node.id}
                                onSelect={setSelectedNodeId}
                                onSend={sendMessage}
                                onBranch={branchThread}
                                onBranchFromText={(id, text) => {
                                    branchThread(id, text)
                                }}
                                onDelete={deleteNode}
                                onStartDrag={(e, id) => {
                                    e.stopPropagation()
                                    setDraggedNodeId(id)
                                    setSelectedNodeId(id)
                                    lastMousePos.current = { x: e.clientX, y: e.clientY }
                                }}
                                onResize={(id, h) => {
                                    setNodes(prev => prev.map(n => n.id === id ? { ...n, height: h } : n))
                                }}
                                onMerge={mergeNode}
                                onUpdateNode={(id, updates) => {
                                    setNodes(prev => prev.map(n => n.id === id ? { ...n, ...updates } : n))
                                }}
                                onBranchToNote={branchToNote}
                                searchQuery={searchQuery}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
