/**
 * Span fetch for the knowledge graph, via LaunchDarkly's hosted observability
 * MCP endpoint (https://mcp.launchdarkly.com/mcp/observability) — the
 * documented programmatic surface for o11y queries. MCP-over-HTTP is two
 * JSON-RPC POSTs (initialize → tools/call query-traces), authenticated with
 * the same LD API key the pipeline already holds; no extra credentials.
 *
 * FAIL-SOFT BY CONTRACT: this function never throws. Missing telemetry, auth
 * problems, network errors, or shape drift all resolve to `{ spans: [],
 * warning }` — the pipeline warns and runs un-enriched rather than failing a
 * PR over an observability read (ADR 0010). When LaunchDarkly ships a
 * first-party service-map read API, this module is what it replaces.
 */

import type { SpanRecord } from "./traceEdges.js";

export const DEFAULT_O11Y_MCP_URL = "https://mcp.launchdarkly.com/mcp/observability";

export interface FetchSpansOptions {
  /** LaunchDarkly API key (api-…). */
  apiKey: string;
  /** Project whose telemetry to read — the APP project (services' SDK key project). */
  projectKey: string;
  /** MCP endpoint override (LD_O11Y_MCP_URL). */
  url?: string;
  /** Look-back window, capped at 24h by the traces tool's contract. */
  windowHours?: number;
  /** Max spans to fetch across pages (default 200). */
  maxSpans?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * Backoff before each retry after a failed attempt (default [500, 1500] —
   * 3 attempts total). The hosted o11y gateway occasionally rejects a valid
   * token with a transient 401; one blip must not cost a run its service
   * edges. Pass [] to disable retries (tests).
   */
  retryDelaysMs?: number[];
}

export interface FetchSpansResult {
  spans: SpanRecord[];
  /** Set when the fetch degraded — surface it, don't fail the run. */
  warning?: string;
}

interface McpToolCallResult {
  result?: {
    structuredContent?: {
      traces?: { edges?: { node?: RawTraceNode }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
    };
    /** Tool errors arrive as text content with HTTP 200 — must be inspected. */
    content?: { type?: string; text?: string }[];
  };
  error?: { message?: string };
}

/**
 * The gateway reports upstream failures as HTTP 200 + a JSON error inside the
 * text content (no structuredContent). Surface that as the real reason —
 * "auth failed" must never masquerade as "no telemetry".
 */
function embeddedToolError(json: McpToolCallResult): string | undefined {
  if (json.result?.structuredContent?.traces) return undefined;
  const text = json.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed.error) return typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
  } catch {
    /* not JSON — fall through */
  }
  return undefined;
}

interface RawTraceNode {
  serviceName?: string;
  spanKind?: string;
  spanName?: string;
  traceAttributes?: SpanRecord["traceAttributes"];
}

/** Map one traces-query node to the SpanRecord the edge derivation consumes. */
export function toSpanRecord(node: RawTraceNode): SpanRecord {
  return {
    ...(node.serviceName ? { serviceName: node.serviceName } : {}),
    ...(node.spanKind ? { spanKind: node.spanKind } : {}),
    ...(node.traceAttributes ? { traceAttributes: node.traceAttributes } : {}),
  };
}

async function mcpPost(
  url: string,
  apiKey: string,
  sessionId: string | undefined,
  body: Record<string, unknown>,
): Promise<{ json: McpToolCallResult; sessionId?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // Bearer + a regular LD api- key works headlessly (verified live from
      // CI). LD_O11Y_AUTH overrides the full header value if the gateway's
      // scheme ever changes; failures degrade to a warning, never a blocked run.
      Authorization: process.env.LD_O11Y_AUTH ?? `Bearer ${apiKey}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`o11y MCP ${res.status} ${res.statusText}`);
  const newSession = res.headers.get("mcp-session-id") ?? undefined;
  const text = await res.text();
  // Streamable-HTTP servers may reply as a one-event SSE stream; unwrap it.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? (text.split(/\r?\n/).find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "{}")
    : text;
  return { json: JSON.parse(payload) as McpToolCallResult, ...(newSession ? { sessionId: newSession } : {}) };
}

/** Fetch recent spans for the project. Never throws — see module contract. */
export async function fetchRecentSpans(opts: FetchSpansOptions): Promise<FetchSpansResult> {
  const url = opts.url ?? process.env.LD_O11Y_MCP_URL ?? DEFAULT_O11Y_MCP_URL;
  const windowHours = Math.min(opts.windowHours ?? 24, 24);
  const retryDelaysMs = opts.retryDelaysMs ?? [500, 1500];

  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelaysMs[attempt - 1]));
    try {
      const spans = await fetchSpansOnce(url, opts, windowHours);
      if (spans.length === 0) {
        return {
          spans,
          warning:
            `no observability spans found for project '${opts.projectKey}' in the last ${windowHours}h — ` +
            `service-dependency edges unavailable. Instrument the services with the LaunchDarkly observability ` +
            `SDKs (and keep some traffic flowing) to light this up.`,
        };
      }
      return { spans };
    } catch (e) {
      lastError = e;
    }
  }
  const attempts = retryDelaysMs.length + 1;
  return {
    spans: [],
    warning:
      `observability trace query failed after ${attempts} attempt${attempts === 1 ? "" : "s"} ` +
      `(${lastError instanceof Error ? lastError.message : String(lastError)}) — proceeding without service-dependency edges.`,
  };
}

/** One initialize + query-traces round trip. Throws on any failure. */
async function fetchSpansOnce(
  url: string,
  opts: FetchSpansOptions,
  windowHours: number,
): Promise<SpanRecord[]> {
  const maxSpans = opts.maxSpans ?? 200;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const startDate = new Date(nowMs - windowHours * 3_600_000).toISOString();

  const init = await mcpPost(url, opts.apiKey, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "auto-factory-knowledge-graph", version: "1" },
    },
  });
  const sessionId = init.sessionId;

  const spans: SpanRecord[] = [];
  let id = 2;
  let hasNext = true;
  while (hasNext && spans.length < maxSpans) {
    const call = await mcpPost(url, opts.apiKey, sessionId, {
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: {
        name: "query-traces",
        arguments: { projectKey: opts.projectKey, startDate, limit: 50 },
      },
    });
    if (call.json.error) throw new Error(call.json.error.message ?? "o11y MCP tool error");
    const embedded = embeddedToolError(call.json);
    if (embedded) throw new Error(embedded.slice(0, 200));
    const traces = call.json.result?.structuredContent?.traces;
    const nodes = (traces?.edges ?? []).map((e) => e.node).filter((n): n is RawTraceNode => !!n);
    spans.push(...nodes.map(toSpanRecord));
    hasNext = traces?.pageInfo?.hasNextPage === true && nodes.length > 0;
    // The traces tool pages by cursor we don't thread yet; one page of the
    // most recent spans is enough signal for service edges. Stop after one
    // page unless nothing came back at all.
    if (nodes.length > 0) break;
  }

  return spans;
}
