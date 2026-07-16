import { NextRequest, NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

// Date: 2026-03-22
// Purpose: Generate a viral short-form narration script using Gemini via the
// Vercel AI SDK (@ai-sdk/google). This uses the v1 REST endpoint which has
// separate quota tracking from the older v1beta endpoint.

export async function POST(request: NextRequest) {
  try {
    // Step 1: Validate API key at request time
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server configuration error: GEMINI_API_KEY is missing from .env" },
        { status: 500 }
      );
    }

    // Step 2: Parse and validate request body
    const { topic } = await request.json();
    if (!topic || typeof topic !== "string") {
      return NextResponse.json(
        { error: "A valid 'topic' string is required." },
        { status: 400 }
      );
    }

    // Step 3: Build the narration script prompt
    const promptText = `You are a viral short-form video scriptwriter. Write a voiceover script for a 30–60 second explainer video about:

"${topic}"

Rules:
- Casual, engaging Gen-Z YouTube creator tone
- Each sentence SHORT and punchy (max 12 words)
- 8–12 sentences total
- No camera directions, speaker labels, or brackets
- Start with an instant hook ("Did you know..." or "Here's the thing about...")
- Output ONLY the raw narration text, nothing else

Write the script now:`;

    const MODELS_TO_TRY = [
      "gemini-2.5-flash",      
  
    ];

    let scriptText = "";
    let lastError: Error | null = null;

    for (const modelId of MODELS_TO_TRY) {
      try {
        console.log(`[explainer-video] Attempting model: ${modelId}`);
        const { text } = await generateText({
          model: google(modelId as string),
          prompt: promptText,
        });
        scriptText = text.trim();
        console.log(`[explainer-video] ✅ Success with ${modelId}`);
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[explainer-video] ⚠️ ${modelId} failed: ${msg.slice(0, 100)}`);
        lastError = err instanceof Error ? err : new Error(msg);
        // Continue ONLY if it's a quota or model-not-found error
        const isQuotaErr = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isMissingErr = msg.includes("404") || msg.toLowerCase().includes("not found");
        if (!isQuotaErr && !isMissingErr) break;
      }
    }

    if (!scriptText) {
      throw lastError || new Error("All models failed. Check your API key and quota.");
    }

    // Step 5: Return result
    return NextResponse.json({ script: scriptText });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[explainer-video] Script generation failed:", message);
    return NextResponse.json({ error: `Script generation failed: ${message}` }, { status: 500 });
  }
}
