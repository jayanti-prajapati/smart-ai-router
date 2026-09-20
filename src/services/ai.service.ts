/**
 * Orchestration. This is the only place that knows the full request lifecycle:
 *
 *   cache lookup -> classify -> route -> cost guard -> provider call
 *     -> quality check -> (escalate once) -> telemetry -> cache write
 *
 * Failure policy: a provider failure retries on the SAME tier with a different
 * model first (usually a different vendor, which survives one vendor being
 * down), and only then gives up. A quality failure escalates UP a tier, once.
 */
import { randomUUID } from "node:crypto";
import { classify } from "../core/classifier.js";
import { computeCost, estimateOutputTokens } from "../core/cost.js";
import { scoreOutput } from "../core/quality.js";
import { route } from "../core/router.js";
import { TIER_ORDER } from "../config/models.js";
import { env } from "../config/env.js";
import { getPrompt, promptRef, render } from "../prompts/registry.js";
import { getProvider } from "../providers/registry.js";
import { getCached, setCached } from "./cache.js";
import { budget, logger, recordRequest } from "./telemetry.js";
import type {
  Complexity,
  NormalizedResponse,
  RoutingDecision,
  RunRequest,
  RunResponse,
} from "../core/types.js";
import { NoModelAvailableError } from "../core/types.js";

/** Max distinct models tried for one request before giving up. */
const MAX_MODEL_ATTEMPTS = 3;

