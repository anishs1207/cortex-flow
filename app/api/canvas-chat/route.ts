import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ------------------------------------------------------------------ */
/*  ENV                                                                */
/* ------------------------------------------------------------------ */

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

const genAI = new GoogleGenerativeAI(GEMINI_KEY);

/* ------------------------------------------------------------------ */
/*  MODEL REGISTRY                                                     */
/* ------------------------------------------------------------------ */

interface ModelDef {
  id: string;           // internal identifier
  displayName: string;  // shown in the UI
  provider: "gemini" | "openrouter";
  providerModel: string; // the actual model string passed to the API
}

const MODEL_REGISTRY: Record<string, ModelDef> = {
  "gemma-3-27b": {
    id: "gemma-3-27b",
    displayName: "Gemma 3 27B",
    provider: "openrouter",
    providerModel: "google/gemma-3-27b-it",
  },
  "gpt-4o": {
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "openrouter",
    providerModel: "openai/gpt-4o",
  },
  "claude-3.5": {
    id: "claude-3.5",
    displayName: "Claude 3.5",
    provider: "openrouter",
    providerModel: "anthropic/claude-3.5-sonnet",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    provider: "openrouter",
    providerModel: "deepseek/deepseek-chat",
  },
  "llama-3": {
    id: "llama-3",
    displayName: "Llama 3",
    provider: "openrouter",
    providerModel: "meta-llama/llama-3.1-70b-instruct",
  },
  "gemini-2.0": {
    id: "gemini-2.0",
    displayName: "Gemma 3 27B (Legacy Alias)",
    provider: "openrouter",
    providerModel: "google/gemma-3-27b-it",
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    displayName: "Gemma 3 27B (Legacy Alias)",
    provider: "openrouter",
    providerModel: "google/gemma-3-27b-it",
  },
};

/* ------------------------------------------------------------------ */
/*  SYSTEM PROMPT                                                      */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are a helpful, intelligent AI assistant in a multi-threaded canvas chat environment. Users can branch conversations into separate threads, compare responses across multiple AI models, and merge threads.

Key behaviors:
- Be concise yet thorough in your responses
- Use markdown formatting where appropriate (bold, lists, code blocks, etc.)
- If asked for comparisons, provide structured analysis
- If the user's message references a "branch" or prior context, treat the provided conversation history as canonical
- Be creative and insightful — the user is expecting a premium AI experience`;

/* ------------------------------------------------------------------ */
/*  PROVIDER CALL FUNCTIONS                                            */
/* ------------------------------------------------------------------ */

/**
 * Call Gemini directly using @google/generative-ai SDK.
 */
async function callGemini(
  messages: { role: string; content: string }[],
  systemPrompt: string,
  modelStr: string = "gemma-3-27b-it"
): Promise<string> {
  const model = genAI.getGenerativeModel({ model: modelStr });

  // Build a single prompt from history + system
  const historyText = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const fullPrompt = `${systemPrompt}\n\n--- Conversation ---\n${historyText}`;

  const result = await model.generateContent(fullPrompt);
  const response = await result.response;
  return response.text();
}

/**
 * Call any model via OpenRouter (unified OpenAI-compatible API).
 * Docs: https://openrouter.ai/docs
 */
async function callOpenRouter(
  messages: { role: string; content: string }[],
  systemPrompt: string,
  providerModel: string
): Promise<string> {
  if (!OPENROUTER_KEY) {
    return `⚠️ OpenRouter API key not configured. Add OPENROUTER_API_KEY to your .env file to enable ${providerModel}.`;
  }

  const openRouterMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Try with a reasonable token limit, falling back to a smaller one on 402
  const tokenLimits = [512, 256];

  for (const maxTokens of tokenLimits) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        "X-Title": "Canvas Chat",
      },
      body: JSON.stringify({
        model: providerModel,
        messages: openRouterMessages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (res.status === 402) {
      // Insufficient credits — try with fewer tokens
      console.warn(`OpenRouter 402 for ${providerModel} with max_tokens=${maxTokens}, retrying with fewer...`);
      continue;
    }

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`OpenRouter error [${providerModel}]:`, errorBody);
      return `⚠️ Error calling ${providerModel}: ${res.status} ${res.statusText}`;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "No response generated.";
  }

  return `⚠️ Insufficient OpenRouter credits for ${providerModel}. Visit https://openrouter.ai/settings/credits to add credits.`;
}

