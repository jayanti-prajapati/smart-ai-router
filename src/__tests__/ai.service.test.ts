/**
 * Integration tests for runAiRequest() using a stub provider.
 *
 * No real API calls are made — the stub provider is registered before each
 * test and cleared after via resetProviderRegistry().
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runAiRequest } from "../services/ai.service.js";
import {
  registerProvider,
  resetProviderRegistry,
} from "../providers/registry.js";
import { registerPrompt } from "../prompts/registry.js";
import { clearCache } from "../services/cache.js";
import { setTelemetrySink } from "../services/telemetry.js";
import type { TelemetryRow } from "../services/telemetry.js";
import { BaseProvider } from "../providers/base.provider.js";
import type { NormalizedRequest, NormalizedResponse } from "../core/types.js";

// ─── Stub provider ─────────────────────────────────────────────────────────

class StubProvider extends BaseProvider {
  readonly name = "openai" as const; // Override the openai slot so models resolve

  constructor(private readonly fixedOutput = "stub response") {
    super();
  }

  protected async send(_req: NormalizedRequest): Promise<NormalizedResponse> {
    return {
      output: this.fixedOutput,
      inputTokens: 20,
      outputTokens: 10,
      finishReason: "stop",
    };
  }
}

beforeEach(() => {
  resetProviderRegistry();
  clearCache();
  // Register stub in place of openai (which all default models use)
  registerProvider("openai", () => new StubProvider());
});

afterEach(() => {
  resetProviderRegistry();
  clearCache();
});

describe("runAiRequest — integration", () => {
  test("returns a RunResponse with expected shape", async () => {
    const result = await runAiRequest({ task: "format", input: "hello" });
    assert.ok(typeof result.modelUsed === "string");
    assert.ok(["simple", "medium", "complex"].includes(result.complexity));
    assert.ok(typeof result.output === "string");
    assert.ok(typeof result.tokensUsed === "number");
    assert.ok(typeof result.costEstimate === "number");
    assert.ok(typeof result.latencyMs === "number");
    assert.equal(result.cached, false);
  });

  test("output matches stub response", async () => {
    const result = await runAiRequest({
      task: "format",
      input: "convert this",
    });
    assert.equal(result.output, "stub response");
  });

  test("simple task routes to simple tier model", async () => {
    const result = await runAiRequest({
      task: "format",
      input: "hello",
      debug: true,
    });
    assert.equal(result.complexity, "simple");
  });

  test("complex task routes to higher tier", async () => {
    const result = await runAiRequest({
      task: "architecture",
      input: "Design a distributed payment processing system with 100k TPS.",
      debug: true,
    });
    assert.equal(result.complexity, "complex");
  });

  test("debug=true includes signals and routingReason", async () => {
    const result = await runAiRequest({
      task: "format",
      input: "hello",
      debug: true,
    });
    assert.ok(result.debug);
    assert.ok(Array.isArray(result.debug.signals));
    assert.ok(typeof result.debug.routingReason === "string");
    assert.ok(result.debug.routingReason.length > 0);
  });

  test("second identical request is served from cache", async () => {
    const req = { task: "format", input: "cache-me-please" };
    const r1 = await runAiRequest(req);
    const r2 = await runAiRequest(req);
    assert.equal(r1.cached, false);
    assert.equal(r2.cached, true);
    assert.equal(r2.output, r1.output);
  });

  test("noCache=true bypasses cache read and write", async () => {
    const req = { task: "format", input: "no-cache-test", noCache: true };
    const r1 = await runAiRequest(req);
    const r2 = await runAiRequest(req);
    assert.equal(r1.cached, false);
    assert.equal(r2.cached, false);
  });

  test("costEstimate is positive", async () => {
    const result = await runAiRequest({ task: "format", input: "hello" });
    assert.ok(result.costEstimate >= 0);
  });

  test("latencyMs is positive", async () => {
    const result = await runAiRequest({ task: "format", input: "hello" });
    assert.ok(result.latencyMs >= 0);
  });

  test("custom prompt template is used when registered", async () => {
    registerPrompt({
      id: "my-custom",
      version: 1,
      system: "Custom system prompt.",
      pinnedComplexity: "simple",
    });
    const result = await runAiRequest({
      task: "task",
      input: "hello",
      promptId: "my-custom",
      debug: true,
    });
    assert.equal(result.complexity, "simple");
    assert.ok(
      result.debug?.signals.some((s) => s.includes("pinned by prompt")),
    );
  });

  test("priority=speed produces a result", async () => {
    const result = await runAiRequest({
      task: "summarize",
      input: "text",
      priority: "speed",
    });
    assert.ok(result.output.length > 0);
  });

  test("priority=quality produces a result", async () => {
    const result = await runAiRequest({
      task: "explain",
      input: "What is recursion?",
      priority: "quality",
    });
    assert.ok(result.output.length > 0);
  });

  test("telemetry sink fires on cache hit with cached=true and costUsd=0", async () => {
    const rows: TelemetryRow[] = [];
    setTelemetrySink(async (row) => {
      rows.push(row);
    });

    const req = { task: "format" as const, input: "sink-cache-test" };
    await runAiRequest(req); // real call — sink fires once
    await runAiRequest(req); // cache hit — sink must fire again

    // Reset sink so it doesn't bleed into other tests
    setTelemetrySink(async () => {});

    assert.equal(rows.length, 2);
    const cacheRow = rows[1]!;
    assert.equal(cacheRow.cached, true);
    assert.equal(cacheRow.costUsd, 0);
    assert.equal(cacheRow.inputTokens, 0);
    assert.equal(cacheRow.outputTokens, 0);
    assert.equal(cacheRow.provider, "cache");
    assert.ok(typeof cacheRow.requestId === "string");
    assert.ok(typeof cacheRow.latencyMs === "number");
  });

  test("quality escalation fires when stub returns low-quality output", async () => {
    // Register a stub that first returns an empty response (triggers escalation),
    // then returns a real response.
    let callCount = 0;
    class EscalatingStub extends BaseProvider {
      readonly name = "openai" as const;
      protected async send(
        _req: NormalizedRequest,
      ): Promise<NormalizedResponse> {
        callCount++;
        return {
          output: callCount === 1 ? "" : "good response",
          inputTokens: 10,
          outputTokens: callCount === 1 ? 0 : 5,
          finishReason: "stop",
        };
      }
    }
    resetProviderRegistry();
    clearCache();
    registerProvider("openai", () => new EscalatingStub());

    const result = await runAiRequest({
      task: "explain",
      input: "explain recursion",
    });
    // Should have escalated (at least 2 provider calls)
    assert.ok(callCount >= 2);
    assert.equal(result.output, "good response");
    assert.ok(result.escalatedFrom !== undefined);
  });
});
