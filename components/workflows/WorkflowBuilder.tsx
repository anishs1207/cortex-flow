"use client";

import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import RunHistoryViewer from "./RunHistoryViewer";
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    addEdge,
    useNodesState,
    useEdgesState,
    Handle,
    Position,
    Connection,
    MarkerType,
    type Node as RFNode,
    type Edge as RFEdge,
    useReactFlow,
    Panel,
    getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import ModeToggle from "@/components/chat/ModeToggle";
import { Markdown } from "@/components/ui/markdown";
import {
    Plus,
    Play,
    Trash2,
    Save,
    FolderOpen,
    FileText,
    Zap,
    MessageSquare,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Settings2,
    ChevronDown,
    ChevronRight,
    X,
    Sparkles,
    Bot,
    Download,
    Upload,
    History,
    Flag,
    Split,
    Undo2,
    Redo2,
    LayoutTemplate,
    Search,
    Type,
    Copy,
    Check,
    Lock,
    Unlock,
    Download as DownloadIcon,
    StickyNote
} from "lucide-react";
import CopyButton from "./CopyButton";

interface RunHistoryEntry {
    id: string;
    workflowName: string;
    ranAt: string;
    duration: number;
    nodeResults: Record<string, { label: string; status: NodeStatus; result: string; error: string }>;
}

type NodeStatus = "idle" | "running" | "success" | "error";

interface WorkflowNodeData {
    label: string;
    systemPrompt: string;
    userPrompt: string;
    status: NodeStatus;
    result: string;
    error: string;
    isStartNode: boolean;
    isEndNode: boolean;
    isConditionNode?: boolean;
    isNoteNode?: boolean;
    conditionQuery?: string;
    modelId?: string;
    startInput: string;
    noteText?: string;
    [key: string]: unknown;
}


interface SavedWorkflow {
    id: string;
    name: string;
    nodes: RFNode<WorkflowNodeData>[];
    edges: RFEdge[];
    createdAt: string;
}

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Process the input and produce a clear, useful output.";
const DEFAULT_USER_PROMPT = "{{input}}";
const LS_WORKFLOWS = "workflows";
const LS_RUNS = "workflow-runs";

const AVAILABLE_MODELS = [
    { id: "gemma-3-27b", name: "Gemma 3 27B" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "claude-3.5", name: "Claude 3.5" },
    { id: "deepseek", name: "DeepSeek" },
    { id: "llama-3", name: "Llama 3" },
];

function resolveTemplatePath(obj: unknown, path: string): string {
    if (path === "input") {
        return typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    }

    // Strip leading "input." to get the nested path
    const subPath = path.startsWith("input.") ? path.slice(6) : path;
    const parts = subPath.split(".");

    let current: unknown = obj;

    // If the raw input is a string, try to parse it as JSON for nested access
    if (typeof current === "string") {
        try {
            current = JSON.parse(current);
        } catch {
            // not JSON — return the raw string for {{input}}, empty for nested
            //@ts-expect-error - input path might not exist on current
            return path === "input" ? current : "";
        }
    }

    for (const part of parts) {
        if (current === null || current === undefined) return "";
        if (typeof current === "object" && part in (current as Record<string, unknown>)) {
            current = (current as Record<string, unknown>)[part];
        } else {
            return "";
        }
    }

    if (current === null || current === undefined) return "";
    return typeof current === "string" ? current : JSON.stringify(current, null, 2);
}

