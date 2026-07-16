/**
 * /api/leads/pipeline — Master Lead Generation Pipeline
 *
 * Orchestrates 5 stages end-to-end:
 *   1. DISCOVER   – Firecrawl /search to find candidate pages
 *   2. CRAWL      – Firecrawl /map + /scrape to harvest raw contact pages
 *   3. EXTRACT    – Gemini AI extracts structured contact data from raw text
 *   4. ENRICH     – OpenRouter LLM enriches, deduplicates and scores each lead
 *   5. STORE      – Persist final leads into the in-memory SpreadsheetStore
 *
 * POST /api/leads/pipeline
 * Body: { query, spreadsheetId, maxResults?, stages?, options? }
 */

import { NextRequest, NextResponse } from 'next/server';
import Firecrawl from '@mendable/firecrawl-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SpreadsheetStore } from '@/lib/spreadsheet-store';
import { Lead } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

// ─── Clients ────────────────────────────────────────────────────────────────

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY || '' });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Max pages to harvest in the CRAWL stage */
  maxCrawlPages?: number;
  /** Skip the map stage and only scrape the discovered URLs directly */
  skipMap?: boolean;
  /** Language filter for Firecrawl search */
  lang?: string;
  /** Country filter for Firecrawl search  */
  country?: string;
  /** How many search results to pull per query variant */
  searchLimit?: number;
  /** OpenRouter model to use for enrichment (defaults to gemini-flash via OR) */
  enrichModel?: string;
}

export interface PipelineStageResult {
  stage: string;
  durationMs: number;
  count: number;
  errors: string[];
}

export interface PipelineResponse {
  success: boolean;
  leads: Lead[];
  totalFound: number;
  stages: PipelineStageResult[];
  message: string;
  spreadsheetUpdated: boolean;
}

interface RawContactData {
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  linkedin?: string;
  twitter?: string;
  website?: string;
  phone?: string;
  location?: string;
  bio?: string;
  sourceUrl?: string;
}

// ─── Stage 1: DISCOVER ───────────────────────────────────────────────────────

/**
 * Uses Firecrawl's /search endpoint to find pages likely to contain
 * contact information for the given query. We generate several query
 * variants (email, LinkedIn, contact page, directory) to maximise recall.
 */
async function stageDiscover(
  query: string,
  opts: PipelineOptions
): Promise<{ urls: string[]; result: PipelineStageResult }> {
  const t0 = Date.now();
  const errors: string[] = [];
  const urls = new Set<string>();

  const limit = opts.searchLimit ?? 5;

  // Generate multiple search query variants to increase coverage
  const queryVariants = [
    `"${query}" email contact`,
    `${query} site:linkedin.com`,
    `${query} "gmail.com" OR "email"`,
    `${query} team page about us`,
    `${query} directory contact list`,
  ];

  for (const variant of queryVariants) {
    try {
      // Firecrawl /search returns scraped content for the top results
      const res = await (firecrawl as unknown as {
        search: (_: string, __: Record<string, unknown>) => Promise<{ success: boolean; data?: Array<{ url?: string }> }>;
      }).search(variant, {
        limit,
        lang: opts.lang || 'en',
        country: opts.country || 'us',
        scrapeOptions: { formats: ['markdown'] },
      });

      if (res.success && res.data) {
        for (const item of res.data) {
          if (item.url) urls.add(item.url);
        }
      }
    } catch (err) {
      errors.push(`DISCOVER variant "${variant}": ${String(err)}`);
    }
  }

  return {
    urls: Array.from(urls),
    result: { stage: 'DISCOVER', durationMs: Date.now() - t0, count: urls.size, errors },
  };
}

// ─── Stage 2: CRAWL ──────────────────────────────────────────────────────────

/**
 * For each discovered root URL:
 *   a) Use Firecrawl /map to find sub-pages (team, about, contact, staff, people)
 *   b) Scrape those sub-pages for raw markdown content
 * Returns an array of { url, markdown } pairs ready for AI extraction.
 */
