/**
 * /api/leads/score — AI-Powered Intelligent Lead Scoring
 *
 * Multi-dimensional scoring system using OpenRouter (with fallback to Gemini):
 * 1. ICP (Ideal Customer Profile) fit scoring
 * 2. Intent signal detection from recent web activity
 * 3. Firmographic scoring (company size, industry, growth stage)
 * 4. Contact quality scoring (how reachable is this person?)
 * 5. Priority ranking and hot-lead identification
 *
 * POST /api/leads/score
 * Body: { spreadsheetId, leadIds?, icp?, model? }
 *
 * GET /api/leads/score?spreadsheetId=xxx
 * Returns current scoring leaderboard
 */

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SpreadsheetStore } from '@/lib/spreadsheet-store';
import { Lead, Signal, SignalType, SignalStrength } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// ─── ICP Schemas ──────────────────────────────────────────────────────────────

export interface ICPConfig {
  /** Target job titles (e.g. ["CTO", "VP Engineering", "Head of Product"]) */
  targetRoles?: string[];
  /** Target industries (e.g. ["SaaS", "Fintech", "Healthcare"]) */
  targetIndustries?: string[];
  /** Target company sizes (e.g. ["1-10", "11-50", "51-200"]) */
  targetCompanySizes?: string[];
  /** Target geographies */
  targetLocations?: string[];
  /** Keywords that indicate high-value prospects */
  keywords?: string[];
  /** What you're selling (used by AI to assess fit) */
  productDescription?: string;
}

interface ScoreBreakdown {
  contactQuality: number;    // 0-25: email, phone, linkedin completeness
  roleRelevance: number;     // 0-25: how well role matches ICP
  companyFit: number;        // 0-25: company signals (funding, size, growth)
  intentSignals: number;     // 0-25: detected buying intent signals
  total: number;             // 0-100
}

interface ScoringResult {
  leadId: string;
  name: string;
  oldScore: number;
  newScore: number;
  breakdown: ScoreBreakdown;
  signals: Signal[];
  reasoning: string;
  priority: 'hot' | 'warm' | 'cold' | 'disqualified';
}

// ─── Deterministic Contact Quality Score ────────────────────────────────────

function scoreContactQuality(lead: Lead): number {
  let score = 0;
  if (lead.email) {
    score += 12;
    // Business email is more valuable than gmail
    if (!['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].some(d => lead.email!.includes(d))) {
      score += 5; // Work email bonus
    }
  }
  if (lead.linkedin) score += 5;
  if (lead.phone) score += 3;
  return Math.min(25, score);
}

// ─── AI-Powered Batch Scoring via OpenRouter ────────────────────────────────

async function scoreLeadsWithAI(
  leads: Lead[],
  icp: ICPConfig,
  model: string
): Promise<Array<{
  id: string;
  roleRelevance: number;
  companyFit: number;
  intentSignals: number;
  signals: Array<{ type: string; description: string; strength: string }>;
  reasoning: string;
}>> {
  const prompt = `You are a B2B sales intelligence expert specialising in lead scoring.

IDEAL CUSTOMER PROFILE (ICP):
${JSON.stringify(icp, null, 2)}

LEADS TO SCORE:
${JSON.stringify(leads.map(l => ({
  id: l.id,
  name: l.name,
  company: l.company,
  role: l.role,
  tags: l.tags,
  notes: l.notes,
  website: l.website,
  linkedin: l.linkedin,
})), null, 2)}

SCORING INSTRUCTIONS:
For each lead, assign scores out of 25 for:

1. roleRelevance (0-25): How well does their role/title match the ICP target roles?
   - Exact title match: 22-25
   - Related seniority/function: 15-21
   - Tangential: 8-14
   - Mismatch: 0-7

2. companyFit (0-25): How well does their company fit the ICP?
   - Consider: industry alignment, growth signals, company size indicators
   - Strong fit: 20-25
   - Moderate fit: 12-19
   - Weak fit: 5-11
   - Poor fit: 0-4

3. intentSignals (0-25): Detected buying intent signals from available data
   - Identify if their role/company/context suggests active purchase intent
   - Check tags/notes for hiring signals, funding, expansion, new initiatives
   - High intent: 18-25
   - Medium intent: 10-17
   - Low intent: 3-9
   - No signals: 0-2

4. signals (array): List 0-3 specific buying signals detected:
   - type: one of "job_change", "funding", "hiring", "content_engagement", "website_visit", "social_mention"
   - description: what the signal is
   - strength: "low", "medium", or "high"

5. reasoning: One sentence explaining the overall scoring rationale

Return ONLY a valid JSON array:
[
  {
    "id": "lead-uuid",
    "roleRelevance": 20,
    "companyFit": 18,
    "intentSignals": 12,
    "signals": [{"type": "hiring", "description": "Company is actively hiring engineers", "strength": "high"}],
    "reasoning": "CTO at a growing SaaS company with active hiring signals matches ICP perfectly"
  }
]`;

  // Try OpenRouter first, fall back to Gemini
  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://lead-gen-app.local',
        'X-Title': 'Lead Scoring',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);

    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const text = data.choices[0]?.message?.content || '[]';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    console.warn('[Score] OpenRouter failed, falling back to Gemini:', err);
  }

  // Gemini fallback
  const model2 = genAI.getGenerativeModel({ model: 'gemma-3-27b-it' });
  const result = await model2.generateContent(prompt);
  const text = result.response.text();
  const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(cleaned.slice(start, end + 1));
}

