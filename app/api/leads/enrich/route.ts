/**
 * /api/leads/enrich — Stage 4: AI-Powered Lead Enrichment
 *
 * Standalone endpoint to enrich existing leads in a spreadsheet using
 * OpenRouter (multi-model access) for:
 *   1. Deep profile enrichment (infer missing fields from available data)
 *   2. Rescoring based on completeness + industry relevance
 *   3. Context-aware tagging
 *   4. Deduplication merging
 *
 * Also performs live re-scraping of lead websites to find updated info.
 *
 * POST /api/leads/enrich
 * Body: { spreadsheetId, leadIds?, model?, rescrape? }
 */

import { NextRequest, NextResponse } from 'next/server';
import Firecrawl from '@mendable/firecrawl-js';
import { SpreadsheetStore } from '@/lib/spreadsheet-store';
import { Lead } from '@/lib/types';

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY || '' });
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

interface EnrichmentResult {
  leadId: string;
  name: string;
  fieldsAdded: string[];
  oldScore: number;
  newScore: number;
  error?: string;
}

/**
 * Scrape a lead's website/LinkedIn to find updated contact info.
 * Returns markdown content or null if scraping fails/unavailable.
 */
async function scrapeLeadProfile(lead: Lead): Promise<string | null> {
  const urls: string[] = [];

  // Prefer the company website for contact info
  if (lead.website) urls.push(lead.website);

  // LinkedIn is a rich source but often blocked — try anyway
  if (lead.linkedin) {
    const li = lead.linkedin.startsWith('http') ? lead.linkedin : `https://${lead.linkedin}`;
    urls.push(li);
  }

  for (const url of urls) {
    try {
      const res = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });
      if (res.success && res.markdown) {
        return res.markdown.slice(0, 8000);
      }
    } catch {
      // Try next URL
    }
  }

  return null;
}

/**
 * Call OpenRouter to enrich a batch of leads.
 * Returns enriched lead objects with updated fields and scores.
 */
async function enrichWithOpenRouter(
  leads: Lead[],
  additionalContext: Map<string, string | null>,
  model: string
): Promise<Array<Partial<Lead> & { id: string; fieldsAdded: string[] }>> {
  const leadsWithContext = leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    email: lead.email,
    company: lead.company,
    role: lead.role,
    linkedin: lead.linkedin,
    twitter: lead.twitter,
    website: lead.website,
    phone: lead.phone,
    score: lead.score,
    tags: lead.tags,
    notes: lead.notes,
    scrapedContext: additionalContext.get(lead.id)?.slice(0, 3000) || null,
  }));

  const prompt = `You are a B2B lead enrichment expert. For each lead below, enrich and update their profile using:
1. The existing fields already populated
2. The "scrapedContext" if available (live scraped data from their website/LinkedIn)
3. Logical inference (e.g. if company is known, infer industry; if role is CEO, score higher)

LEADS TO ENRICH:
${JSON.stringify(leadsWithContext, null, 2)}

ENRICHMENT INSTRUCTIONS:
- Fill missing email if scrapedContext contains one (email pattern: name@company.com)
- Fill missing LinkedIn by searching for the pattern linkedin.com/in/firstname-lastname
- Infer company website from email domain or company name
- Assign tags from: ["founder", "cto", "ceo", "vp", "director", "manager", "developer", "designer", "marketer", "sales", "finance", "hr", "startup", "enterprise", "saas", "fintech", "healthtech", "ecommerce", "agency"]
- Score formula: email(35pts) + linkedin(20pts) + role(15pts) + company(15pts) + phone(10pts) + bonus for high-value titles/industries(up to 5pts)
- Write a short "notes" enrichment summary (1 sentence)

CRITICAL: Return ONLY a JSON array. Each element must include the lead "id" and ONLY the fields you changed/enriched plus "score" and "fieldsAdded":
[
  {
    "id": "lead-uuid",
    "email": "enriched@email.com",
    "linkedin": "linkedin.com/in/handle",
    "website": "https://company.com",
    "tags": ["tag1", "tag2"],
    "score": 75,
    "notes": "Enrichment note",
    "fieldsAdded": ["email", "linkedin", "tags"]
  }
]

If a lead cannot be enriched, include only { "id": "...", "fieldsAdded": [] }.`;

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://lead-gen-app.local',
      'X-Title': 'Lead Enrichment',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.15,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices[0]?.message?.content || '[]';

  // Robust JSON extraction
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  return JSON.parse(text.slice(start, end + 1));
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();

  const body = await request.json().catch(() => ({}));
  const {
    spreadsheetId,
    leadIds,
    model = 'google/gemma-3-27b-it',
    rescrape = false,
  } = body as {
    spreadsheetId?: string;
    leadIds?: string[];
    model?: string;
    rescrape?: boolean;
  };

  if (!spreadsheetId) {
    return NextResponse.json(
      { success: false, message: 'spreadsheetId is required' },
      { status: 400 }
    );
  }

  const spreadsheet = SpreadsheetStore.get(spreadsheetId);
  if (!spreadsheet) {
    return NextResponse.json(
      { success: false, message: 'Spreadsheet not found' },
      { status: 404 }
    );
  }

  // Select which leads to enrich
  const leadsToEnrich = leadIds?.length
    ? spreadsheet.leads.filter((l) => leadIds.includes(l.id))
    : spreadsheet.leads;

  if (leadsToEnrich.length === 0) {
    return NextResponse.json({
      success: true,
      message: 'No leads to enrich',
      results: [],
      durationMs: 0,
    });
  }

  // Cap at 25 leads per call to manage costs/latency
  const capped = leadsToEnrich.slice(0, 25);

  // Optionally re-scrape lead profiles for fresh context
  const contextMap = new Map<string, string | null>();
  if (rescrape) {
    await Promise.allSettled(
      capped.map(async (lead) => {
        const content = await scrapeLeadProfile(lead);
        contextMap.set(lead.id, content);
      })
    );
  }

  // Process in batches of 8 leads  
  const BATCH_SIZE = 8;
  const enrichmentResults: EnrichmentResult[] = [];
  const errors: string[] = [];

  for (let i = 0; i < capped.length; i += BATCH_SIZE) {
    const batch = capped.slice(i, i + BATCH_SIZE);

    try {
      const enriched = await enrichWithOpenRouter(batch, contextMap, model);

      for (const update of enriched) {
        const lead = batch.find((l) => l.id === update.id);
        if (!lead) continue;

        const { id, fieldsAdded, ...updateData } = update;
        const oldScore = lead.score;

        // Apply enrichment to store
        SpreadsheetStore.updateLead(spreadsheetId, id, {
          ...updateData,
          updatedAt: new Date(),
        } as Partial<Lead>);

        enrichmentResults.push({
          leadId: id,
          name: lead.name,
          fieldsAdded: fieldsAdded || [],
          oldScore,
          newScore: updateData.score ?? oldScore,
        });
      }
    } catch (err) {
      const errMsg = `Batch ${i / BATCH_SIZE + 1} failed: ${String(err)}`;
      errors.push(errMsg);
      console.error('[Enrich]', errMsg);
    }
  }

  const updated = SpreadsheetStore.get(spreadsheetId);

  return NextResponse.json({
    success: true,
    message: `Enriched ${enrichmentResults.length}/${capped.length} leads in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    results: enrichmentResults,
    spreadsheet: updated,
    errors,
    durationMs: Date.now() - t0,
  });
}