async function stageCrawl(
  urls: string[],
  opts: PipelineOptions
): Promise<{ pages: Array<{ url: string; markdown: string }>; result: PipelineStageResult }> {
  const t0 = Date.now();
  const errors: string[] = [];
  const pages: Array<{ url: string; markdown: string }> = [];

  const CONTACT_KEYWORDS = ['contact', 'team', 'about', 'staff', 'people', 'directory', 'meet'];
  const maxPages = opts.maxCrawlPages ?? 20;

  for (const rootUrl of urls.slice(0, 15)) {
    try {
      let targetUrls: string[] = [rootUrl];

      // Skip map stage if disabled or the URL is already a deep page (linkedin, etc.)
      const isLinkedIn = rootUrl.includes('linkedin.com');
      if (!opts.skipMap && !isLinkedIn) {
        try {
          const mapRes = await (firecrawl as unknown as {
            mapUrl: (_: string, __: Record<string, unknown>) => Promise<{ success: boolean; links?: string[] }>;
          }).mapUrl(rootUrl, { limit: 30 });

          if (mapRes.success && mapRes.links) {
            // Filter to contact/team-relevant pages
            const contactPages = mapRes.links.filter((link: string) =>
              CONTACT_KEYWORDS.some((kw) => link.toLowerCase().includes(kw))
            );
            targetUrls = contactPages.length > 0 ? contactPages.slice(0, 5) : [rootUrl];
          }
        } catch {
          // Map failed, fall back to scraping root
        }
      }

      // Scrape all identified target URLs
      for (const url of targetUrls.slice(0, Math.ceil(maxPages / urls.length))) {
        try {
          const scrapeRes = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });
          if (scrapeRes.success && scrapeRes.markdown) {
            pages.push({ url, markdown: scrapeRes.markdown.slice(0, 12000) });
          }
        } catch (err) {
          errors.push(`CRAWL scrape ${url}: ${String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`CRAWL map ${rootUrl}: ${String(err)}`);
    }
  }

  return {
    pages,
    result: { stage: 'CRAWL', durationMs: Date.now() - t0, count: pages.length, errors },
  };
}

// ─── Stage 3: EXTRACT ────────────────────────────────────────────────────────

/**
 * Feed scraped markdown content to Gemini to extract structured contact
 * records. Uses a strict JSON schema prompt to ensure consistent output.
 * Batches pages to stay within token limits.
 */
async function stageExtract(
  pages: Array<{ url: string; markdown: string }>,
  query: string,
  maxResults: number
): Promise<{ contacts: RawContactData[]; result: PipelineStageResult }> {
  const t0 = Date.now();
  const errors: string[] = [];
  const allContacts: RawContactData[] = [];

  const model = genAI.getGenerativeModel({ model: 'gemma-3-27b-it' });

  // Process in batches of 3 pages to manage token usage
  const BATCH_SIZE = 3;
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);

    const contentBlock = batch
      .map((p) => `### Source: ${p.url}\n${p.markdown}`)
      .join('\n\n---\n\n');

    const prompt = `You are a highly accurate contact information extractor for lead generation.

TASK: Extract every individual person's contact information from the following scraped web content.

SEARCH CONTEXT: "${query}"

SCRAPED CONTENT:
${contentBlock}

EXTRACTION RULES:
1. Extract ONLY real people mentioned in the text — not company names or generic roles.
2. Prioritise fields found EXPLICITLY in the text.
3. DO NOT hallucinate or invent LinkedIn URLs. Only include a LinkedIn URL if it appears clearly in the content.
4. Extract Twitter/X handles only if present.
5. Include phone numbers in international format only if present.
6. Capture the source URL for each contact.
7. If a field is not found in the text, leave it empty. DO NOT invent professional-looking URLs or emails.

OUTPUT FORMAT: Return ONLY a valid JSON array. Each element:
{
  "name": "Full Name",
  "email": "email@domain.com",
  "company": "Company Name",
  "role": "Job Title",
  "linkedin": "linkedin.com/in/handle",
  "twitter": "@handle",
  "phone": "+1234567890",
  "website": "https://company.com",
  "location": "City, Country",
  "bio": "One sentence about the person",
  "sourceUrl": "https://page-where-found.com"
}

Extract up to ${Math.ceil(maxResults / Math.max(1, Math.ceil(pages.length / BATCH_SIZE)))} contacts per batch.
If no valid contacts are found, return [].`;

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();

      // Find JSON array bounds robustly
      const start = cleaned.indexOf('[');
      const end = cleaned.lastIndexOf(']');
      if (start !== -1 && end !== -1) {
        const jsonStr = cleaned.slice(start, end + 1);
        const parsed = JSON.parse(jsonStr) as RawContactData[];
        allContacts.push(...parsed);
      }
    } catch (err) {
      errors.push(`EXTRACT batch ${i}-${i + BATCH_SIZE}: ${String(err)}`);
    }
  }

  return {
    contacts: allContacts,
    result: { stage: 'EXTRACT', durationMs: Date.now() - t0, count: allContacts.length, errors },
  };
}

// ─── Stage 4: ENRICH + SCORE ─────────────────────────────────────────────────

/**
 * Uses OpenRouter (DeepSeek or Gemini via OR routing) to:
 *   1. Deduplicate contacts (merge records about the same person)
 *   2. Infer missing fields from available context
 *   3. Assign a lead quality score (0–100) based on completeness + relevance
 *   4. Classify intent signals
 */
async function stageEnrich(
  contacts: RawContactData[],
  query: string,
  maxResults: number,
  model: string
): Promise<{ leads: Lead[]; result: PipelineStageResult }> {
  const t0 = Date.now();
  const errors: string[] = [];

  if (contacts.length === 0) {
    return {
      leads: [],
      result: { stage: 'ENRICH', durationMs: Date.now() - t0, count: 0, errors },
    };
  }

  // Use OpenRouter for enrichment — gives us model flexibility
  const prompt = `You are a senior lead generation analyst. Your task is to process raw contact data and produce clean, enriched, deduplicated lead records.

ORIGINAL SEARCH QUERY: "${query}"

RAW CONTACTS (${contacts.length} records):
${JSON.stringify(contacts, null, 2)}

YOUR TASKS:
1. DEDUPLICATE: Merge records that refer to the same person (same name/email/linkedin)
2. ENRICH: For each merged record, infer plausible missing fields from available data
   - If email domain matches website, derive the email pattern
   - If LinkedIn URL is partial, normalise it to linkedin.com/in/handle format
3. SCORE each lead 0-100 based on:
   - Email present: +35 points
   - LinkedIn present: +20 points
   - Role/title present: +15 points
   - Company present: +15 points
   - Phone present: +10 points
   - Relevance to query: up to +5 points bonus
4. TAG each lead with 2-5 relevant tags based on their role/industry
5. LIMIT to top ${maxResults} records by score

OUTPUT: Return ONLY a valid JSON array. Each element:
{
  "name": "Full Name",
  "email": "email@domain.com",
  "company": "Company Name",
  "role": "Job Title",
  "linkedin": "linkedin.com/in/handle",
  "twitter": "@handle",
  "phone": "+1234567890",
  "website": "https://company.com",
  "score": 0-100,
  "tags": ["tag1", "tag2"],
  "notes": "One line enrichment note",
  "sourceUrl": "https://source-page.com"
}`;

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://lead-gen-app.local',
        'X-Title': 'Lead Generation Pipeline',
      },
      body: JSON.stringify({
        model: model || 'google/gemma-3-27b-it',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
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

    // Parse robustly — OpenRouter json_object mode may wrap array in an object
    let parsed: RawContactData[] = [];
    try {
      const raw = JSON.parse(text);
      parsed = Array.isArray(raw) ? raw : (raw.leads || raw.contacts || raw.data || []);
    } catch {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start !== -1 && end !== -1) {
        parsed = JSON.parse(text.slice(start, end + 1));
      }
    }

    const now = new Date();
    const leads: Lead[] = parsed.map((c) => ({
      id: uuidv4(),
      name: c.name || 'Unknown',
      company: c.company,
      role: c.role,
      email: c.email,
      linkedin: c.linkedin,
      twitter: c.twitter,
      website: c.website || c.sourceUrl,
      phone: c.phone,
      status: 'new' as const,
      score: typeof (c as Record<string, unknown>).score === 'number'
        ? Math.min(100, Math.max(0, (c as Record<string, unknown>).score as number))
        : 50,
      signals: [],
      tags: Array.isArray((c as Record<string, unknown>).tags) ? (c as Record<string, unknown>).tags as string[] : [],
      notes: (c as Record<string, unknown>).notes as string | undefined,
      source: 'pipeline',
      createdAt: now,
      updatedAt: now,
    }));

    return {
      leads,
      result: { stage: 'ENRICH', durationMs: Date.now() - t0, count: leads.length, errors },
    };
  } catch (err) {
    errors.push(`ENRICH: ${String(err)}`);

    // Graceful fallback: convert raw contacts to leads without enrichment
    const now = new Date();
    const fallbackLeads: Lead[] = contacts.slice(0, maxResults).map((c) => ({
      id: uuidv4(),
      name: c.name || 'Unknown',
      company: c.company,
      role: c.role,
      email: c.email,
      linkedin: c.linkedin,
      twitter: c.twitter,
      website: c.website || c.sourceUrl,
      phone: c.phone,
      status: 'new' as const,
      score: computeBaseScore(c),
      signals: [],
      tags: [],
      source: 'pipeline_fallback',
      createdAt: now,
      updatedAt: now,
    }));

    return {
      leads: fallbackLeads,
      result: { stage: 'ENRICH', durationMs: Date.now() - t0, count: fallbackLeads.length, errors },
    };
  }
}