function classifyPriority(score: number): 'hot' | 'warm' | 'cold' | 'disqualified' {
  if (score >= 75) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 25) return 'cold';
  return 'disqualified';
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const spreadsheetId = searchParams.get('spreadsheetId');
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  if (!spreadsheetId) {
    return NextResponse.json({ success: false, message: 'spreadsheetId required' }, { status: 400 });
  }

  const spreadsheet = SpreadsheetStore.get(spreadsheetId);
  if (!spreadsheet) {
    return NextResponse.json({ success: false, message: 'Spreadsheet not found' }, { status: 404 });
  }

  const sorted = [...spreadsheet.leads].sort((a, b) => b.score - a.score);

  const leaderboard = sorted.slice(0, limit).map((lead) => ({
    id: lead.id,
    name: lead.name,
    company: lead.company,
    role: lead.role,
    email: lead.email,
    score: lead.score,
    priority: classifyPriority(lead.score),
    signalCount: lead.signals?.length || 0,
    tags: lead.tags,
  }));

  const distribution = {
    hot: sorted.filter(l => l.score >= 75).length,
    warm: sorted.filter(l => l.score >= 50 && l.score < 75).length,
    cold: sorted.filter(l => l.score >= 25 && l.score < 50).length,
    disqualified: sorted.filter(l => l.score < 25).length,
  };

  return NextResponse.json({
    success: true,
    leaderboard,
    distribution,
    totalLeads: spreadsheet.leads.length,
    averageScore: Math.round(sorted.reduce((s, l) => s + l.score, 0) / (sorted.length || 1)),
  });
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();

  const body = await request.json().catch(() => ({}));
  const {
    spreadsheetId,
    leadIds,
    icp = {} as ICPConfig,
    model = 'google/gemma-3-27b-it',
  } = body as {
    spreadsheetId?: string;
    leadIds?: string[];
    icp?: ICPConfig;
    model?: string;
  };

  if (!spreadsheetId) {
    return NextResponse.json({ success: false, message: 'spreadsheetId is required' }, { status: 400 });
  }

  const spreadsheet = SpreadsheetStore.get(spreadsheetId);
  if (!spreadsheet) {
    return NextResponse.json({ success: false, message: 'Spreadsheet not found' }, { status: 404 });
  }

  const leadsToScore = leadIds?.length
    ? spreadsheet.leads.filter(l => leadIds.includes(l.id))
    : spreadsheet.leads;

  if (leadsToScore.length === 0) {
    return NextResponse.json({ success: true, message: 'No leads to score', results: [] });
  }

  const capped = leadsToScore.slice(0, 50);
  const results: ScoringResult[] = [];
  const errors: string[] = [];

  // Process in batches of 10
  const BATCH = 10;
  for (let i = 0; i < capped.length; i += BATCH) {
    const batch = capped.slice(i, i + BATCH);

    try {
      const aiScores = await scoreLeadsWithAI(batch, icp, model);

      for (const lead of batch) {
        const aiScore = aiScores.find(s => s.id === lead.id);

        const contactQuality = scoreContactQuality(lead);
        const roleRelevance = aiScore?.roleRelevance ?? 10;
        const companyFit = aiScore?.companyFit ?? 10;
        const intentSignals = aiScore?.intentSignals ?? 5;
        const total = Math.min(100, contactQuality + roleRelevance + companyFit + intentSignals);

        const newSignals: Signal[] = (aiScore?.signals || []).map((s) => ({
          id: uuidv4(),
          type: s.type as SignalType,
          description: s.description,
          strength: s.strength as SignalStrength,
          detectedAt: new Date(),
          source: 'ai_scoring',
        }));

        // Merge new signals with existing ones (avoid duplicates by type)
        const existingSignalTypes = new Set(lead.signals?.map(s => s.type) || []);
        const uniqueNewSignals = newSignals.filter(s => !existingSignalTypes.has(s.type));
        const mergedSignals = [...(lead.signals || []), ...uniqueNewSignals];

        // Update the lead in the store
        SpreadsheetStore.updateLead(spreadsheetId, lead.id, {
          score: total,
          signals: mergedSignals,
          updatedAt: new Date(),
        });

        results.push({
          leadId: lead.id,
          name: lead.name,
          oldScore: lead.score,
          newScore: total,
          breakdown: { contactQuality, roleRelevance, companyFit, intentSignals, total },
          signals: uniqueNewSignals,
          reasoning: aiScore?.reasoning || 'Scored based on contact quality only',
          priority: classifyPriority(total),
        });
      }
    } catch (err) {
      const msg = `Batch ${i / BATCH + 1} scoring failed: ${String(err)}`;
      errors.push(msg);
      console.error('[Score]', msg);

      // Fallback: score based on contact quality only
      for (const lead of batch) {
        const contactQuality = scoreContactQuality(lead);
        const total = Math.min(100, contactQuality * 4); // scale up
        SpreadsheetStore.updateLead(spreadsheetId, lead.id, {
          score: total,
          updatedAt: new Date(),
        });
        results.push({
          leadId: lead.id,
          name: lead.name,
          oldScore: lead.score,
          newScore: total,
          breakdown: { contactQuality, roleRelevance: 0, companyFit: 0, intentSignals: 0, total },
          signals: [],
          reasoning: `Contact quality score only (AI scoring failed for batch ${i / BATCH + 1})`,
          priority: classifyPriority(total),
        });
      }
    }
  }

  const hotLeads = results.filter(r => r.priority === 'hot');

  return NextResponse.json({
    success: true,
    message: `Scored ${results.length} leads in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${hotLeads.length} hot leads identified.`,
    results,
    summary: {
      hot: hotLeads.length,
      warm: results.filter(r => r.priority === 'warm').length,
      cold: results.filter(r => r.priority === 'cold').length,
      disqualified: results.filter(r => r.priority === 'disqualified').length,
      averageScore: Math.round(results.reduce((s, r) => s + r.newScore, 0) / (results.length || 1)),
    },
    hotLeads: hotLeads.slice(0, 10),
    errors,
    spreadsheet: SpreadsheetStore.get(spreadsheetId),
    durationMs: Date.now() - t0,
  });
}
