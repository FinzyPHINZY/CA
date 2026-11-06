# CueActor — AI Rehearsal Platform for Actors

**Backend · NestJS + Python microservices · Real-time AI voice · RAG**

CueActor lets actors rehearse without a human reader. They upload a script in any format, then practice scenes against **Hazel**, an AI scene partner that reads the other characters' lines aloud in distinct voices, listens, and takes turns — actor speaks, Hazel responds — in real time.

I built the backend: **6 independently deployable services** (5 NestJS + 1 Python/FastAPI) communicating over RabbitMQ, TCP, and SSE, backed by PostgreSQL + pgvector, Redis, and S3 — 43 domain entities, 80 tracked migrations, and a fully automated build-once / promote-by-tag CI/CD pipeline to EC2.

The interesting parts were all about **using AI with discipline and keeping cost/latency in check**: a deterministic, geometry-based script parser (PyMuPDF, with pdfplumber and Vision/OCR fallbacks) that runs *before* any LLM touches the text; a custom voice pipeline that streams speech-to-text browser-direct and pre-generates TTS with global SHA-256 dedup (one synth per unique line, ever) for **400–700ms** turn latency; and a script Q&A feature that routes counting questions to **pure SQL** (zero hallucination) and everything else through pgvector retrieval with forced citations — all for ~**$0.0007 a question**.

**Stack:** NestJS · TypeScript · Python/FastAPI · PostgreSQL + pgvector · Redis · RabbitMQ · Google Gemini · ElevenLabs · Deepgram · AWS S3 · Stripe · Docker · GitHub Actions

→ [Full case study](./CASE_STUDY.md)