/** Basic scoring without AI when OpenRouter fails */
function computeBaseScore(c: RawContactData): number {
  let score = 0;
  if (c.email) score += 35;
  if (c.linkedin) score += 20;
  if (c.role) score += 15;
  if (c.company) score += 15;
  if (c.phone) score += 10;
  if (c.name && c.name !== 'Unknown') score += 5;
  return Math.min(100, score);
}

// ─── Stage 5: VALIDATE & DEDUPLICATE ────────────────────────────────────────

/**
 * Final in-process deduplication and format validation before storing.
 * - Normalises email addresses to lowercase
 * - Removes leads with no email AND no linkedin (low value)
 * - Deduplicates by email, then by linkedin, then by (name + company)
 */
function stageValidate(
  leads: Lead[]
): { leads: Lead[]; result: PipelineStageResult } {
  const t0 = Date.now();
  const errors: string[] = [];

  const seenEmails = new Set<string>();
  const seenLinkedins = new Set<string>();
  const seenNameCompany = new Set<string>();

  const validated: Lead[] = [];

  for (const lead of leads) {
    // Normalise email
    if (lead.email) {
      lead.email = lead.email.toLowerCase().trim();
      // Basic email regex check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
        lead.email = undefined;
      }
    }

    // Normalise LinkedIn
    if (lead.linkedin) {
      // Strip protocol and trailing slashes
      lead.linkedin = lead.linkedin
        .replace(/^https?:\/\//i, '')
        .replace(/\/$/, '')
        .trim();
      if (!lead.linkedin.includes('linkedin.com')) {
        lead.linkedin = undefined;
      }
    }

    // Drop leads with no meaningful contact info
    if (!lead.email && !lead.linkedin && !lead.phone) {
      errors.push(`Dropped low-value lead: ${lead.name}`);
      continue;
    }

    // Deduplicate by email
    if (lead.email) {
      if (seenEmails.has(lead.email)) continue;
      seenEmails.add(lead.email);
    }

    // Deduplicate by LinkedIn
    if (lead.linkedin) {
      const li = lead.linkedin.toLowerCase();
      if (seenLinkedins.has(li)) continue;
      seenLinkedins.add(li);
    }

    // Deduplicate by name+company
    const nc = `${lead.name}___${lead.company || ''}`.toLowerCase();
    if (seenNameCompany.has(nc)) continue;
    seenNameCompany.add(nc);

    validated.push(lead);
  }

  return {
    leads: validated,
    result: {
      stage: 'VALIDATE',
      durationMs: Date.now() - t0,
      count: validated.length,
      errors,
    },
  };
}