/**
 * Unified dispatcher — routes to the right provider.
 */
async function callModel(
  modelId: string,
  messages: { role: string; content: string }[],
  systemPrompt: string
): Promise<{ modelId: string; displayName: string; content: string }> {
  const def = MODEL_REGISTRY[modelId];
  if (!def) {
    return {
      modelId,
      displayName: modelId,
      content: `⚠️ Unknown model: ${modelId}`,
    };
  }

  try {
    let content: string;
    if (def.provider === "gemini") {
      content = await callGemini(messages, systemPrompt, def.providerModel);
    } else {
      content = await callOpenRouter(messages, systemPrompt, def.providerModel);
    }
    return { modelId: def.id, displayName: def.displayName, content };
  } catch (err) {
    console.error(`Error calling ${def.displayName}:`, err);
    return {
      modelId: def.id,
      displayName: def.displayName,
      content: `⚠️ Failed to get a response from ${def.displayName}. Error: ${String(err)}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  REQUEST / RESPONSE TYPES                                           */
/* ------------------------------------------------------------------ */

interface CanvasChatRequest {
  /** The user's message text */
  message: string;
  /** "standard" | "multi-model" | "panel-vote" */
  variant: "standard" | "multi-model" | "panel-vote";
  /** Which model IDs to query. For standard, this should be a single-item array. */
  models: string[];
  /** Prior conversation history for this thread */
  conversationHistory?: { role: string; content: string }[];
}

interface ModelResponse {
  modelId: string;
  displayName: string;
  content: string;
  voteCount?: number;
  isWinner?: boolean;
}

interface CanvasChatResponse {
  success: boolean;
  responses: ModelResponse[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  ROUTE HANDLER                                                      */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  try {
    const body: CanvasChatRequest = await request.json();
    const {
      message,
      variant = "standard",
      models = ["gemma-3-27b"],
      conversationHistory = [],
    } = body;

    if (!message) {
      return NextResponse.json(
        { success: false, error: "Message is required." } as CanvasChatResponse,
        { status: 400 }
      );
    }

    if (!GEMINI_KEY) {
      return NextResponse.json(
        {
          success: false,
          error:
            "GEMINI_API_KEY is not set. Please add it to your environment variables.",
          responses: [],
        } as CanvasChatResponse,
        { status: 500 }
      );
    }

    // Build the messages array including history
    const messages = [
      ...conversationHistory.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    let modelResponses: ModelResponse[] = [];

    // ─── STANDARD MODE ───────────────────────────────────────────
    if (variant === "standard") {
      const modelId = models[0] || "gemma-3-27b";
      const result = await callModel(modelId, messages, SYSTEM_PROMPT);
      modelResponses = [
        {
          modelId: result.modelId,
          displayName: result.displayName,
          content: result.content,
        },
      ];
    }

    // ─── MULTI-MODEL MODE ────────────────────────────────────────
    //  Call up to N models in parallel and return all results.
    else if (variant === "multi-model") {
      const selectedModels =
        models.length > 0 ? models : ["gemma-3-27b", "gpt-4o", "claude-3.5"];

      const results = await Promise.allSettled(
        selectedModels.map((id) => callModel(id, messages, SYSTEM_PROMPT))
      );

      modelResponses = results.map((r, idx) => {
        if (r.status === "fulfilled") {
          return {
            modelId: r.value.modelId,
            displayName: r.value.displayName,
            content: r.value.content,
          };
        }
        return {
          modelId: selectedModels[idx],
          displayName: selectedModels[idx],
          content: `⚠️ Model failed to respond: ${r.reason}`,
        };
      });
    }

    // ─── PANEL-VOTE MODE ─────────────────────────────────────────
    //  Call ALL registered models, then score/rank them.
    else if (variant === "panel-vote") {
      const allModelIds =
        models.length > 0 ? models : Object.keys(MODEL_REGISTRY);

      const results = await Promise.allSettled(
        allModelIds.map((id) => callModel(id, messages, SYSTEM_PROMPT))
      );

      // Build responses
      const rawResponses: ModelResponse[] = results.map((r, idx) => {
        if (r.status === "fulfilled") {
          return {
            modelId: r.value.modelId,
            displayName: r.value.displayName,
            content: r.value.content,
            voteCount: 0,
            isWinner: false,
          };
        }
        return {
          modelId: allModelIds[idx],
          displayName: allModelIds[idx],
          content: `⚠️ Model failed to respond: ${r.reason}`,
          voteCount: 0,
          isWinner: false,
        };
      });

      // Ask Gemini to judge and score the responses
      try {
        const judgingPrompt = `You are an impartial judge evaluating AI responses. Given the user's question and multiple AI responses, score each response from 0-100 based on accuracy, helpfulness, and quality.

User Question: "${message}"

Responses to evaluate:
${rawResponses
  .map(
    (r, i) =>
      `--- Response ${i + 1} (${r.displayName}) ---\n${r.content.slice(0, 500)}`
  )
  .join("\n\n")}

Return ONLY a JSON array of scores in order, like: [85, 72, 90, 65, 78]
Return the array with exactly ${rawResponses.length} numbers. No other text.`;

        const judgeResult = await callGemini(
          [{ role: "user", content: judgingPrompt }],
          "You are a scoring judge. Return ONLY a JSON array of integers.",
          "gemma-3-27b-it"
        );

        // Parse scores
        const scoreMatch = judgeResult.match(/\[[\d\s,]+\]/);
        if (scoreMatch) {
          const scores: number[] = JSON.parse(scoreMatch[0]);
          rawResponses.forEach((r, i) => {
            r.voteCount = scores[i] ?? Math.floor(Math.random() * 100);
          });
        } else {
          // Fallback: heuristic scoring based on response length & structure
          rawResponses.forEach((r) => {
            const lengthScore = Math.min(50, r.content.length / 20);
            const structureScore = (r.content.match(/\n/g)?.length || 0) * 2;
            r.voteCount = Math.min(
              100,
              Math.floor(lengthScore + structureScore + Math.random() * 20)
            );
          });
        }
      } catch {
        // Fallback scoring
        rawResponses.forEach((r) => {
          r.voteCount = Math.floor(40 + Math.random() * 60);
        });
      }

      // Determine winner
      const maxScore = Math.max(
        ...rawResponses.map((r) => r.voteCount || 0)
      );
      rawResponses.forEach((r) => {
        if (r.voteCount === maxScore) r.isWinner = true;
      });

      modelResponses = rawResponses;
    }

    return NextResponse.json({
      success: true,
      responses: modelResponses,
    } as CanvasChatResponse);
  } catch (error) {
    console.error("Canvas chat error:", error);
    return NextResponse.json(
      {
        success: false,
        error: `Internal server error: ${String(error)}`,
        responses: [],
      } as CanvasChatResponse,
      { status: 500 }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  GET — list available models & their status                         */
/* ------------------------------------------------------------------ */

export async function GET() {
  const models = Object.values(MODEL_REGISTRY).map((m) => ({
    id: m.id,
    displayName: m.displayName,
    provider: m.provider,
    available:
      m.provider === "gemini" ? !!GEMINI_KEY : !!OPENROUTER_KEY,
  }));

  return NextResponse.json({
    models,
    hasGemini: !!GEMINI_KEY,
    hasOpenRouter: !!OPENROUTER_KEY,
  });
}
