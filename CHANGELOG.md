# Changelog

All notable changes to `smart-ai-router` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [SemVer](https://semver.org/)

## [Unreleased]

## [1.1.4] - 2026-09-19

### Fixed

- Telemetry sink now fires on cache hits ([#8](https://github.com/jayanti-prajapati/smart-ai-router/issues/8)). Previously `setTelemetrySink` callbacks were skipped entirely when a response was served from cache. Cache-hit rows are distinguishable via `row.cached === true`, `row.costUsd === 0`, and `row.provider === 'cache'`.

## [1.1.3] - 2026-09-19

### Changed

- Version bump to resolve npm staged-tarball conflict from `1.1.2` publish attempt; no functional changes

## [1.1.2] - 2026-09-19

### Changed

- Version bump (staged by npm; functionally identical to 1.1.1)

## [1.1.1] - 2026-09-19

### Added

- `Task` const object with 14 named task constants (`Task.FORMAT`, `Task.CODEGEN`, `Task.ARCHITECTURE`, etc.) — gives users full IDE autocomplete instead of magic strings ([#6](https://github.com/jayanti-prajapati/smart-ai-router/issues/6))
- `TaskType` open string-union (`typeof Task[keyof typeof Task] | (string & {})`) — `RunRequest.task` is now typed; existing plain-string callers are unaffected
- Both `Task` and `TaskType` exported from the package root

### Changed

- `RunRequest.task` type changed from `string` to `TaskType` (backward-compatible: all existing string literals still compile)
- README: new "Task types" section with full constant table and examples; Quick start updated to use `Task.FORMAT`
- Two classifier tests updated to use `Task.EXPLAIN` instead of the `'task'` placeholder string

## [1.1.0] - 2026-09-19

### Added

- `registerProvider(name, factory)` — first-class runtime API to add custom providers (Gemini, Cohere, Mistral, …) without forking the package. Factory is called lazily; re-registering clears the cached instance.
- `registerPrompt(template)` — register custom prompt templates at runtime without touching source code. Versioning, `pinnedComplexity`, `temperature`, and `{{task}}`/`{{input}}` placeholders are fully supported.
- Both new APIs are exported from the package root (`import { registerProvider, registerPrompt } from 'smart-ai-router'`).
- **66 unit and integration tests** covering: cost math, quality scorer, heuristic classifier, router (tier selection, priority, cost guard, error paths), `registerProvider`, `registerPrompt`, and full `runAiRequest` pipeline with mocked providers (cache, escalation, custom templates).
- CI now runs `npm test` on Node 18/20/22 before building, with `OPENAI_API_KEY=test` so no real API calls are made.
- `tsx` added as a dev dependency to enable `node:test` + TypeScript without a separate compile step.

### Changed

- `listPrompts()` now reflects runtime-registered templates (previously only returned hardcoded TEMPLATES array).
- `resetProviderRegistry()` now also clears custom factories (consistent reset for tests).
- README: updated "Adding a custom provider" section with `registerProvider()` example; added "Custom prompt templates" section with `registerPrompt()` examples.

## [1.0.5] - 2026-09-18

### Fixed

- Added CommonJS (CJS) build output to `dist/cjs/` to resolve Yarn warning "no commonjs entry point" ([#1](https://github.com/jayanti-prajapati/smart-ai-router/issues/1))
- Updated `exports` map with `"require"` conditions for all entry points
- Updated `"main"` field to `dist/cjs/index.js` for legacy bundler compatibility

## [1.0.4] - 2026-09-16

### Fixed

- Bumped version to resolve npm publish conflict (1.0.3 already published)

## [1.0.1] - 2026-09-16

### Changed

- Renamed package from `@ai/router` to `smart-ai-router`
- Updated all documentation and import examples to use `smart-ai-router`

## [1.0.0] - 2026-09-16

### Added

- Weighted heuristic complexity classifier (simple / medium / complex) — free, ~1ms, no model call
- Optional meta-model classifier for ambiguous prompts (`ENABLE_META_CLASSIFIER=true`)
- Priority-aware routing: `speed` (downgrade tier), `balanced` (quality per dollar), `quality` (upgrade tier)
- Per-request cost guard with configurable ceiling (`MAX_COST_PER_REQUEST`) and fallback-to-cheaper-model
- Output quality scorer: detects empty responses, truncation, refusals, repetition loops, bad JSON
- Quality-based escalation: automatically retries with a stronger model on low quality scores
- OpenAI Chat Completions provider (also compatible with Azure, OpenRouter, Together, Groq)
- Anthropic Messages API provider
- Local model provider (Ollama, vLLM, LM Studio) at zero cost
- Extensible provider registry — add a vendor in one file, zero changes elsewhere
- Redis + in-process LRU cache keyed on SHA-256 of prompt + task + priority
- Versioned prompt template registry with complexity pinning and temperature override
- Deterministic FNV-1a A/B experiment bucketing — same request always lands in the same arm
- BullMQ async job queue (optional, requires Redis)
- Structured telemetry with pluggable sink for database writes
- Daily budget circuit breaker — degrades to cheapest tier instead of hard failure
- Fastify HTTP server with `/ai/run`, `/ai/jobs/:id`, `/ai/models`, `/ai/prompts`, `/ai/metrics`, `/health`
- Full TypeScript types, declaration files, and source maps
- Zod-validated environment configuration with fail-fast startup