// ─── Main Route Handler ──────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  const {
    query,
    spreadsheetId,
    maxResults = 20,
    options = {} as PipelineOptions,
  } = body as {
    query?: string;
    spreadsheetId?: string;
    maxResults?: number;
    options?: PipelineOptions;
  };

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return NextResponse.json(
      { success: false, message: 'A non-empty "query" string is required' },
      { status: 400 }
    );
  }

  const stageResults: PipelineStageResult[] = [];
  const pipelineStart = Date.now();

  try {
    // ── Stage 1: Discover ──────────────────────────────────────────────────
    const { urls, result: discoverResult } = await stageDiscover(query.trim(), options);
    stageResults.push(discoverResult);

    // ── Stage 2: Crawl ─────────────────────────────────────────────────────
    const { pages, result: crawlResult } = await stageCrawl(urls, options);
    stageResults.push(crawlResult);

    // ── Stage 3: Extract ───────────────────────────────────────────────────
    const { contacts, result: extractResult } = await stageExtract(
      pages,
      query.trim(),
      maxResults * 3 // over-extract; we trim later
    );
    stageResults.push(extractResult);

    // ── Stage 4: Enrich ────────────────────────────────────────────────────
    const { leads: enrichedLeads, result: enrichResult } = await stageEnrich(
      contacts,
      query.trim(),
      maxResults,
      options.enrichModel || 'google/gemma-3-27b-it'
    );
    stageResults.push(enrichResult);

    // ── Stage 5: Validate ──────────────────────────────────────────────────
    const { leads: finalLeads, result: validateResult } = stageValidate(enrichedLeads);
    stageResults.push(validateResult);

    // ── Store ──────────────────────────────────────────────────────────────
    let spreadsheetUpdated = false;
    if (spreadsheetId && finalLeads.length > 0) {
      const updated = SpreadsheetStore.addLeads(spreadsheetId, finalLeads);
      spreadsheetUpdated = !!updated;
    }

    const totalDuration = Date.now() - pipelineStart;

    const response: PipelineResponse = {
      success: true,
      leads: finalLeads,
      totalFound: finalLeads.length,
      stages: stageResults,
      spreadsheetUpdated,
      message: `Pipeline complete in ${(totalDuration / 1000).toFixed(1)}s — found ${finalLeads.length} leads from ${urls.length} discovered URLs, ${pages.length} scraped pages, ${contacts.length} raw contacts`,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Pipeline] Unhandled error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Pipeline failed unexpectedly',
        error: String(error),
        stages: stageResults,
      },
      { status: 500 }
    );
  }
}