export async function runAiRequest(req: RunRequest): Promise<RunResponse> {
  const requestId = randomUUID();
  const started = Date.now();
  const priority = req.priority ?? "balanced";

  // ---------- 1. Cache ----------
  const cached = await getCached(req);
  if (cached) {
    const latencyMs = Date.now() - started;
    logger.debug({ requestId }, "cache hit");
    recordRequest({
      requestId,
      task: req.task,
      modelUsed: cached.modelUsed,
      provider: "cache",
      complexity: cached.complexity,
      priority,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs,
      cached: true,
      escalated: false,
      createdAt: new Date().toISOString(),
    });
    return { ...cached, cached: true, latencyMs };
  }

  // ---------- 2. Prompt template ----------
  const template = getPrompt(req.promptId);
  const prompt = render(template, { task: req.task, input: req.input });

  // ---------- 3. Classify ----------
  const classification = template.pinnedComplexity
    ? {
        complexity: template.pinnedComplexity,
        confidence: 1,
        signals: [`pinned by prompt ${promptRef(template)}`],
        estimatedInputTokens: Math.ceil(
          (prompt.length + template.system.length) / 3.7,
        ),
        source: "forced" as const,
      }
    : await classify({ ...req, input: prompt });

  // ---------- 4. Daily budget circuit breaker ----------
  // When the day's budget is blown we still serve traffic, but only from the
  // cheapest tier — degraded service beats a hard outage.
  const budgetExceeded = budget.exceeded();
  if (budgetExceeded) {
    logger.warn(
      { requestId, spent: budget.total, limit: env.DAILY_BUDGET_USD },
      "daily budget exceeded — forcing cheapest tier",
    );
  }

  const tried: string[] = [];
  let escalatedFrom: string | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
    // ---------- 5. Route ----------
    let decision: RoutingDecision;
    try {
      decision = route(
        budgetExceeded ? { ...req, priority: "speed" } : req,
        classification,
        {
          exclude: tried,
          acceptCost: req.acceptCost,
          experimentKey: requestId,
          minTier: escalatedFrom
            ? escalateTier(classification.complexity)
            : undefined,
        },
      );
    } catch (err) {
      // Cost errors and "nothing left to try" both surface to the caller.
      if (tried.length > 0 && err instanceof NoModelAvailableError) break;
      throw err;
    }

    tried.push(decision.model.id);
    const callStarted = Date.now();

    logger.debug(
      {
        requestId,
        model: decision.model.id,
        complexity: decision.complexity,
        reason: decision.reason,
        estimatedCost: decision.estimatedCost,
      },
      "routing decision",
    );

    // ---------- 6. Call the provider ----------
    let result: NormalizedResponse;
    try {
      const provider = getProvider(decision.model.provider);
      result = await provider.complete({
        modelId: decision.model.id,
        system: template.system,
        prompt,
        maxOutputTokens: Math.min(
          estimateOutputTokens(
            classification.estimatedInputTokens,
            decision.complexity,
          ),
          decision.model.maxOutputTokens,
        ),
        temperature:
          template.temperature ?? defaultTemperature(decision.complexity),
      });
    } catch (err) {
      lastError = err;
      logger.warn(
        { requestId, model: decision.model.id, err },
        "provider call failed, failing over",
      );
      continue; // Try a different model — often a different vendor entirely.
    }

    const latencyMs = Date.now() - callStarted;
    const cost = computeCost(
      decision.model,
      result.inputTokens,
      result.outputTokens,
    );
    budget.add(cost);

    // ---------- 7. Quality gate ----------
    const quality = scoreOutput(result, {
      expectJson: template.id === "json-transform",
    });

    const canEscalate =
      env.ENABLE_QUALITY_RETRY &&
      quality.score < env.QUALITY_MIN_SCORE &&
      !escalatedFrom &&
      !req.forceModel &&
      decision.complexity !== "complex" &&
      attempt < MAX_MODEL_ATTEMPTS - 1;

    if (canEscalate) {
      logger.info(
        {
          requestId,
          model: decision.model.id,
          score: quality.score,
          reasons: quality.reasons,
        },
        "low quality output — escalating to a stronger model",
      );
      // The failed attempt still cost money, so it still gets a telemetry row.
      recordRequest({
        requestId,
        task: req.task,
        modelUsed: decision.model.id,
        provider: decision.model.provider,
        complexity: decision.complexity,
        priority,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: cost,
        latencyMs,
        cached: false,
        escalated: true,
        error: `quality ${quality.score.toFixed(2)}: ${quality.reasons.join("; ")}`,
        createdAt: new Date().toISOString(),
      });
      escalatedFrom = decision.model.id;
      continue;
    }

    // ---------- 8. Success ----------
    const response: RunResponse = {
      modelUsed: decision.model.id,
      complexity: decision.complexity,
      tokensUsed: result.inputTokens + result.outputTokens,
      costEstimate: cost,
      output: result.output,
      cached: false,
      latencyMs: Date.now() - started,
      ...(escalatedFrom ? { escalatedFrom } : {}),
      ...(req.debug
        ? {
            debug: {
              signals: classification.signals,
              routingReason: `${decision.reason} | prompt=${promptRef(template)} | quality=${quality.score.toFixed(2)}`,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              ...(decision.experiment
                ? { experiment: decision.experiment }
                : {}),
            },
          }
        : {}),
    };

    recordRequest({
      requestId,
      task: req.task,
      modelUsed: decision.model.id,
      provider: decision.model.provider,
      complexity: decision.complexity,
      priority,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: cost,
      latencyMs,
      cached: false,
      escalated: Boolean(escalatedFrom),
      createdAt: new Date().toISOString(),
    });

    // Don't cache low-quality answers — we'd serve the bad result all hour.
    if (quality.score >= env.QUALITY_MIN_SCORE) void setCached(req, response);

    return response;
  }

  throw (
    lastError ??
    new NoModelAvailableError(`All ${tried.length} model attempts failed`)
  );
}

function escalateTier(current: Complexity): Complexity {
  const i = TIER_ORDER.indexOf(current);
  return TIER_ORDER[Math.min(i + 1, TIER_ORDER.length - 1)]!;
}

/** Deterministic work wants low temperature; design work benefits from some. */
function defaultTemperature(complexity: Complexity): number {
  return complexity === "simple" ? 0 : complexity === "medium" ? 0.3 : 0.5;
}
