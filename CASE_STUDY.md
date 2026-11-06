# CueActor — AI Rehearsal Platform for Actors

**Backend engineering case study**

CueActor is a production platform that lets actors upload scripts, practice scenes with an AI scene partner, run speech-paced solo teleprompter sessions, ask grounded questions about a screenplay, and track their progress with rehearsal analytics. This document covers the backend: the problems it solves, the architecture, the engineering decisions behind the hardest features, and the trade-offs made along the way.

> **Scale of the system:** 6 independently deployable services (5 NestJS + 1 Python/FastAPI), a shared TypeScript library with 43 domain entities, 80 ordered SQL migrations, ~560 TypeScript source files, and 79 test suites — all shipped to staging and production through a fully automated CI/CD pipeline.

---

## 1. The Problem

Actors rehearse constantly, but rehearsal has a hard dependency: **another human to read the other lines**. At 11pm the night before an audition, that human usually doesn't exist.

The naive solution — "a video chat app with a script viewer" — solves nothing. The actual product problem is a cluster of hard sub-problems:

1. **Ingest any script format** (PDF, Final Draft `.fdx`, Fountain, DOCX — including scanned, watermarked, and badly-formatted PDFs) and turn it into clean, structured, scene-by-scene data.
2. **Be a believable scene partner** — read other characters' lines aloud in distinct voices, listen to the actor, and take turns naturally, with the deliberate pauses real acting requires.
3. **Answer questions about a script** ("how many scenes is Marcus in?", "what's Sarah's arc?") without hallucinating, with citations back to specific pages.
4. **Measure improvement** — surface difficult lines, practice streaks, and progress over time.
5. **Do all of this cheaply and at low latency**, because AI APIs (speech-to-text, text-to-speech, LLMs) cost money on every call and feel broken above ~1s of perceived delay.

Each of these became a feature. Each is documented below with the engineering decision that made it work.

---

## 2. System Architecture

A NestJS monorepo of five TypeScript microservices plus a standalone Python parsing service, communicating over **RabbitMQ** (async events), **TCP** (sync auth), and **direct HTTP/SSE** (per-token LLM streaming), backed by **PostgreSQL + pgvector**, **Redis**, and **AWS S3**.

