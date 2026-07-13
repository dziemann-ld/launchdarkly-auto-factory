/**
 * LaunchDarkly LLM Observability helpers.
 *
 * LD's LLM Observability is OpenTelemetry-based (GenAI semantic conventions). The
 * `Observability` plugin (registered on the server SDK in ldSdk.ts) sets up the
 * global OTel tracer + an exporter to LaunchDarkly's OTLP endpoint. We then emit a
 * span per agent run with `gen_ai.*` attributes so each LLM call shows up in LD's
 * LLM Observability views, correlated to the AgentControl config that produced it.
 *
 * The Cursor provider needs MANUAL spans: inference happens inside Cursor's hosted
 * service, so there's no local LLM SDK for the plugin to auto-instrument — we set
 * the attributes ourselves from what `RunResult` gives us (model, token usage,
 * duration). All helpers here are defensive: telemetry must never break a run.
 */

import * as nodeModule from "node:module";
import type { LDAIConfigTracker } from "@launchdarkly/server-sdk-ai";
import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { pipelineRunId } from "./ldSdk.js";

const TRACER_NAME = "launchdarkly-auto-factory";
/** Cap prompt/completion content recorded on a span so spans stay bounded. */
const MAX_CONTENT = 8000;

/**
 * `@opentelemetry/api` is loaded LAZILY with a no-op fallback, and stays
 * `--external` in the action bundle. Both halves matter:
 *
 *  - External because the OTel API is a SINGLETON: the (also-external, lazily
 *    loaded) `@launchdarkly/observability-node` plugin registers the global
 *    tracer on the node_modules copy of the API — bundling our own inline copy
 *    would read a different global registry and silently drop every span on
 *    the checkout+`npm ci` workflow variants.
 *  - Lazy because the bare `uses:` action form runs the bundle with NO
 *    node_modules at all. A static import of an external package is eager in
 *    ESM — the bundle couldn't even load (ERR_MODULE_NOT_FOUND). In that mode
 *    the observability plugin is absent anyway, so a no-op tracer loses
 *    nothing: telemetry must never be the reason a run can't start.
 */
type OtelApi = {
  trace: { getTracer(name: string): Tracer };
  SpanKind: typeof import("@opentelemetry/api").SpanKind;
  SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
};

const NOOP_SPAN = {
  setAttribute() { return NOOP_SPAN; },
  setAttributes() { return NOOP_SPAN; },
  setStatus() { return NOOP_SPAN; },
  recordException() {},
  addEvent() { return NOOP_SPAN; },
  updateName() { return NOOP_SPAN; },
  end() {},
  isRecording() { return false; },
  spanContext() { return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }; },
} as unknown as Span;

function loadOtelApi(): OtelApi {
  try {
    // Namespace import: the action bundle's banner already declares a
    // top-level `createRequire` binding; a named import would collide.
    return nodeModule.createRequire(import.meta.url)("@opentelemetry/api") as OtelApi;
  } catch {
    return {
      trace: { getTracer: () => ({ startSpan: () => NOOP_SPAN }) as unknown as Tracer },
      // Values mirror the OTel API enums so recorded constants stay comparable.
      SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 } as OtelApi["SpanKind"],
      SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 } as OtelApi["SpanStatusCode"],
    };
  }
}

const otel = loadOtelApi();
export const SpanKind = otel.SpanKind;
export const SpanStatusCode = otel.SpanStatusCode;

/**
 * The AutoFactory OTel tracer. When the Observability plugin is registered this
 * is backed by LD's exporter; otherwise it's the OTel no-op tracer (or our shim
 * when the API package itself is absent), so callers can always create spans
 * without checking whether observability is enabled.
 */
export function aiTracer(): Tracer {
  return otel.trace.getTracer(TRACER_NAME);
}

function truncate(s: string): string {
  return s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…[truncated]` : s;
}

export interface GenAiSpanData {
  /** gen_ai.system / gen_ai.provider — the execution backend, e.g. "cursor". */
  provider: string;
  /** gen_ai.request.model — the model actually run (e.g. the resolved Cursor model id). */
  requestModel: string;
  /** The node's AI-config tracker, for correlating the span to the AgentControl config. */
  tracker?: LDAIConfigTracker;
  /** The rendered prompt sent to the model (recorded as gen_ai.input, truncated). */
  prompt?: string;
  /** The model's final output (recorded as gen_ai.output, truncated). */
  output?: string;
  /** Token usage from the provider, if reported. */
  usage?: { input: number; output: number; total: number };
}

/**
 * Set GenAI + LaunchDarkly-AI-config attributes on a span. Both the OTel GenAI
 * convention keys (`gen_ai.usage.input_tokens`, …) and the flatter keys the LD
 * docs list (`gen_ai.provider`, `gen_ai.model`, prompt/completion tokens) are set,
 * so the LLM Observability view picks them up regardless of which it keys on.
 * Never throws.
 */
export function setGenAiAttributes(span: Span, d: GenAiSpanData): void {
  try {
    const attrs: Attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.system": d.provider,
      "gen_ai.provider": d.provider,
      "gen_ai.request.model": d.requestModel,
      "gen_ai.model": d.requestModel,
    };
    if (d.usage) {
      attrs["gen_ai.usage.input_tokens"] = d.usage.input;
      attrs["gen_ai.usage.output_tokens"] = d.usage.output;
      attrs["gen_ai.usage.total_tokens"] = d.usage.total;
      // Older convention aliases (some views still read these).
      attrs["gen_ai.usage.prompt_tokens"] = d.usage.input;
      attrs["gen_ai.usage.completion_tokens"] = d.usage.output;
    }
    if (d.prompt) attrs["gen_ai.input"] = truncate(d.prompt);
    if (d.output) attrs["gen_ai.output"] = truncate(d.output);

    // Correlation id shared by every agent span in this pipeline run (the `run`
    // multi-context key), so the whole chain groups together in observability.
    attrs["launchdarkly.run.id"] = pipelineRunId();

    // Correlate the span to the AgentControl config it ran, so LLM Observability
    // lines up with the same config's AI Config metrics.
    const td = d.tracker?.getTrackData?.();
    if (td) {
      attrs["launchdarkly.ai.config.key"] = td.configKey;
      attrs["launchdarkly.ai.config.variation"] = td.variationKey;
      attrs["launchdarkly.ai.config.version"] = td.version;
      attrs["launchdarkly.ai.config.model"] = td.modelName;
      attrs["launchdarkly.ai.provider"] = td.providerName;
      attrs["launchdarkly.ai.run.id"] = td.runId;
      if (td.graphKey) attrs["launchdarkly.ai.graph.key"] = td.graphKey;
    }
    span.setAttributes(attrs);
  } catch {
    /* telemetry must never break the run */
  }
}