function WorkflowNode({ id, data, selected }: { id: string; data: WorkflowNodeData; selected?: boolean }) {
    const { setNodes } = useReactFlow();

    const updateField = useCallback(
        (field: keyof WorkflowNodeData, value: string | boolean) => {
            setNodes((nds) =>
                nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, [field]: value } } : n))
            );
        },
        [id, setNodes]
    );

    const statusIcon = useMemo(() => {
        switch (data.status) {
            case "running": return <Loader2 className="w-4 h-4 animate-spin text-blue-400" />;
            case "success": return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
            case "error": return <AlertCircle className="w-4 h-4 text-red-400" />;
            default: return null;
        }
    }, [data.status]);

    const statusColor = useMemo(() => {
        switch (data.status) {
            case "running": return "border-blue-500/60 shadow-blue-500/10";
            case "success": return data.isEndNode ? "border-amber-500/60 shadow-amber-500/20" : "border-emerald-500/60 shadow-emerald-500/10";
            case "error": return "border-red-500/60 shadow-red-500/10";
            default: return "border-border";
        }
    }, [data.status, data.isEndNode]);

    const [expanded, setExpanded] = useState(true);

    const headerBg = data.isStartNode
        ? "bg-gradient-to-r from-emerald-500/10 to-emerald-500/5"
        : data.isEndNode
            ? "bg-gradient-to-r from-amber-500/10 to-amber-500/5"
            : "bg-muted/30";

    const nodeIcon = data.isStartNode
        ? <Zap className="w-4 h-4 text-emerald-400 shrink-0" />
        : data.isEndNode
            ? <Flag className="w-4 h-4 text-amber-400 shrink-0" />
            : data.isConditionNode
                ? <Split className="w-4 h-4 text-purple-400 shrink-0" />
                : data.isNoteNode
                    ? <StickyNote className="w-4 h-4 text-yellow-400 shrink-0" />
                    : <Bot className="w-4 h-4 text-muted-foreground shrink-0" />;

    return (
        <div
            className={cn(
                "rounded-xl border-2 bg-card shadow-lg transition-all duration-300 w-[360px]",
                statusColor,
                selected && "ring-2 ring-primary ring-offset-2 ring-offset-background"
            )}
        >
            {/* Handles */}
            {!data.isStartNode && (
                <Handle type="target" position={Position.Left}
                    className="!w-3 !h-3 !bg-primary !border-2 !border-background" />
            )}
            {!data.isEndNode && !data.isConditionNode && (
                <Handle type="source" position={Position.Right}
                    className="!w-3 !h-3 !bg-primary !border-2 !border-background" />
            )}
            {data.isConditionNode && (
                <>
                    <Handle type="source" position={Position.Right} id="true"
                        style={{ top: '30%' }}
                        className="!w-3 !h-3 !bg-emerald-500 !border-2 !border-background" />
                    <Handle type="source" position={Position.Right} id="false"
                        style={{ top: '70%' }}
                        className="!w-3 !h-3 !bg-red-500 !border-2 !border-background" />
                </>
            )}
            {/* End nodes still get a target handle */}
            {data.isNoteNode && (
                <>
                    <Handle type="target" position={Position.Left} className="!opacity-0" />
                    <Handle type="source" position={Position.Right} className="!opacity-0" />
                </>
            )}
            {data.isEndNode && (
                <Handle type="target" position={Position.Left}
                    className="!w-3 !h-3 !bg-amber-400 !border-2 !border-background" />
            )}

            {/* Header */}
            <div
                className={cn("flex items-center gap-2 px-3 py-2.5 border-b rounded-t-xl cursor-pointer select-none", headerBg)}
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    {nodeIcon}
                    <input
                        value={data.label}
                        onChange={(e) => updateField("label", e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-transparent border-none outline-none text-sm font-semibold w-full text-foreground placeholder:text-muted-foreground"
                        placeholder="Node name..."
                    />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {statusIcon}
                    {expanded
                        ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                        : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                </div>
            </div>

            {/* Body */}
            {expanded && (
                <div className="p-3 space-y-3 nodrag nowheel">
                    {/* Start Node: initial user input */}
                    {data.isStartNode && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                <MessageSquare className="w-3 h-3" /> Initial Input
                            </label>
                            <Textarea
                                value={data.startInput}
                                onChange={(e) => updateField("startInput", e.target.value)}
                                placeholder="Enter the starting text or JSON for this workflow..."
                                className="text-xs min-h-[60px] max-h-[120px] resize-none bg-muted/30 border-muted"
                                rows={3}
                            />
                        </div>
                    )}

                    {/* Condition Node: logic query */}
                    {data.isConditionNode && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                <Split className="w-3 h-3" /> Condition (True if...)
                            </label>
                            <p className="text-[9px] text-muted-foreground/70 -mt-0.5">
                                Describe the condition, e.g. &quot;input contains &apos;urgent&apos;&quot;
                            </p>
                            <Textarea
                                value={data.conditionQuery || ""}
                                onChange={(e) => updateField("conditionQuery", e.target.value)}
                                placeholder="Condition logic..."
                                className="text-xs min-h-[50px] max-h-[80px] resize-none bg-purple-500/5 border-purple-500/20"
                                rows={2}
                            />
                            <div className="flex justify-between text-[8px] font-bold uppercase tracking-tighter opacity-50 px-1">
                                <span className="text-emerald-500">True (Top)</span>
                                <span className="text-red-500">False (Bottom)</span>
                            </div>
                        </div>
                    )}

                    {/* Model Selection (only for processing nodes) */}
                    {!data.isStartNode && !data.isEndNode && !data.isConditionNode && !data.isNoteNode && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                <Sparkles className="w-3 h-3" /> AI Model
                            </label>
                            <select
                                value={data.modelId || "gemma-3-27b"}
                                onChange={(e) => updateField("modelId", e.target.value)}
                                className="w-full bg-muted/40 border-muted rounded-md px-2 py-1 text-xs outline-none focus:ring-1 ring-primary appearance-none cursor-pointer"
                            >
                                {AVAILABLE_MODELS.map(m => (
                                    <option key={m.id} value={m.id} className="bg-card text-foreground">{m.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* System Prompt (hide for Start/End/Note) */}
                    {!data.isStartNode && !data.isEndNode && !data.isNoteNode && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                <Settings2 className="w-3 h-3" /> System Prompt
                            </label>
                            <Textarea
                                value={data.systemPrompt}
                                onChange={(e) => updateField("systemPrompt", e.target.value)}
                                placeholder="Define the AI's behavior..."
                                className="text-xs min-h-[50px] max-h-[100px] resize-none bg-muted/30 border-muted"
                                rows={2}
                            />
                        </div>
                    )}

                    {/* User Prompt Template (hide for Start/End/Note) */}
                    {!data.isStartNode && !data.isEndNode && !data.isNoteNode && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                <FileText className="w-3 h-3" /> Prompt Template
                            </label>
                            <p className="text-[9px] text-muted-foreground/70 -mt-0.5">
                                {"Use {{input}} for full prev data, or {{input.key}} for nested JSON fields"}
                            </p>
                            <Textarea
                                value={data.userPrompt}
                                onChange={(e) => updateField("userPrompt", e.target.value)}
                                placeholder="{{input}}"
                                className="text-xs min-h-[40px] max-h-[80px] resize-none bg-muted/30 border-muted font-mono"
                                rows={2}
                            />
                        </div>
                    )}

                    {/* Note Content */}
                    {data.isNoteNode && (
                        <div className="space-y-1.5">
                            <Textarea
                                value={data.noteText || ""}
                                onChange={(e) => updateField("noteText", e.target.value)}
                                placeholder="Type a note (Markdown supported)..."
                                className="text-xs min-h-[150px] resize-none bg-amber-500/5 border-amber-500/10 font-medium"
                                rows={6}
                            />
                            <div className="prose prose-sm dark:prose-invert max-w-none text-[10px] opacity-70 mt-2 p-2 rounded bg-muted/20">
                                <Markdown>{data.noteText || "_No content._"}</Markdown>
                            </div>
                        </div>
                    )}

                    {/* Result Display */}
                    {(data.status === "success" || data.status === "error") && (
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                    {data.status === "success" ? (
                                        <><CheckCircle2 className="w-3 h-3 text-emerald-400" /> Result</>
                                    ) : (
                                        <><AlertCircle className="w-3 h-3 text-red-400" /> Error</>
                                    )}
                                </label>
                                {data.status === "success" && <CopyButton text={data.result} />}
                            </div>

                            {/* End node gets SPECIAL prominent display */}
                            {data.isEndNode && data.status === "success" ? (
                                <div className="rounded-xl border-2 border-amber-500/30 bg-gradient-to-br from-amber-500/5 via-background to-amber-500/5 overflow-hidden">
                                    <div className="flex items-center justify-between px-3 py-2 bg-amber-500/10 border-b border-amber-500/20">
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                                            <Sparkles className="w-3 h-3" /> Final Output
                                        </span>
                                        <CopyButton text={data.result} />
                                    </div>
                                    <div className="p-3 max-h-[300px] overflow-y-auto">
                                        <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                                            <Markdown>{data.result}</Markdown>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div
                                    className={cn(
                                        "text-xs rounded-lg p-2.5 max-h-[200px] overflow-y-auto border",
                                        data.status === "success"
                                            ? "bg-emerald-500/5 border-emerald-500/20"
                                            : "bg-red-500/5 border-red-500/20 text-red-400"
                                    )}
                                >
                                    {data.status === "success" ? (
                                        <div className="prose prose-sm dark:prose-invert max-w-none">
                                            <Markdown>{data.result}</Markdown>
                                        </div>
                                    ) : (
                                        <p>{data.error}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {data.status === "running" && (
                        <div className="flex items-center gap-2 text-xs text-blue-400 animate-pulse p-2 bg-blue-500/5 rounded-lg border border-blue-500/20">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Processing...
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function renderTemplate(template: string, inputData: string): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
        return resolveTemplatePath(inputData, path.trim());
    });
}

function AnimatedEdge({
    id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style,
}: {
    id: string; sourceX: number; sourceY: number; targetX: number; targetY: number;
    sourcePosition: Position; targetPosition: Position; style?: React.CSSProperties; markerEnd?: string;
}) {
    const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
    return (
        <>
            <path id={id} d={edgePath} fill="none" stroke="var(--border)" strokeWidth={2} style={style} />
            <circle fill="var(--primary)" r={3}>
                <animateMotion dur="2s" path={edgePath} repeatCount="indefinite" />
            </circle>
        </>
    );
}

export default function WorkflowBuilder() {
    const reactFlowInstance = useReactFlow();
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Nodes & Edges ──────────────────────────────────────────────
    //@ts-expect-error - React Flow useNodesState type mismatch
    const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNodeData>([
        {
            id: "start-1",
            type: "workflowNode",
            position: { x: 100, y: 200 },
            data: {
                label: "Start",
                systemPrompt: DEFAULT_SYSTEM_PROMPT,
                userPrompt: DEFAULT_USER_PROMPT,
                status: "idle",
                result: "",
                error: "",
                isStartNode: true,
                isEndNode: false,
                startInput: "",
            },
        },
    ]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

    // Undo/Redo State
    const [history, setHistory] = useState<{ nodes: RFNode<WorkflowNodeData>[]; edges: RFEdge[] }[]>([]);
    const [redoHistory, setRedoHistory] = useState<{ nodes: RFNode<WorkflowNodeData>[]; edges: RFEdge[] }[]>([]);

    const pushToHistory = useCallback(() => {
        setHistory((prev) => [...prev.slice(-19), {
            nodes: JSON.parse(JSON.stringify(nodes)),
            edges: JSON.parse(JSON.stringify(edges))
        }]);
        setRedoHistory([]);
    }, [nodes, edges]);

    const undo = useCallback(() => {
        if (history.length === 0) return;
        const prev = history[history.length - 1];
        setRedoHistory((r) => [...r, {
            nodes: JSON.parse(JSON.stringify(nodes)),
            edges: JSON.parse(JSON.stringify(edges))
        }]);
        setNodes(prev.nodes as any);
        setEdges(prev.edges);
        setHistory((h) => h.slice(0, -1));
    }, [history, nodes, edges, setNodes, setEdges]);

    const redo = useCallback(() => {
        if (redoHistory.length === 0) return;
        const next = redoHistory[redoHistory.length - 1];
        setHistory((h) => [...h, {
            nodes: JSON.parse(JSON.stringify(nodes)),
            edges: JSON.parse(JSON.stringify(edges))
        }]);
        setNodes(next.nodes as any);
        setEdges(next.edges);
        setRedoHistory((r) => r.slice(0, -1));
    }, [redoHistory, nodes, edges, setNodes, setEdges]);

    // Tidy Layout
    const tidyWorkflow = useCallback(() => {
        pushToHistory();
        const HORIZONTAL_GAP = 400;
        const VERTICAL_GAP = 100;

        const levels: Record<string, number> = {};
        const calculateLevel = (nodeId: string, level: number) => {
            levels[nodeId] = Math.max((levels[nodeId] as any) || 0, level);
            edges.filter(e => e.source === nodeId).forEach(e => calculateLevel(e.target, level + 1));
        };

        const roots = nodes.filter(n => (n.data as WorkflowNodeData).isStartNode);
        roots.forEach(r => calculateLevel(r.id as string, 0));

        const nodesByLevel: Record<number, RFNode<WorkflowNodeData>[]> = {};
        nodes.forEach(n => {
            const l = levels[n.id as string] || 0;
            if (!nodesByLevel[l]) nodesByLevel[l] = [];
            nodesByLevel[l].push(n as any);
        });

        setNodes(nds => (nds as any[]).map(n => {
            const l = levels[n.id] || 0;
            const idx = nodesByLevel[l].findIndex(nl => nl.id === n.id);
            return {
                ...n,
                position: {
                    x: 100 + l * HORIZONTAL_GAP,
                    y: 100 + idx * (500 + VERTICAL_GAP)
                }
            };
        }));
        setTimeout(() => reactFlowInstance.fitView({ padding: 0.2 }), 100);
    }, [nodes, edges, setNodes, reactFlowInstance, pushToHistory]);

    // ── Workflow management ────────────────────────────────────────
    const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([]);
    const [currentWorkflowName, setCurrentWorkflowName] = useState("Untitled Workflow");
    const [currentWorkflowId, setCurrentWorkflowId] = useState<string | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [isRunning, setIsRunning] = useState(false);

    // ── Run history ────────────────────────────────────────────────
    const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
    const [showRunHistory, setShowRunHistory] = useState(false);

    // Load from localStorage ────────────────────────────────────────
    useEffect(() => {
        try {
            const wf = localStorage.getItem(LS_WORKFLOWS);
            if (wf) setSavedWorkflows(JSON.parse(wf));
        } catch { /* ignore */ }
        try {
            const rh = localStorage.getItem(LS_RUNS);
            if (rh) setRunHistory(JSON.parse(rh));
        } catch { /* ignore */ }
    }, []);

    // ── Handlers ───────────────────────────────────────────────────
    const onConnect = useCallback(
        (params: Connection) => {
            pushToHistory();
            setEdges((eds) =>
                addEdge(
                    { ...params, type: "animated", markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)" } },
                    eds
                )
            );
        },
        [setEdges, pushToHistory]
    );

    const addNode = useCallback(
        (kind: "start" | "process" | "end" | "condition" | "note") => {
            pushToHistory();
            const id = `node-${Date.now()}`;
            const viewport = reactFlowInstance.getViewport();
            const newNode: RFNode<WorkflowNodeData> = {
                id,
                type: "workflowNode",
                position: {
                    x: (-viewport.x + 400) / viewport.zoom,
                    y: (-viewport.y + 300) / viewport.zoom,
                },
                data: {
                    label: kind === "start" ? "Start" : kind === "end" ? "Output" : kind === "note" ? "Note" : "Step",
                    systemPrompt: DEFAULT_SYSTEM_PROMPT,
                    userPrompt: DEFAULT_USER_PROMPT,
                    status: "idle",
                    result: "",
                    error: "",
                    isStartNode: kind === "start",
                    isEndNode: kind === "end",
                    isConditionNode: kind === "condition",
                    isNoteNode: kind === "note",
                    startInput: "",
                    noteText: "",
                    modelId: "gemma-3-27b"
                },
            };
            //@ts-expect-error - React Flow nodes state mismatch with custom data structure
            setNodes((nds) => [...nds, newNode]);
        },
        [reactFlowInstance, setNodes, pushToHistory]
    );

    const deleteSelected = useCallback(() => {
        pushToHistory();
        setNodes((nds) => nds.filter((n) => !n.selected));
        setEdges((eds) => {
            const selectedNodeIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
            return eds.filter((e) => !e.selected && !selectedNodeIds.has(e.source) && !selectedNodeIds.has(e.target));
        });
    }, [nodes, setNodes, setEdges, pushToHistory]);

    const clearResults = useCallback(() => {
        pushToHistory();
        setNodes((nds) =>
            nds.map((n) => ({
                ...n,
                //@ts-expect-error - data property update status
                data: { ...n.data, status: "idle" as NodeStatus, result: "", error: "" },
            }))
        );
    }, [setNodes, pushToHistory]);

    // ── Save / Load / Export / Import ──────────────────────────────
    const buildWorkflowObj = useCallback(
        (name?: string): SavedWorkflow => ({
            id: currentWorkflowId || `wf-${Date.now()}`,
            name: name || currentWorkflowName,
            //@ts-expect-error - nodes map type mismatch
            nodes: nodes.map((n) => ({
                ...n,
                //@ts-expect-error - data property update
                data: { ...n.data, status: "idle" as NodeStatus, result: "", error: "" },
            })),
            edges: [...edges],
            createdAt: new Date().toISOString(),
        }),
        [currentWorkflowId, currentWorkflowName, nodes, edges]
    );

    const saveWorkflow = useCallback(() => {
        const workflow = buildWorkflowObj();
        setSavedWorkflows((prev) => {
            // Update existing or add new
            const exists = prev.findIndex((w) => w.id === workflow.id);
            let updated: SavedWorkflow[];
            if (exists >= 0) {
                updated = [...prev];
                updated[exists] = workflow;
            } else {
                updated = [...prev, workflow];
            }
            localStorage.setItem(LS_WORKFLOWS, JSON.stringify(updated));
            return updated;
        });
        setCurrentWorkflowId(workflow.id);
    }, [buildWorkflowObj]);

    const loadWorkflow = useCallback(
        (wf: SavedWorkflow) => {
            //@ts-expect-error - wf nodes type mismatch
            setNodes(wf.nodes);
            setEdges(wf.edges);
            setCurrentWorkflowName(wf.name);
            setCurrentWorkflowId(wf.id);
        },
        [setNodes, setEdges]
    );

    const deleteWorkflow = useCallback((wfId: string) => {
        setSavedWorkflows((prev) => {
            const updated = prev.filter((w) => w.id !== wfId);
            localStorage.setItem(LS_WORKFLOWS, JSON.stringify(updated));
            return updated;
        });
        if (currentWorkflowId === wfId) setCurrentWorkflowId(null);
    }, [currentWorkflowId]);

    const newWorkflow = useCallback(() => {
        //@ts-expect-error - nodes initialization type mismatch
        setNodes([{
            id: `start-${Date.now()}`,
            type: "workflowNode",
            position: { x: 100, y: 200 },
            data: {
                label: "Start",
                systemPrompt: DEFAULT_SYSTEM_PROMPT,
                userPrompt: DEFAULT_USER_PROMPT,
                status: "idle", result: "", error: "",
                isStartNode: true, isEndNode: false, startInput: "",
            },
        }]);
        setEdges([]);
        setCurrentWorkflowName("Untitled Workflow");
        setCurrentWorkflowId(null);
    }, [setNodes, setEdges]);

    // ── Download / Upload ──────────────────────────────────────────
    const downloadWorkflow = useCallback(() => {
        const wf = buildWorkflowObj();
        const blob = new Blob([JSON.stringify(wf, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${wf.name.replace(/[^a-zA-Z0-9]/g, "_")}.workflow.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [buildWorkflowObj]);

    const uploadWorkflow = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const wf: SavedWorkflow = JSON.parse(ev.target?.result as string);
                if (wf.nodes && wf.edges) {
                    // Ensure all nodes have the new fields
                    const fixedNodes = wf.nodes.map((n) => ({
                        ...n,
                        data: {
                            ...n.data,
                            isEndNode: n.data.isEndNode ?? false,
                            status: "idle" as NodeStatus,
                            result: "",
                            error: "",
                        },
                    }));
                    //@ts-expect-error - fixedNodes type mismatch
                    setNodes(fixedNodes);
                    setEdges(wf.edges);
                    setCurrentWorkflowName(wf.name || "Imported Workflow");
                    setCurrentWorkflowId(wf.id || `wf-${Date.now()}`);
                    // Fit view after nodes load
                    setTimeout(() => reactFlowInstance.fitView({ padding: 0.2 }), 100);
                }
            } catch (err) {
                console.error("Failed to import workflow:", err);
            }
        };
        reader.readAsText(file);
        // Reset file input
        e.target.value = "";
    }, [setNodes, setEdges, reactFlowInstance]);

    // ── Run history ────────────────────────────────────────────────
    const saveRunHistory = useCallback((entry: RunHistoryEntry) => {
        setRunHistory((prev) => {
            const updated = [entry, ...prev].slice(0, 50); // keep last 50 runs
            localStorage.setItem(LS_RUNS, JSON.stringify(updated));
            return updated;
        });
    }, []);

    const deleteRun = useCallback((runId: string) => {
        setRunHistory((prev) => {
            const updated = prev.filter((r) => r.id !== runId);
            localStorage.setItem(LS_RUNS, JSON.stringify(updated));
            return updated;
        });
    }, []);

    // ── Execute Workflow ───────────────────────────────────────────
    const executeWorkflow = useCallback(async () => {
        if (isRunning) return;
        setIsRunning(true);
        clearResults();

        const startTime = Date.now();

        // Build adjacency map
        const childMap: Record<string, { target: string; sourceHandle?: string | null }[]> = {};
        edges.forEach((e) => {
            if (!childMap[e.source]) childMap[e.source] = [];
            childMap[e.source].push({ target: e.target, sourceHandle: e.sourceHandle });
        });

        // Find start nodes
        //@ts-expect-error - nodes data property access
        const startNodes = (nodes as RFNode<WorkflowNodeData>[]).filter((n) => n.data.isStartNode);
        if (startNodes.length === 0) {
            setIsRunning(false);
            return;
        }

        const nodeResultsForHistory: Record<string, { label: string; status: NodeStatus; result: string; error: string }> = {};
        const visited = new Set<string>();

        const processNode = async (nodeId: string, inputData: string) => {
            if (visited.has(nodeId)) return;
            visited.add(nodeId);

            const node = nodes.find((n) => n.id === nodeId) as RFNode<WorkflowNodeData> | undefined;
            if (!node) return;

            // Note nodes are just for documentation, they skip execution and pass through input
            if (node.data.isNoteNode) {
                const allChildren = childMap[nodeId] || [];
                for (const child of allChildren) {
                    await processNode(child.target, inputData);
                }
                return;
            }

            // Set running
            setNodes((nds) =>
                nds.map((n) =>
                    //@ts-expect-error - status property mismatch
                    n.id === nodeId ? { ...n, data: { ...n.data, status: "running" as NodeStatus } } : n
                )
            );

            try {
                const userPrompt = renderTemplate(node.data.userPrompt, inputData);

                const res = await fetch("/api/canvas-chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        message: userPrompt,
                        variant: "standard",
                        models: [node.data.modelId || "gemma-3-27b"],
                        conversationHistory: [
                            { role: "system", content: node.data.systemPrompt },
                        ],
                    }),
                });

                const data = await res.json();

                if (data.success && data.responses?.[0]) {
                    const result = data.responses[0].content;
                    nodeResultsForHistory[nodeId] = { label: node.data.label, status: "success", result, error: "" };

                    setNodes((nds) =>
                        nds.map((n) =>
                            n.id === nodeId
                                ? { ...n, data: { ...(n.data as WorkflowNodeData), status: "success" as NodeStatus, result } }
                                : n
                        )
                    );

                    // Process children sequentially with condition handling
                    const allChildren = childMap[nodeId] || [];

                    if (node.data.isConditionNode) {
                        // AI-powered condition checking
                        const checkRes = await fetch("/api/canvas-chat", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                message: `Evaluate this condition based on the input. Return ONLY the word "TRUE" or "FALSE".\n\nInput: ${result}\nCondition: ${node.data.conditionQuery}`,
                                variant: "standard",
                                models: ["gemma-3-27b"],
                                conversationHistory: [{ role: "system", content: "You are a logic evaluator. Output only 'TRUE' or 'FALSE'." }],
                            }),
                        });
                        const checkData = await checkRes.json();
                        const isTrue = checkData.responses?.[0]?.content?.toUpperCase().includes("TRUE");

                        const targetHandle = isTrue ? "true" : "false";
                        const filteredChildren = allChildren.filter(c => c.sourceHandle === targetHandle);

                        for (const child of filteredChildren) {
                            await processNode(child.target, result);
                        }
                    } else {
                        for (const child of allChildren) {
                            await processNode(child.target, result);
                        }
                    }
                } else {
                    throw new Error(data.error || "API call failed");
                }
            } catch (err) {
                nodeResultsForHistory[nodeId] = {
                    label: node.data.label, status: "error", result: "", error: String(err),
                };
                setNodes((nds) =>
                    nds.map((n) =>
                        n.id === nodeId
                            //@ts-expect-error - status error update mismatch
                            ? { ...n, data: { ...n.data, status: "error" as NodeStatus, error: String(err) } }
                            : n
                    )
                );
            }
        };

        // Start from all start nodes in parallel
        await Promise.all(startNodes.map((sn) => processNode(sn.id, sn.data.startInput)));

        // Save run to history
        saveRunHistory({
            id: `run-${Date.now()}`,
            workflowName: currentWorkflowName,
            ranAt: new Date().toISOString(),
            duration: Date.now() - startTime,
            nodeResults: nodeResultsForHistory,
        });

        setIsRunning(false);
    }, [nodes, edges, isRunning, clearResults, setNodes, currentWorkflowName, saveRunHistory]);

    // ── Node types ─────────────────────────────────────────────────
    const nodeTypes = useMemo(() => ({ workflowNode: WorkflowNode }), []);
    const edgeTypes = useMemo(() => ({ animated: AnimatedEdge }), []);

    // ── Keyboard shortcuts ─────────────────────────────────────────
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            // Shortcuts
            if ((e.ctrlKey || e.metaKey)) {
                if (e.key === "s") {
                    e.preventDefault();
                    saveWorkflow();
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    executeWorkflow();
                }
                if (e.key === "z") {
                    e.preventDefault();
                    if (e.shiftKey) redo();
                    else undo();
                }
                if (e.key === "y") {
                    e.preventDefault();
                    redo();
                }
                if (e.key === "d") {
                    e.preventDefault();
                    // Duplicate selected nodes
                    const selectedNodes = nodes.filter(n => n.selected);
                    if (selectedNodes.length > 0) {
                        pushToHistory();
                        const newNodes = selectedNodes.map(n => ({
                            ...n,
                            id: `${n.id}-copy-${Date.now()}`,
                            position: { x: (n as any).position.x + 50, y: (n as any).position.y + 50 },
                            selected: false
                        }));
                        //@ts-expect-error - nodes duplication type mismatch
                        setNodes(nds => [...(nds as RFNode<WorkflowNodeData>[]), ...newNodes as RFNode<WorkflowNodeData>[]]);
                    }
                }
            }

            if ((e.key === "Delete" || e.key === "Backspace") && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
                deleteSelected();
            }
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [deleteSelected, saveWorkflow, executeWorkflow, undo, redo, nodes, setNodes, pushToHistory]);

    return (
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
            {/* Hidden file input for upload */}
            <input type="file" ref={fileInputRef} accept=".json" className="hidden" onChange={uploadWorkflow} />

            {/* ────────── SIDEBAR ────────── */}
            <div
                className={cn(
                    "flex flex-col border-r bg-card transition-all duration-300 shrink-0",
                    sidebarOpen ? "w-72" : "w-0 overflow-hidden border-none"
                )}
            >
                {sidebarOpen && (
                    <>
                        {/* Sidebar Header */}
                        <div className="p-4 border-b space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                    <Sparkles className="w-4 h-4 text-primary" />
                                    Workflows
                                </h2>
                                <ModeToggle />
                            </div>
                            <Input
                                value={currentWorkflowName}
                                onChange={(e) => setCurrentWorkflowName(e.target.value)}
                                className="text-sm font-semibold h-9"
                                placeholder="Workflow name..."
                            />
                        </div>

                        {/* Add Nodes */}
                        <div className="p-3 border-b space-y-1.5">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                                Add Nodes
                            </p>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={() => addNode("start")}>
                                <Zap className="w-3.5 h-3.5 text-emerald-400" /> Start Node
                            </Button>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={() => addNode("process")}>
                                <Plus className="w-3.5 h-3.5 text-blue-400" /> Processing Node
                            </Button>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={() => addNode("end")}>
                                <Flag className="w-3.5 h-3.5 text-amber-400" /> Output Node
                            </Button>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={() => addNode("condition")}>
                                <Split className="w-3.5 h-3.5 text-purple-400" /> Condition Node
                            </Button>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={() => addNode("note")}>
                                <StickyNote className="w-3.5 h-3.5 text-yellow-400" /> Note Node
                            </Button>
                        </div>

                        {/* Workflow Actions */}
                        <div className="p-3 border-b space-y-1.5">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                                Actions
                            </p>
                            <Button size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={executeWorkflow} disabled={isRunning}>
                                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                {isRunning ? "Running..." : "Run Workflow"}
                            </Button>
                            <Button variant="secondary" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={tidyWorkflow}>
                                <LayoutTemplate className="w-3.5 h-3.5" /> Tidy Workflow
                            </Button>
                            <div className="grid grid-cols-2 gap-1.5">
                                <Button variant="outline" size="sm" className="justify-start gap-1.5 text-xs h-8"
                                    onClick={saveWorkflow}>
                                    <Save className="w-3 h-3" /> Save (Ctrl+S)
                                </Button>
                                <Button variant="outline" size="sm" className="justify-start gap-1.5 text-xs h-8"
                                    onClick={newWorkflow}>
                                    <Plus className="w-3 h-3" /> New
                                </Button>
                                <Button variant="outline" size="sm" className="justify-start gap-1.5 text-xs h-8"
                                    onClick={undo} disabled={history.length === 0}>
                                    <Undo2 className="w-3 h-3" /> Undo
                                </Button>
                                <Button variant="outline" size="sm" className="justify-start gap-1.5 text-xs h-8"
                                    onClick={redo} disabled={redoHistory.length === 0}>
                                    <Redo2 className="w-3 h-3" /> Redo
                                </Button>
                                <Button variant="outline" size="sm" className="justify-start gap-1.5 text-xs h-8"
                                    onClick={downloadWorkflow}>
                                    <Download className="w-3 h-3" /> Export
                                </Button>
                                <Button variant="outline" size="sm" className="justify-start gap-1.5 text-xs h-8"
                                    onClick={() => fileInputRef.current?.click()}>
                                    <Upload className="w-3 h-3" /> Import
                                </Button>
                            </div>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={clearResults}>
                                <Trash2 className="w-3.5 h-3.5" /> Clear Results
                            </Button>
                            <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs h-8"
                                onClick={() => setShowRunHistory(true)}>
                                <History className="w-3.5 h-3.5" /> Run History ({runHistory.length})
                            </Button>
                        </div>

                        {/* Saved Workflows */}
                        <div className="flex-1 overflow-y-auto p-3">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                                Saved Workflows ({savedWorkflows.length})
                            </p>
                            {savedWorkflows.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic py-4 text-center">
                                    No saved workflows yet
                                </p>
                            ) : (
                                <div className="space-y-1.5">
                                    {savedWorkflows.map((wf) => (
                                        <div key={wf.id}
                                            className={cn(
                                                "group flex items-center gap-2 p-2 rounded-lg border transition-colors cursor-pointer",
                                                currentWorkflowId === wf.id
                                                    ? "bg-primary/10 border-primary/20"
                                                    : "bg-muted/20 hover:bg-muted/40"
                                            )}
                                            onClick={() => loadWorkflow(wf)}>
                                            <FolderOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-medium truncate">{wf.name}</p>
                                                <p className="text-[10px] text-muted-foreground">
                                                    {wf.nodes.length} nodes · {new Date(wf.createdAt).toLocaleDateString()}
                                                </p>
                                            </div>
                                            <Button variant="ghost" size="icon"
                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                                onClick={(e) => { e.stopPropagation(); deleteWorkflow(wf.id); }}>
                                                <X className="w-3 h-3" />
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Help */}
                        <div className="p-3 border-t bg-muted/10 space-y-1">
                            <p className="text-[10px] text-muted-foreground leading-relaxed">
                                <strong>Template syntax:</strong>
                            </p>
                            <div className="grid grid-cols-1 gap-0.5 text-[9px] text-muted-foreground font-mono">
                                <span><code className="bg-muted px-1 rounded">{"{{input}}"}</code> → full prev output</span>
                                <span><code className="bg-muted px-1 rounded">{"{{input.name}}"}</code> → JSON field</span>
                                <span><code className="bg-muted px-1 rounded">{"{{input.data.items}}"}</code> → nested path</span>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* ────────── CANVAS ────────── */}
            <div className="flex-1 relative">
                {/* Toggle sidebar */}
                <Button variant="outline" size="icon" className="absolute top-4 left-4 z-50 h-8 w-8"
                    onClick={() => setSidebarOpen(!sidebarOpen)}>
                    {sidebarOpen
                        ? <ChevronDown className="w-4 h-4 -rotate-90" />
                        : <ChevronRight className="w-4 h-4" />}
                </Button>

                <ReactFlow
                    //@ts-expect-error - nodes state type mismatch with RFNode
                    nodes={nodes}
                    edges={edges}
                    //@ts-expect-error - onNodesChange type mismatch
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    fitView
                    deleteKeyCode={null}
                    panOnScroll
                    selectionOnDrag
                    defaultEdgeOptions={{
                        type: "animated",
                        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)" },
                    }}
                    className="bg-background"
                >
                    <Background gap={24} size={1} color="var(--border)" style={{ opacity: 0.3 }} />
                    <Controls
                        className="!bg-card !border !border-border !rounded-lg !shadow-lg [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-muted"
                        showInteractive={false}
                    />
                    <MiniMap
                        className="!bg-card !border !border-border !rounded-lg !shadow-lg"
                        nodeColor="var(--primary)"
                        maskColor="var(--background)"
                        style={{ opacity: 0.8 }}
                    />

                    {/* Floating top-right controls */}
                    <Panel position="top-right">
                        <div className="flex items-center gap-2">
                            {!sidebarOpen && <ModeToggle />}
                            <Button size="sm" className="h-8 gap-1.5 text-xs shadow-lg"
                                onClick={executeWorkflow} disabled={isRunning}>
                                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                {isRunning ? "Running..." : "Run"}
                            </Button>
                        </div>
                    </Panel>

                    {/* Empty state */}
                    {nodes.length === 0 && (
                        <Panel position="top-center">
                            <div className="mt-20 text-center space-y-3 p-6 bg-card/80 backdrop-blur border rounded-xl shadow-lg">
                                <Sparkles className="w-8 h-8 text-primary mx-auto opacity-50" />
                                <p className="text-sm font-medium">Start building your workflow</p>
                                <p className="text-xs text-muted-foreground max-w-xs">
                                    Add a Start node, chain processing nodes, add an Output node at the end,
                                    and hit Run!
                                </p>
                                <Button size="sm" className="gap-1.5" onClick={() => addNode("start")}>
                                    <Zap className="w-3.5 h-3.5" /> Add Start Node
                                </Button>
                            </div>
                        </Panel>
                    )}
                </ReactFlow>
            </div>

            {/* ────────── RUN HISTORY MODAL ────────── */}
            {showRunHistory && (
                <RunHistoryViewer
                    runs={runHistory}
                    onClose={() => setShowRunHistory(false)}
                    onDelete={deleteRun}
                />
            )}
        </div>
    );
}