```
                        ┌─────────────────────────────────────────┐
                        │   Clients — Web · Mobile · Integrations  │
                        └──────────────────┬──────────────────────┘
                                           │  HTTPS  /api/*  ·  WebSocket  ·  SSE
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                                  SERVICE LAYER                                   │
│                                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────┐ │
│  │  Core      │  │  Auth      │  │  AI Service  │  │  File     │  │  Notif.  │ │
│  │  :3000     │  │  :3001     │  │  :3002       │  │  :3004    │  │  :3003   │ │
│  │            │  │            │  │              │  │           │  │          │ │
│  │ projects   │  │ JWT        │  │ Hazel        │  │ S3        │  │ Socket.io│ │
│  │ scripts    │  │ Google/    │  │ Script Q&A   │  │ uploads   │  │ email    │ │
│  │ rehearsals │  │  Apple     │  │ Gemini       │  │ validation│  │ push     │ │
│  │ analytics  │  │  OAuth     │  │ ElevenLabs   │  │           │  │          │ │
│  │ billing    │  │ WebAuthn   │  │ Deepgram     │  │           │  │          │ │
│  │ payments   │  │  passkeys  │  │ embeddings   │  │           │  │          │ │
│  └─────┬──────┘  └─────▲──────┘  └──────┬───────┘  └─────┬─────┘  └────▲─────┘ │
│        │   TCP (JWT)   │                │                │             │       │
│        └───────────────┘                │                │             │       │
└────────┼────────────────────────────────┼────────────────┼─────────────┼───────┘
         │                                 │                │             │
         │      ┌──────────────────────────┴────────────────┴─────────────┘
         │      │            RabbitMQ  —  event bus / async messaging
         │      │   core ⇄ ai_service ⇄ notifications ⇄ script_parser
         │      ▼
         │   ┌──────────────────────┐
         │   │  Script Parser :3005 │  Python · FastAPI
         │   │  PDF / FDX / Fountain │  PyMuPDF → pdfplumber → Vision/OCR
         │   │  / DOCX → ParseResult │  (geometry-driven, deterministic)
         │   └──────────────────────┘
         ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                              INFRASTRUCTURE LAYER                                │
│   PostgreSQL 15 + pgvector      Redis (sessions/cache/locks)      AWS S3        │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Why this split.** `core` owns everything public-facing and stateful (auth gating, rate limits, persistence) so the AI service never faces the internet. `ai_service` owns the LLM/voice pipeline because that's where Gemini, embeddings, and the voice providers live. The Python parser is isolated because document extraction is a fundamentally different runtime (Python's PDF/OCR ecosystem) and failure domain — a malformed 200-page scanned PDF should never be able to take down the API.

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| **Services** | NestJS (TypeScript), FastAPI (Python 3.11) |
| **Data** | PostgreSQL 15, pgvector (vector search), TypeORM, Redis |
| **Messaging** | RabbitMQ (async events), TCP (sync auth), SSE + Socket.io (real-time) |
| **AI / ML** | Google Gemini (Flash + Pro, LangChain), `text-embedding-004`, ElevenLabs (TTS), Deepgram (STT) |
| **Document extraction** | PyMuPDF, pdfplumber, python-docx, pdf2image, Gemini Vision / OCR (+ optional Adobe PDF Extract / Google Document AI) |
| **Auth** | JWT, Google OAuth, Apple OAuth, WebAuthn passkeys |
| **Storage / media** | AWS S3, Agora RTC (recording) |
| **Payments** | Stripe (subscriptions, Connect marketplace) |
| **Infra / CI-CD** | Docker, Docker Compose, GitHub Actions, DockerHub, EC2 |
| **Observability** | pino structured logs, Prometheus-style metrics, health checks, Swagger/OpenAPI at `/docs` |

---

## 4. Flagship Features

### 4.1 Script Ingestion Pipeline — three strictly separated layers

The single biggest cause of fragile parsing pipelines is mixing **document extraction**, **screenplay parsing**, and **LLM analysis** into one step. CueActor keeps them as three clean layers:

1. **Document extraction** — A dedicated Python/FastAPI service converts any file into positioned text blocks via a tiered fallback chain. For PDFs, **PyMuPDF** is the primary engine — a single document open yields native text *plus* geometry (bounding boxes, fonts, block positions) and feeds watermark detection; **pdfplumber** is the fallback when PyMuPDF's native text signal is weak; image-based/scanned PDFs are rasterized (`pdf2image`) and routed to **Gemini Vision / OCR**. `.docx` goes through **python-docx**, with dedicated parsers for **Final Draft `.fdx`** (XML) and **Fountain** (plain-text screenplay syntax). The full fallback chain and extraction source are recorded in metadata so support can see exactly which path ran for any script. *(An optional external-extractor path — Adobe PDF Extract API → Google Document AI — sits behind a percentage rollout flag for hard-to-parse documents.)*
2. **Screenplay parsing** — Deterministic, *no LLM*. Block geometry (bounding boxes, font, X/Y position) drives column classification, header/footer/watermark removal (any line repeating across ≥30% of pages is stripped), reading-order repair, and scene assembly. Page numbers are tracked per element. Coverage warnings (missing scenes, zero dialogue, dual-column detected) are surfaced to the client so risky scripts get flagged for manual review.
3. **LLM analysis** — Only *after* clean structure exists does Gemini run, enriching semantics (character arcs, genre signals, relationships, themes).

Every script becomes a clean tree — `Script → Scene → Character → Dialogue/Action` — which is the single source of truth powering the teleprompter, the AI reader, scene practice, and recordings.

**Why deterministic-first:** structure extraction with an LLM is non-reproducible, expensive per-page, and hallucinates scene boundaries. Geometry doesn't.

### 4.2 Hazel — the AI Scene Partner

Hazel is the hardest feature in the platform. The actor picks a scene and their character; Hazel reads *every other* character's lines aloud in distinct voices, listens, and takes turns — actor speaks, Hazel responds, repeat — until the scene ends.

A formal architecture review compared a **custom pipeline** against a **managed Conversational AI engine** (Agora ConvoAI). The custom pipeline won decisively, on five concrete grounds. The decisions that make it work:

- **Browser-direct speech-to-text.** The browser opens a WebSocket *straight to Deepgram* and forwards only **transcript text** to the backend. The backend never touches a single byte of raw audio — eliminating the hardest part of building real-time voice (audio relay) entirely.
- **Pre-generated, deduplicated TTS.** Because the script is known in advance, every Hazel line is synthesized at session start and cached in Redis. Each unique line is keyed by **SHA-256** in a global cache: if 500 actors rehearse the same scene, ElevenLabs is called *once* per unique line, not 500 times. Hazel's turns then have near-zero latency.
- **`isHazelSpeaking` echo gate.** When Hazel's audio plays, the actor's mic re-captures it. Rather than trusting browser echo cancellation, the gateway sets a flag and *discards all transcripts* during Hazel's speaking window — deterministic, at the state-machine level.
- **Cue detection tuned for acting, not chatbots.** Turn advance uses **Jaccard word-overlap ≥ 75%** against the expected line, scored progressively on Deepgram *interim* results so it can fire the instant the final transcript confirms. A **3-second silence** backup advances only if prior overlap was ≥ 40% — so a dramatic pause mid-line doesn't get mistaken for "done," and a forgotten line doesn't auto-skip. Managed VAD (Agora) couldn't be tuned this way.
- **Clean provider interfaces.** `DeepgramService` and `ElevenLabsService` sit behind `SpeechToTextService` / `TextToSpeechService` abstractions, so swapping providers is isolated to one implementation file.

**Result:** end-to-end actor-done → Hazel-first-audio latency of **400–700ms** — matching or beating the managed alternative, at lower cost and with full control over every threshold. The Hazel module is 24 files: gateway, session state, turn sequencer, cue/silence detection, voice mapper, audio pre-generation, event logger, usage meter.

### 4.3 Script Q&A — grounded, cited, near-zero hallucination

A chat panel scoped to a single script, answering questions with citations back to specific scenes and pages. The architecture is built so that **the most common questions never reach an LLM at all**.

The core idea: a cheap **query router** (Gemini Flash, temperature 0, structured JSON output) classifies every incoming question into one of six classes, resolves coreferences ("she" → "Sarah"), and extracts character/scene filters. Each class then gets a *different* retrieval and generation strategy — so a counting question is answered by SQL while an interpretive question goes through full retrieval:

| Class | Example | How it's answered |
|---|---|---|
| `LOOKUP` | "When does Sarah first enter?" | Vector search → top-k scene chunks → Gemini answer with citations |
| `AGGREGATE` | "How many scenes is Marcus in?" | **Pure SQL** on parsed entities — deterministic, **no LLM** |
| `STRUCTURAL` | "What happens in act 2?" | Direct scene/act lookup → templated summary or Gemini |
| `ANALYTICAL` | "Assess Sarah's arc." | Broad vector search + cached analysis → Gemini Pro reasoning |
| `META` | "What's the genre and tone?" | Read from cached script analysis — often no LLM call |
| `OFF_TOPIC` | "Write me a poem." | Templated refusal — no retrieval, no LLM, no quota consumed |

- **`AGGREGATE` → pure SQL.** "How many scenes is Marcus in?" runs a parameterized query against the chunk table — **zero hallucination by construction**, no LLM in the path. ~10 named SQL templates cover the common counting/listing questions; anything unmatched falls through to `LOOKUP` and is logged so the next template can be prioritized.
- **`LOOKUP` / `ANALYTICAL` → pgvector retrieval.** Scripts are chunked *by scene* (not arbitrary token windows), embedded with `text-embedding-004` (768-dim), and stored in an `ivfflat` index. Router-extracted filters pre-narrow the search before cosine similarity — a large precision boost.
- **A stacked anti-hallucination defense:** SQL-first routing, filtered retrieval, forced `[scene N, p. PP]` citations, a 0.30 similarity confidence floor (refuse rather than guess), structured `unanswered_parts` output that makes the model declare what the script *doesn't* say, prompt-injection delimiting, and a golden-set eval harness gating prompt changes.
- **Streamed over SSE**, not WebSocket — a deliberate choice (request/response shape, works through any CDN without sticky sessions, the industry standard for LLM streaming).

**Economics:** ~**$0.0007 per question** average (most are cheap Flash or pure SQL), one-time embedding cost of ~**$0.0016 per script**, p50 latency ~2s with **<150ms on cache hits** and ~700ms time-to-first-token.

### 4.4 Teleprompter — speech-paced solo reading

A solo mode where the cursor advances as the actor reads aloud — **reusing Hazel's cue-detection engine** (cursor tracking + Jaccard fallback + silence backup) extracted into a shared `cue-engine` sub-module. No TTS, no voice selection, no role gating. Deliberately stripped down: a fast-bootstrap path (no prepare/poll step — the session builds its sequence inline in <50ms) with `AUTO` and `MANUAL` detection modes. This is the payoff of good abstraction boundaries: a second product feature fell out of the Hazel cue engine almost for free.

### 4.5 Rehearsal Analytics

Every rehearsal emits a structured event log (retries per line, response times, lines skipped). Analytics — difficult lines, session timelines, project-level progress, practice streaks — are **computed from events and cached in JSONB** on the rehearsal/project rows via a raw `COALESCE("metaData", '{}') || payload::jsonb` merge. Served from cache when ≤1h old; an hourly cron aggregates fresh rehearsals and a nightly job recomputes stale ones. Streaks are computed by walking distinct calendar days descending.

---

## 5. Interesting Engineering Decisions

| Decision | Rationale |
|---|---|
| **Custom voice pipeline over managed (Agora ConvoAI)** | Managed VAD can't be tuned for dramatic pauses; multi-voice switching unproven; action-line UI sync would have required a parallel WebSocket channel anyway — making the "simpler" managed option *more* complex, while costing more. |
| **Browser-direct Deepgram (no audio relay)** | Removes the single hardest part of real-time voice. Backend works in *text in, audio out* — never proxies PCM. |
| **TTS pre-generation + global SHA-256 dedup** | Converts a per-session real-time cost into a one-time, globally-shared cost. Cuts ElevenLabs spend by orders of magnitude at scale and drops Hazel latency to ~0. |
| **SQL-first Q&A routing** | Counting/aggregate questions are answered by Postgres, not an LLM — eliminating hallucination on the highest-frequency factual queries. |
| **Deterministic parsing before LLM analysis** | Geometry-based structure extraction is reproducible and cheap; LLMs hallucinate scene boundaries. The LLM only does semantics, on already-clean input. |
| **SSE for Q&A, WebSocket for Hazel** | Transport matched to interaction shape: request/response streaming vs. long-lived bidirectional turn-taking. |
| **Redis distributed locks** | `hazel:lock:{userId}` enforces one active session per user across duplicate tabs/devices. |
| **Provider interfaces (`SpeechToTextService`, `TextToSpeechService`)** | Vendor swaps are isolated to one file; the turn sequencer and cue engine are provider-agnostic. |

---

## 6. Challenges & Trade-offs

- **Echo cancellation:** Browser AEC is unreliable. Solved deterministically with the `isHazelSpeaking` gate rather than trusting the browser — accepting a tiny tail latency at flag-clear in exchange for zero false cue matches.
- **Dramatic pauses vs. "actor is done":** A single threshold can't tell a 2-second performance beat from a finished line. Solved with a two-signal system (progressive word-overlap *and* a guarded silence timer that only fires above 40% partial match).
- **Hallucination vs. helpfulness:** Strict refusal floors reduce hallucination but frustrate users on borderline questions. The trade-off was tier-specific tolerances — <1% on `LOOKUP`, ~0% on `AGGREGATE` (SQL), and an accepted <5% on interpretive `ANALYTICAL`, where uncertainty is surfaced rather than hidden.
- **Parser correctness vs. coverage:** Rather than block on perfect extraction, the pipeline emits coverage warnings and an `extractionSource` tag so imperfect scripts remain usable while being clearly flagged — shipped behind a percentage rollout flag (`EXTERNAL_PDF_EXTRACTOR_ROLLOUT`) to ramp safely.
- **Streaming substrate:** RabbitMQ is excellent for events but a poor fit for per-token streaming, so `core` forwards setup over RabbitMQ but pipes the token stream over direct HTTP — two transports instead of forcing one.

---

## 7. CI/CD & Operations

A complete GitHub Actions pipeline, not a toy `npm test` step:

**On every PR** (`pr-check.yml`): pnpm install (frozen lockfile, cached store), lint, `tsc --noEmit` type check, full Jest suite (4GB heap), and a build check — with a generated job summary and Slack notifications on pass/fail.

**Staging** (`deploy-staging.yml`, auto on push to `staging`): builds and pushes **6 Docker images** (Buildx with GitHub Actions layer cache) to DockerHub, then over SSH to EC2 — frees disk, runs **idempotent SQL migrations tracked in a `migration_history` table** (skips already-applied files, fails hard on error), performs a **rolling restart service-by-service with per-service health gating**, runs a 12-attempt health-check loop against `/api/health`, and Slacks the result. Image pruning on success.

**Production** (`deploy-prod.yml`, manual): guarded by a typed `deploy-prod` confirmation, **promotes the exact image tag built in staging** (build-once, deploy-many) or builds fresh from `main`, with the same rolling-restart + health-check + Slack flow and a non-cancellable concurrency group so two prod deploys can't race.

Highlights: build-once/promote-by-tag, DB migrations as a tracked first-class deploy step, health-gated rolling restarts, and human confirmation on the only destructive path.

---

## 8. Results / Metrics

| Metric | Value |
|---|---|
| Deployable services | **6** (5 NestJS + 1 Python/FastAPI) |
| Shared domain entities | **43** |
| Ordered SQL migrations | **80** |
| TypeScript source files | **~560** |
| Test suites | **79** |
| Hazel turn-to-audio latency | **400–700ms** end-to-end |
| Script Q&A latency | **~2s** p50 · **<150ms** cached · **~700ms** to first token |
| Q&A cost | **~$0.0007 / question**, ~$0.70 / user / month |
| Embedding cost | **~$0.0016 / script** (one-time) |
| TTS cost at scale | Cut by **orders of magnitude** via global SHA-256 dedup |
| Hallucination (AGGREGATE) | **~0%** — answered by SQL, not an LLM |
| Supported script formats | PDF (incl. scanned/watermarked), FDX, Fountain, DOCX |

---

## 9. What This Demonstrates

- **Systems thinking** — six services, three transport mechanisms, and clear failure-domain isolation, chosen deliberately rather than by default.
- **Hard real-time engineering** — sub-second, multi-voice, turn-taking audio with deterministic echo handling and acting-aware cue detection.
- **Applied AI with discipline** — LLMs used only where they earn their place; SQL and deterministic geometry used everywhere they're more correct, reproducible, and cheaper.
- **Cost and latency as first-class constraints** — pre-generation, global dedup, multi-layer caching, and SQL-first routing, each tied to a measured number.
- **Production operational maturity** — tracked migrations, health-gated rolling deploys, build-once/promote-by-tag, and a guarded production path.

> CueActor is a platform where the hard parts — voice, parsing, retrieval, cost — were each solved with a specific, defensible engineering decision, not a managed black box. The decisions are documented, measured, and shipped.
