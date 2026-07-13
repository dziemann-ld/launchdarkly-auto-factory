/**
 * LaunchDarkly resource writer for the agent write tools.
 *
 * Programmatic flag + metric creation are REST operations (no SDK creates them),
 * so this wraps the `api-`-key `LdClient` pointed at the APP/data-plane project.
 * Kept tiny and idempotent: LaunchDarkly returns 409 when the resource already
 * exists (PR re-runs on synchronize), which we report rather than treat as an
 * error.
 */

import type { LdClient } from "../ldClient.js";
import type { Scope } from "../types.js";

export interface CreateFlagArgs {
  /** Flag key (e.g. "enable-farewell"). */
  key: string;
  /** Human-readable name. Defaults to the key. */
  name?: string;
  description?: string;
  /** Extra tags, merged with the standard auto-factory tags. */
  tags?: string[];
  /**
   * Release scope from `.release-flags/*.json`. When `frontend` or `fullstack`,
   * the flag is exposed to the client-side SDK (browser/mobile web). Backend-only
   * flags stay server-side.
   */
  scope?: Scope;
}

/** Frontend and fullstack flags are evaluated in browser SDKs — must be client-visible. */
export function scopeNeedsClientSide(scope?: Scope): boolean {
  return scope === "frontend" || scope === "fullstack";
}

/**
 * Guarded-release metric categories. Each maps to a LaunchDarkly metric shape:
 *  - error    → occurrence (isNumeric=false), LowerThanBaseline
 *  - latency  → numeric (isNumeric=true, unit, average aggregation), LowerThanBaseline
 *  - business → occurrence (isNumeric=false), HigherThanBaseline
 */
export type MetricCategory = "error" | "latency" | "business";

export interface CreateMetricArgs {
  /** Metric key, e.g. "enable-fact-endpoint-error-rate". */
  key: string;
  /** Custom event name the app emits via `track()` — what the metric measures.
   *  Required for event-backed metrics; ignored when `traceQuery` is set. */
  eventKey?: string;
  category: MetricCategory;
  /** Human-readable name. Defaults to the key. */
  name?: string;
  description?: string;
  /** Randomization unit; MUST match the flag rollout's unit. Default "user". */
  randomizationUnit?: string;
  /** Numeric unit (latency only). Default "ms". */
  unit?: string;
  /**
   * TRACE-BACKED metric (ADR 0010): an observability span filter, e.g.
   * "service_name=togglemart-gateway AND span_name=\"GET /api/storefront\"".
   * Only valid when the flag is evaluated INSIDE the matched trace (the o11y
   * SDK's afterEvaluation hook enriches the span) — otherwise the metric
   * cannot attribute. When set, the metric is created as kind=trace with no
   * eventKey; latency-category trace metrics measure `traceValueLocation`.
   */
  traceQuery?: string;
  /** Numeric value source for latency trace metrics. Default "duration". */
  traceValueLocation?: string;
  /** Extra tags, merged with the standard auto-factory tags. */
  tags?: string[];
}

export interface LdWriteResult {
  created: boolean;
  alreadyExists: boolean;
  key: string;
  detail: string;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export class LdResourceWriter {
  constructor(private readonly ld: LdClient) {}

  get projectKey(): string {
    return this.ld.projectKey;
  }

  /**
   * Create a boolean feature flag (treatment=true / control=false) following the
   * AutoFactory convention: temporary, off-variation = control (safe default).
   */
  async createBooleanFlag(args: CreateFlagArgs): Promise<LdWriteResult> {
    if (!args.key) throw new Error("flag key is required");
    const clientSide = scopeNeedsClientSide(args.scope);
    const body = {
      key: args.key,
      name: args.name || args.key,
      ...(args.description ? { description: args.description } : {}),
      temporary: true,
      tags: dedupe(["auto-factory", "auto-generated", ...(args.tags ?? [])]),
      variations: [
        { value: true, name: "Treatment" },
        { value: false, name: "Control" },
      ],
      // On = treatment (index 0); Off = control (index 1) — flag-off preserves existing behavior.
      defaults: { onVariation: 0, offVariation: 1 },
      ...(clientSide
        ? { clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: false } }
        : {}),
    };
    const res = await this.ld.createFlag(body);
    const alreadyExists = res.status === 409;
    if (clientSide && alreadyExists) {
      await this.ensureClientSideAvailability(args.key);
    }
    const clientSideNote = clientSide ? " Client-side SDK availability enabled." : "";
    return {
      created: !alreadyExists,
      alreadyExists,
      key: args.key,
      detail: alreadyExists
        ? `Flag '${args.key}' already exists in project '${this.ld.projectKey}' (no change).${clientSideNote}`
        : `Created flag '${args.key}' in project '${this.ld.projectKey}'.${clientSideNote}`,
    };
  }

  /** Idempotent: turn on client-side ID availability for an existing flag. */
  private async ensureClientSideAvailability(flagKey: string): Promise<void> {
    await this.ld.patchFlagProjectSemantic(
      flagKey,
      [{ kind: "turnOnClientSideAvailability", value: "usingEnvironmentId" }],
      "AutoFactory: expose frontend-scoped flag to client-side SDK",
    );
  }

  /**
   * Create a guarded-release metric off a custom event. Maps the friendly
   * category to LaunchDarkly's metric fields (kind=custom, isNumeric/unit,
   * successCriteria). Idempotent: a 409 (key already exists) is reported, not thrown.
   */
  async createMetric(args: CreateMetricArgs): Promise<LdWriteResult> {
    if (!args.key) throw new Error("metric key is required");
    const trace = Boolean(args.traceQuery);
    if (!trace && !args.eventKey) throw new Error("metric eventKey is required (or pass traceQuery for a trace-backed metric)");
    const numeric = args.category === "latency";
    const successCriteria = args.category === "business" ? "HigherThanBaseline" : "LowerThanBaseline";
    const unit = args.randomizationUnit || "user";
    const body: Record<string, unknown> = {
      key: args.key,
      name: args.name || args.key,
      ...(args.description ? { description: args.description } : {}),
      isNumeric: numeric,
      successCriteria,
      randomizationUnits: [unit],
      tags: dedupe(["auto-factory", "auto-generated", ...(args.tags ?? [])]),
      // Numeric (latency) metrics need a unit + an aggregation; occurrence metrics don't.
      ...(numeric ? { unit: args.unit || "ms", unitAggregationType: "average" } : {}),
      ...(trace
        ? {
            // Trace-backed (verified against the live API, 2026-07-13): the
            // regular metrics POST with kind=trace + a span filter; numeric
            // metrics read their value from traceValueLocation.
            kind: "trace",
            traceQuery: args.traceQuery,
            dataSource: { key: "launchdarkly-hosted" },
            analysisType: "mean",
            eventDefault: { disabled: false, value: 0 },
            ...(numeric ? { traceValueLocation: args.traceValueLocation || "duration" } : { unitAggregationType: "sum" }),
          }
        : { kind: "custom", eventKey: args.eventKey }),
    };
    const res = await this.ld.createMetric(body);
    const alreadyExists = res.status === 409;
    return {
      created: !alreadyExists,
      alreadyExists,
      key: args.key,
      detail: alreadyExists
        ? `Metric '${args.key}' already exists in project '${this.ld.projectKey}' (no change).`
        : trace
          ? `Created ${args.category} TRACE metric '${args.key}' (traceQuery: ${args.traceQuery}) in project '${this.ld.projectKey}'.`
          : `Created ${args.category} metric '${args.key}' (event '${args.eventKey}') in project '${this.ld.projectKey}'.`,
    };
  }
}
