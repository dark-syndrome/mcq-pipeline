# MCQ Pipeline

An LLM-powered pipeline that transforms Markdown lesson files into production-quality multiple-choice questions. Ships with a full-featured Electron desktop GUI and a Python CLI for scripted or batch use.

---

## Table of Contents

- [Getting Started](#getting-started)
- [0. Quick-Start Checklist](#0-quick-start-checklist)
- [1. What This Project Does](#1-what-this-project-does)
- [2. System Architecture](#2-system-architecture)
- [3. Environment Setup](#3-environment-setup)
- [4. Running the Application](#4-running-the-application)
- [5. Configuration Reference](#5-configuration-reference-configyaml)
- [6. LLM Providers](#6-llm-providers)
- [7. The Pipeline — Stage by Stage](#7-the-pipeline--stage-by-stage)
- [8. Storage: SQLite + Supabase](#8-storage-sqlite--supabase)
- [9. GUI Tab Reference](#9-gui-tab-reference)
- [10. Module Reference](#10-module-reference)
- [11. Data Models](#11-data-models)
- [12. CLI Reference](#12-cli-reference)
- [13. Output Files](#13-output-files)
- [14. Production-Grade Engineering](#14-production-grade-engineering)
- [15. Quality Rules — Design Rationale](#15-quality-rules--design-rationale)
- [16. Troubleshooting](#16-troubleshooting)
- [17. Maintenance: Archive & Re-tag](#17-maintenance-archive--re-tag)

---

## Getting Started

This section gets you from a fresh clone to running your first generation in under 10 minutes.

### 1. Clone the repository

```bash
git clone <repo-url> mcq_pipeline
cd mcq_pipeline
```

### 2. Create and activate a Python environment

**Option A — Conda (recommended)**

```bash
conda create -n mcq python=3.11 -y
conda activate mcq
```

**Option B — venv**

```bash
# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate

# Windows (PowerShell)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 3. Install Python dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
pip install -e .
```

### 4. Set up your API key

```bash
cp .env.example .env
```

Open `.env` and add your key for whichever provider you want to use:

```env
# OpenRouter (recommended — one key, access to all models):
OPENROUTER_API_KEY=sk-or-your-key-here

# Or Groq (free tier available):
GROQ_API_KEY=gsk_your-key-here

# Or Anthropic:
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Get an OpenRouter key at https://openrouter.ai/keys — it's the easiest starting point.

### 5. Create required directories

```bash
mkdir -p output logs
```

### 6. Run your first generation

```bash
mcq-agent generate examples/sample_lesson.md --count 5
```

Results are written to `output/`. Check `output/*_accepted.json` for your generated questions.

### 7. (Optional) Launch the GUI

Requires Node.js 18+ installed separately.

```bash
cd gui
npm install
npm run dev
```

The Electron window opens automatically.

---

## 0. Quick-Start Checklist

Use this every time you return to the project after a break.

```
[ ] 1. Navigate to the project directory:
        cd path/to/mcq_pipeline

[ ] 2. Activate your environment:
        conda activate mcq          (Conda)
        source .venv/bin/activate   (venv — macOS/Linux)
        .\.venv\Scripts\Activate    (venv — Windows)

[ ] 3. Smoke test (no API calls):
        python -m pytest tests/ -v

[ ] 4. Generate questions:
        mcq-agent generate examples/sample_lesson.md --count 5

[ ] 5. Launch GUI (separate terminal, no venv needed if using conda):
        cd gui && npm run dev
```

---

## 1. What This Project Does

The **MCQ Agent** is an AI-powered pipeline that transforms Markdown lesson files into high-quality Multiple-Choice Questions ready for use in courses. Given a `.md` file, it:

1. Analyses the document and extracts a structured **concept map** (concepts, procedures, facts, code examples)
2. Generates MCQ candidates covering the lesson's key ideas using per-Bloom-level compressed document summaries
3. Runs every candidate through **7 deterministic rule checks** (free, no API cost)
4. Evaluates each candidate against **13 quality criteria** via an independent LLM Critic
5. Salvages borderline rejections through targeted rewrites (**Reframer**, 5-class taxonomy)
6. Stores all results in a local SQLite database and optionally syncs a deduplicated set to Supabase cloud

The Electron GUI provides a graphical operator interface over the same pipeline and question bank — run generation, browse/filter questions, export DOCX/PDF/XLSX, monitor costs, curate eval sets, and adjust model config, all without touching the command line.

**What it is NOT:** a simple "ask GPT to write questions" script. Every MCQ must pass deterministic validators, an independent LLM critic, and a class-based reframer before it is accepted. A deduplication gate prevents re-generating questions already in the bank.

---

## 2. System Architecture

### 2.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MCQ Pipeline — System Map                           │
│                                                                               │
│  ┌──────────────────────────────────────┐  ┌──────────────────────────────┐ │
│  │       Electron Desktop GUI (gui/)     │  │   Python CLI (mcq_agent/)    │ │
│  │                                       │  │                               │ │
│  │  React + Vite renderer (5 tabs)       │  │  mcq-agent generate <file>    │ │
│  │  ◄──contextBridge──► Electron main   │  │  mcq-agent list-runs          │ │
│  │  Electron main spawns Python sidecar  │  │  mcq-agent show-run <id>      │ │
│  │  GUI reads DB via sql.js (WASM)       │  │  mcq-agent push-supabase      │ │
│  │  Python owns all DB writes            │  │                               │ │
│  └────────────────┬─────────────────────┘  └──────────────┬────────────────┘ │
│                   │ spawns                                  │                  │
│  ┌────────────────▼─────────────────────────────────────── ▼ ───────────────┐ │
│  │                     Python Pipeline (mcq_agent/)                          │ │
│  │                                                                            │ │
│  │  Parse ──► Analyze ──► Generate ──► Validate ──► Critique ──► Reframe    │ │
│  │   T1/T2/T3   ConceptMap  per-Bloom    7 rules    13 criteria  5 classes  │ │
│  │   tiers      MD5 cache   fan-out      free        LLM judge   LLM fix    │ │
│  │                                                                            │ │
│  │  instructor + Pydantic v2 enforces structured output at every LLM stage  │ │
│  └────────────────────────────────┬───────────────────────────────────────── ┘ │
│                                    │ writes                                   │
│  ┌─────────────────────────────────▼──────────────────────────────────────┐  │
│  │  logs/runs.db  (SQLite — Python writes, GUI reads via sql.js WASM)      │  │
│  │  runs · mcqs (passed + rejected) · concept_maps (analyzer cache)        │  │
│  └─────────────────────────────────┬──────────────────────────────────────┘  │
│                                     │ optional dedup sync                     │
│  ┌──────────────────────────────────▼─────────────────────────────────────┐  │
│  │  Supabase (cloud — optional)                                             │  │
│  │  accepted + deduplicated questions only · gapless question_number        │  │
│  │  token_set_ratio dedup gate (rapidfuzz) · service_role key via Python    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  eval-sets/  (JSON files — GUI-owned annotation data)                   │  │
│  │  EvalSet · EvalAnnotation (ratings, confirmed flag, notes)              │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Pipeline Data Flow

```
Input (.md file)
       │
       ▼
┌──────────────────────────────────────┐
│  parser.py — Stage 0                 │
│  Three document tiers in one read:   │
│  T1: raw_text   (full Markdown)      │ ◄─ Analyzer only (once, then cached)
│  T2: section_summaries               │ ◄─ Generator, Reframer (~30–60% of T1)
│  T3: section_fingerprints            │ ◄─ Critic source-slicing (~5–10% of T1)
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  source_linter.py — Layer 1 (FREE)   │
│  word count · sections · code density│  FAIL → abort before any API call
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  analyzer.py — Stage 1               │  Premium model · runs ONCE · cached
│  MD5(source) → SQLite cache check    │  Cache hit = 0 tokens, ~0ms
│  Cache miss → LLM → ConceptMap       │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  source_linter.py — Layer 2 (FREE)   │
│  concept density · procedural rich.  │  FAIL → abort
└───────────────┬──────────────────────┘
                │
       ┌────────▼──────────────────────────────────────────────────┐
       │  GUARANTEE-N RETRY LOOP  (up to guarantee_n_retries)       │
       │                                                             │
       │  ┌──────────────────────────────────────────────────────┐  │
       │  │  generator.py — Stage 2                              │  │
       │  │  One LLM call per active Bloom level (fan-out)       │  │
       │  │  Each call uses its own bloom_temperatures[level]    │  │
       │  │  Generates n × over_generation_factor candidates     │  │
       │  └────────────────────┬─────────────────────────────────┘  │
       │                       │                                     │
       │  ┌────────────────────▼─────────────────────────────────┐  │
       │  │  validators.py — 7 deterministic checks (FREE)       │  │
       │  │  source grounding · uniqueness · option count        │  │
       │  │  length parity · bloom/difficulty · source phrases   │  │
       │  └────────────────────┬─────────────────────────────────┘  │
       │                       │                                     │
       │  ┌────────────────────▼─────────────────────────────────┐  │
       │  │  critic.py — Stage 3                                 │  │
       │  │  T3 fingerprints → find relevant source section      │  │
       │  │  LLM evaluates against 13 quality criteria           │  │
       │  └─────────┬───────────────────────┬────────────────────┘  │
       │          PASS                    FAIL                       │
       │            │              ┌────────▼─────────────────────┐  │
       │            │              │  reframer.py — Stage 4       │  │
       │            │              │  Classify → A/B/C/D/E/SKIP   │  │
       │            │              │  Targeted fix → re-validate  │  │
       │            │              └────────┬─────────────────────┘  │
       │            │                    PASS / FAIL                  │
       │            └──────────┬───────────────────────────────────  │
       │              accepted >= target? → exit · else next retry   │
       └───────────────────────────────────────────────────────────--┘
                │
                ▼
┌──────────────────────────────────────┐
│  supabase_gate.py (if enabled)        │  token_set_ratio dedup · renumber
│  fetch existing → similarity filter  │  idempotent push (skip dup run_id)
└───────────────┬──────────────────────┘
                │
                ▼
        logs/runs.db (SQLite)       output/ JSON files (4 per run)
```

**Token efficiency — why the tiered approach matters:**

| Stage | Naïve (full doc every call) | Tiered (T1/T2/T3) | Saving |
|---|---|---|---|
| Analyzer | 5 000 tok × every run | 5 000 tok × 1, then 0 | 100% on repeats |
| Generator input (10 MCQs) | ~50 000 tok | ~15 000 tok | ~70% |
| Critic input per MCQ | ~5 000 tok | ~600 tok | ~88% |
| **Total for 10 MCQs** | **~105 000 tok** | **~27 500 tok** | **~74%** |

### 2.3 GUI Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Electron App  (gui/)                                  │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Renderer Process  (Vite + React 18 + TypeScript)                        │ │
│  │                                                                           │ │
│  │  App.tsx                                                                  │ │
│  │   ├─ NavRail  (64 px icon rail — Zustand activeTab)                      │ │
│  │   ├─ StatusBar  (SQLite row counts · model routing · session cost)        │ │
│  │   └─ Tab pane  (lazy-rendered on nav)                                     │ │
│  │       ├─ ModelTab     6 config sections · profile save/load · YAML write  │ │
│  │       ├─ DashboardTab 4 sub-tabs: Overview · Quality · Cost · History     │ │
│  │       ├─ FilesTab     graphical SQL query · card/table views · export     │ │
│  │       ├─ RunTab       upload → linter → config → live timeline + feed     │ │
│  │       └─ EvalSetTab   create/annotate/export question eval sets           │ │
│  │                                                                           │ │
│  │  State: Zustand store (activeTab · runState · dbReady)                   │ │
│  │  Charts: Recharts 3.x (7 chart components)                               │ │
│  │  Icons: Lucide-React                                                      │ │
│  └──────────────────────────────────────┬────────────────────────────────── ┘ │
│            contextBridge  (preload.ts — window.api — FROZEN contract)        │
│  ┌──────────────────────────────────────▼────────────────────────────────── ┐ │
│  │  Main Process  (Electron Node.js)                                         │ │
│  │                                                                            │ │
│  │  ipc.ts        30+ ipcMain.handle handlers (namespaced: db / run /        │ │
│  │                config / lint / export / evalset / supabase / file)        │ │
│  │  db.ts         sql.js WASM snapshot · reload() after runs · read-only    │ │
│  │  sidecar.ts    spawn Python · readline NDJSON stream · forward events     │ │
│  │  modelConfig.ts YAML Document setIn · comment-preserving config writes    │ │
│  │  export.ts     JSON / DOCX / PDF / XLSX builders                         │ │
│  │  evalset.ts    eval-sets/ JSON CRUD (list / load / save / delete)         │ │
│  │  outputs.ts    reads output/*_run_config.json for per-stage token data    │ │
│  │  lint.ts       Layer-1 linter via Python sidecar (--json flag)            │ │
│  │  paths.ts      resolvePython(): MCQ_PYTHON env → .venv/conda → PATH      │ │
│  └──────────────────────────────────────┬────────────────────────────────── ┘ │
│                                          │ spawn(python -m mcq_agent.cli)      │
│  ┌───────────────────────────────────────▼────────────────────────────────── ┐ │
│  │  Python Sidecar  (mcq_agent.cli --json-events)                            │ │
│  │                                                                             │ │
│  │  NDJSON event stream on stdout → readline → ipcRenderer 'pipeline:event'  │ │
│  │  Events: stage_start · stage_done · question_accepted · question_rejected  │ │
│  │           run_complete · error · linter_result                             │ │
│  └─────────────────────────────────────────────────────────────────────────── ┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.4 Two-Store Data Architecture

```
                         Python Pipeline writes
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────┐
│             logs/runs.db  (SQLite — audit log)            │
│                                                           │
│  runs          ─ every pipeline execution, config snap   │
│  mcqs          ─ ALL questions: accepted (passed=1)       │
│                  AND rejected (passed=0) with critique    │
│  concept_maps  ─ MD5-keyed ConceptMap cache              │
│                                                           │
│  GUI reads via sql.js WASM (no native build needed)       │
│  Python owns all writes; GUI reads are snapshot-safe      │
└────────────────────────────┬─────────────────────────────┘
                             │
                   supabase_gate.py (optional)
                   ┌─────────┴────────────────┐
                   │  1. Fetch all existing    │
                   │  2. token_set_ratio dedup │
                   │  3. Renumber survivors    │
                   │  4. Idempotent push       │
                   └─────────┬────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│            Supabase  (cloud — optional)                   │
│                                                           │
│  Only accepted + deduplicated questions                   │
│  Gapless sequential question_number                       │
│  Promoted columns: difficulty · bloom_level · source      │
│  v_questions view for fast navigation queries             │
└───────────────────────────────────────────────────────────┘
```

---

## 3. Environment Setup

### 3.1 Prerequisites

**Python stack (required for both CLI and GUI):**

| Requirement | Version | Check |
|---|---|---|
| Python | 3.10 or 3.11 | `python --version` |
| pip | 22+ | `pip --version` |
| An LLM API key | — | See §3.3 |

**GUI stack (optional — only needed for the Electron desktop app):**

| Requirement | Version | Check |
|---|---|---|
| Node.js | 18 LTS or 20 LTS | `node --version` |
| npm | 9+ | `npm --version` |

---

### 3.2 Python Environment

Choose **one** of the following approaches. Conda is recommended because it isolates Python itself and avoids conflicts with system packages.

#### Option A — Conda

```bash
# Create and activate the environment
conda create -n mcq python=3.11 -y
conda activate mcq

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt
pip install -e .
```

To activate in future sessions: `conda activate mcq`

#### Option B — venv

```bash
# Create the virtual environment
python -m venv .venv

# Activate
source .venv/bin/activate          # macOS / Linux
.\.venv\Scripts\Activate.ps1       # Windows PowerShell
.\.venv\Scripts\activate.bat       # Windows CMD

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt
pip install -e .
```

To activate in future sessions: `source .venv/bin/activate` (or the Windows equivalent above).

#### Create required directories

```bash
mkdir -p output logs
```

#### Verify

```bash
mcq-agent --help
python -m pytest tests/ -v      # 5 smoke tests, no API calls needed
```

---

### 3.3 API Keys (.env)

Copy the example file and fill in your key:

```bash
cp .env.example .env
```

```env
# OpenRouter (recommended — one key for all models):
OPENROUTER_API_KEY=sk-or-your-key-here

# Groq (if using provider: groq):
GROQ_API_KEY=gsk_your-key-here

# Anthropic (if using provider: anthropic):
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Supabase (only required if enable_supabase: true in config.yaml):
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=eyJhbGci...   # Secret (service_role) key — NOT the anon key
```

You only need the key that matches the `provider:` value in `config.yaml`.

---

### 3.4 GUI Setup (Node.js)

```bash
cd gui
npm install
```

No further build step is needed for development. The GUI finds the Python interpreter automatically in this order:

1. `MCQ_PYTHON` environment variable (if set)
2. `.venv/bin/python` (or `.venv/Scripts/python.exe` on Windows) inside the repo root
3. `python` on `PATH` — which picks up the active conda environment

> **Tip — using conda with the GUI:** If you activated `conda activate mcq` before launching `npm run dev`, the GUI will find the correct Python via `PATH` automatically. No extra configuration needed.

> **Windows extract quirk:** If Electron's installer silently fails mid-extract (leaving only `LICENSES.chromium.html`), fix it without re-downloading:
>
> ```powershell
> $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter *.zip | Select -First 1
> Remove-Item -Recurse -Force node_modules\electron\dist
> Expand-Archive $zip.FullName node_modules\electron\dist -Force
> Set-Content node_modules\electron\path.txt "electron.exe" -NoNewline -Encoding ascii
> ```

---

### 3.5 Verify the Install

```bash
# Python
mcq-agent --help
python -m pytest tests/ -v
mcq-agent generate examples/sample_lesson.md --count 3

# GUI
cd gui
npm run build       # TypeScript + Vite build check
npm run dev         # opens Electron window
```

---

## 4. Running the Application

### 4.1 CLI

```bash
# Generate questions from a Markdown file
mcq-agent generate path/to/lesson.md

# Common options
mcq-agent generate lesson.md --count 20 --difficulty hard
mcq-agent generate lesson.md --count 10 --topic-tag MY_TOPIC --run-name "Week 3 basics"
mcq-agent generate lesson.md --count 10 --subtopics "TOPIC_A,TOPIC_B,TOPIC_C"
mcq-agent generate lesson.md --count 10 --course MY_COURSE_TAG
mcq-agent generate lesson.md --config path/to/custom_config.yaml

# View history
mcq-agent list-runs
mcq-agent list-runs --limit 5

# Inspect a run
mcq-agent show-run <run-uuid>
mcq-agent show-run <first-8-chars>     # short ID works

# Manage tags
mcq-agent list-tags
mcq-agent list-courses

# Backfill tags on existing runs
mcq-agent retag --all --topic-tag MY_TOPIC --course MY_COURSE

# Push to Supabase (requires enable_supabase: true + keys in .env)
mcq-agent push-supabase --latest
mcq-agent push-supabase --latest --dry-run
```

Output is written to `output/` — see [§13 Output Files](#13-output-files).

---

### 4.2 Electron GUI

```bash
cd gui

# Development (hot-reload)
npm run dev
# Electron window opens automatically.

# Production build
npm run build
# Then: npx electron .   (from gui/ directory)
```

**What the GUI requires at runtime:**

- `logs/runs.db` — SQLite database (auto-created on first pipeline run)
- `config.yaml` — pipeline configuration (repo root)
- Python in the environment (`.venv/` or active conda env)
- `output/` — pipeline output files (for per-stage token data in Dashboard)
- `eval-sets/` — eval set JSON files (auto-created on first use)

---

## 5. Configuration Reference (config.yaml)

All runtime settings live in `config.yaml` at the project root. Changes take effect on the next run — no restart needed. The **Model tab** in the GUI provides a graphical editor for this file with live validation and comment-preserving writes.

```yaml
# ── LLM Provider ──────────────────────────────────────────────────────────
provider: openrouter           # anthropic | groq | openrouter
model: google/gemini-2.5-flash

# Per-stage model overrides. Use null to fall back to the global model above.
# All three stages currently use google/gemini-3.5-flash ($1.50 in / $9.00 out per 1M).
analyzer_provider: openrouter
analyzer_model: google/gemini-3.5-flash

generator_provider: openrouter
generator_model: google/gemini-3.5-flash

critic_provider: openrouter
critic_model: google/gemini-3.5-flash

# ── Question Generation ────────────────────────────────────────────────────
num_questions: 10              # target accepted questions per run
difficulty: medium             # easy | medium | hard | expert
question_type: single_correct  # single_correct | multiple_correct | ordering
num_options: 4                 # options per question (3–6)
over_generation_factor: 2.0    # generate 2× the target; critic filters down
mixed_question_types: true     # mix single_correct, ordering, multiple_correct

# ── Quality Control ────────────────────────────────────────────────────────
source_grounding_threshold: 0.55   # fuzzy-match ratio (0.0–1.0)
guarantee_n_retries: 20            # Generator+Critic retry loops before giving up

# ── Token Budgets Per Stage ────────────────────────────────────────────────
max_tokens: 32000
critic_max_tokens: 4000
analyzer_max_tokens: 32000

# ── LLM Temperatures ──────────────────────────────────────────────────────
temperature: 0.5
critic_temperature: 0.5
analyzer_temperature: 0.5

# Per-Bloom temperatures for the Generator fan-out
bloom_temperatures:
  remember: 0.5
  understand: 0.6
  apply: 0.7
  analyze: 0.7
  evaluate: 0.8
  create: 0.9

# ── Source Linter Thresholds ───────────────────────────────────────────────
linter_min_words: 300
linter_min_sections: 2
linter_min_words_per_section: 50
linter_min_concept_density: 0.2
linter_fail_on_warn: false

# ── Retry / Rate Limit ────────────────────────────────────────────────────
api_max_retries: 3
api_retry_initial_backoff: 2.0

# ── Pricing (cost reporting only — does not affect generation) ────────────
# Verify current rates at https://openrouter.ai/models
# Updated 2026-06-29: google/gemini-3.5-flash = $1.50 in / $9.00 out per 1M tokens.
pricing:
  input_per_million_tokens: 1.50
  output_per_million_tokens: 9.00

generator_pricing:
  input_per_million_tokens: 1.50
  output_per_million_tokens: 9.00

critic_pricing:
  input_per_million_tokens: 1.50
  output_per_million_tokens: 9.00

# ── Token compression (Headroom) ──────────────────────────────────────────
# Compresses LLM input before every API call. Highest impact on Generator
# calls (ConceptMap JSON + T2 prose). Reduces generator input tokens by ~50–70%.
use_headroom: true

# ── Per-Bloom generation mode ─────────────────────────────────────────────
# false (default) = single batched Generator call at flat temperature.
# true = one Generator call per active Bloom level, each at its bloom_temperatures value.
enable_per_bloom_generation: false

# ── Tagging ───────────────────────────────────────────────────────────────
# topic_tag: null         # set a fixed tag; null → interactive CLI prompt
is_public: true           # adds "IS_PUBLIC" to every MCQ's tag list
course_tag: MY_COURSE     # appended to every MCQ's tag list

# ── Cloud Storage ─────────────────────────────────────────────────────────
enable_supabase: false
supabase_similarity_threshold: 80   # 0–100; lower = stricter dedup

# ── Output ────────────────────────────────────────────────────────────────
output_format: json
include_rejected_in_output: false

# ── Logging ───────────────────────────────────────────────────────────────
log_level: INFO
log_db_path: logs/runs.db

# ── Paths ─────────────────────────────────────────────────────────────────
prompts_dir: mcq_agent/prompts
few_shot_examples_file: mcq_agent/prompts/few_shot_examples.json
```

**Common config adjustments:**

| Goal | Change |
|---|---|
| More questions | `num_questions: 50`; raise `guarantee_n_retries` |
| Fewer grounding failures | Lower `source_grounding_threshold` to `0.50–0.60` |
| Premium Analyzer only | `analyzer_model: google/gemini-2.5-pro` |
| Per-Bloom generation | `enable_per_bloom_generation: true` (~4–5× input tokens, richer diversity) |
| Disable token compression | `use_headroom: false` |
| Switch to Groq | Change all `*_provider` to `groq`, update model IDs |
| Disable cloud sync | `enable_supabase: false` |
| Stricter dedup | Lower `supabase_similarity_threshold` to `70` |

---

## 6. LLM Providers

| Provider | Env var | Model format | Example |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `provider/model-name` | `google/gemini-2.5-flash` |
| Groq | `GROQ_API_KEY` | plain model ID | `llama-3.3-70b-versatile` |
| Anthropic | `ANTHROPIC_API_KEY` | plain model ID | `claude-sonnet-4-6` |

**OpenRouter** is recommended — one key gives access to Gemini, Claude, GPT-4o, Llama, Mistral, and hundreds more.

### Model selection guide

| Stage | Priority | Recommended |
|---|---|---|
| Analyzer | Quality > Cost — runs once, cached | `google/gemini-3.5-flash` (current), `google/gemini-2.5-pro` (premium) |
| Generator | Quality + instruction-following | `google/gemini-3.5-flash`, `claude-sonnet-4-6` |
| Critic | Speed > Cost — runs once per MCQ | `google/gemini-3.5-flash`, `llama-3.1-8b-instant` |

> **Current production config (2026-06-29):** All three stages use `google/gemini-3.5-flash` via OpenRouter at **$1.50 in / $9.00 out per 1M tokens**.

### Example: cost-optimised mixed config

```yaml
provider: openrouter
analyzer_provider: openrouter
analyzer_model: google/gemini-2.5-pro       # premium once, then cached
generator_provider: openrouter
generator_model: google/gemini-3.5-flash
critic_provider: groq
critic_model: llama-3.1-8b-instant          # fastest for per-MCQ eval
```

---

## 7. The Pipeline — Stage by Stage

### Stage 0 — Parse

**File:** `mcq_agent/parser.py`

Reads the `.md` file once and builds all three document tiers:

- **T1 `raw_text`** — verbatim file content. Only the Analyzer uses this.
- **T2 `section_summaries`** — first 3 sentences of prose + all code blocks per section. ~30–60% of T1 tokens. Generator and Reframer use this.
- **T3 `section_fingerprints`** — section heading + top-20 key terms. ~5–10% of T1. Critic source-slicing uses this.

---

### Stage 1 — Analyze

**File:** `mcq_agent/analyzer.py`

Sends T1 (full document) to the LLM and extracts a `ConceptMap` — a structured knowledge graph.

**Caching:** Computes the MD5 hash of the source file, queries the SQLite `concept_maps` table. Cache hit → instant return at zero token cost. Cache is permanent — run against the same file a hundred times, pay the LLM once.

A `ConceptMap` contains concepts (with testability score 1–5, confusion pairs for distractor replacement), procedures, technical facts, code examples, thematic clusters, and prerequisite chains.

---

### Stage 2 — Generate

**File:** `mcq_agent/generator.py`

Takes T2 + compact `ConceptMap` and generates MCQ candidates.

**Per-Bloom fan-out:** Generation fans across every Bloom level the source supports. Each level gets its own LLM call at its own temperature from `bloom_temperatures`.

**Multi-subtopic mode:** Pass `--subtopics TOPIC_A,TOPIC_B,TOPIC_C` to inject a directive asking the LLM to assign each question's `sub_topic` field to the best-fit subtopic from the list.

**Mixed types:** With `mixed_question_types: true`, distributes across `single_correct`, `ordering`, and `multiple_correct`.

---

### Stage 3 — Critique

**File:** `mcq_agent/critic.py`

Each MCQ is evaluated independently against 13 quality criteria. The Critic uses T3 fingerprints to locate the single relevant source section — it never reads the full document.

**The 13 quality criteria:**

| # | Criterion |
|---|---|
| a | Source grounding (excerpt matches document) |
| b | Unique correct answer |
| c | Factual accuracy |
| d | Distractor plausibility |
| e | Stem clarity |
| f | Bloom level matches declared difficulty |
| g | Explanation quality |
| h | Source heading accuracy |
| i | Stem economy (no non-load-bearing context) |
| j | Option length parity |
| k | Source-phrase independence |
| l | Distractor rationale present for all wrong options |
| m | No option immediately eliminable as absurd |

---

### Stage 4 — Reframe

**File:** `mcq_agent/reframer.py`

Classifies the failure and applies the minimum intervention rather than discarding the question.

| Class | Failure | Fix |
|---|---|---|
| A | Length parity — correct answer >30% longer | Expand distractors using ConceptMap confusion pairs |
| B | Source excerpt doesn't match document | Re-ground: find verbatim excerpt from source section |
| C | Distractors implausible or ungrounded | Replace using ConceptMap confusion pairs |
| D | Correct answer contains unsourced claims | Trim to source-supported content only |
| E | Both B and A fail | Fix B first, then A |
| SKIP | Structural failure | Not reframeable — rejected |

---

### Quality Gates

**Validators (`validators.py`) — 8 deterministic checks, all free:**

| # | Check |
|---|---|
| 1 | `source_grounding` — fuzzy-match score < threshold |
| 2 | `uniqueness` — wrong correct option count (`multiple_correct` requires ≥2 correct) |
| 3 | `ordering_structure` — ordering steps present + every option is a valid permutation of `1..N` |
| 4 | `option_count` — doesn't match `num_options` |
| 5 | `distractor_rationales` — missing rationale on any wrong option |
| 6 | `bloom_difficulty_alignment` |
| 7 | `length_parity` — correct answer >30% longer than median distractor |
| 8 | `source_phrase_overlap` — 5-gram verbatim copy from excerpt |

> `ordering_structure` is the guard against the failure where an ORDERING question's numbered steps are missing, leaving only bare sequences (`3 → 1 → 4 → 2`) — an unanswerable question. Exporters also inline `ordering_statements` into the question text and join *all* correct labels for `multiple_correct` answer keys.

`shuffle_correct_answer_positions()` randomly reassigns A/B/C/D labels after generation to eliminate LLM position bias.

---

## 8. Storage: SQLite + Supabase

### SQLite (local — always active)

**Location:** `logs/runs.db`

| Table | Key columns |
|---|---|
| `runs` | `run_id` · `timestamp` · `input_file` · `config_json` · `passed_count` · `cost_usd` · `generation_number` · `run_name` · `topic_tag` · `course_tag` · `subtopics_json` |
| `mcqs` | `id` · `run_id` · `mcq_json` · `passed` (1/0) · `critique_json` · `question_number` |
| `concept_maps` | `file_hash` (MD5) · `source_file` · `concept_map_json` |
| `topic_tags` | `tag` — catalog of topic tags |
| `courses` | `name` — catalog of course names |

```bash
# Useful raw queries
sqlite3 logs/runs.db "SELECT run_id, run_name, topic_tag, passed_count FROM runs;"
sqlite3 logs/runs.db "SELECT COUNT(*) FROM mcqs WHERE passed=1;"
sqlite3 logs/runs.db "DELETE FROM concept_maps;"   # clear analyzer cache
```

### Supabase (cloud — optional)

Purpose: a clean, deduplicated cloud question bank with gapless sequential numbering.

**Setup:**
1. Create project at https://supabase.com
2. SQL Editor → run `supabase_schema.sql`
3. Copy **Project URL** → `SUPABASE_URL` in `.env`
4. Copy **Secret (service_role)** key → `SUPABASE_KEY` in `.env`
5. `config.yaml`: `enable_supabase: true`

**Deduplication:** Uses `rapidfuzz.fuzz.token_set_ratio` — order-insensitive, catches paraphrasing. Questions scoring ≥ `supabase_similarity_threshold` are dropped before the cloud push.

---

## 9. GUI Tab Reference

| Tab | What it does |
|---|---|
| **Model** | Graphical editor for `config.yaml` — 6 sections (provider, generation, quality, tokens, temperatures, linter). Profile save/load. Comment-preserving YAML writes. |
| **Dashboard** | 4 sub-tabs: **Overview** (KPI strip + 4 charts + **Sub-topic Coverage panel**), **Quality** (validator failures, reframer classes, Critic heatmap, source linter stats), **Cost & Tokens** (cumulative cost, cache-hit rate, per-stage token breakdown), **Run History** (sortable table). |
| **Files** | Graphical query builder (difficulty · bloom · type · source · heading · date range). Card and table views. Export to **JSON / DOCX / PDF / XLSX**. **Question Paper Builder** — allocate questions per subtopic with per-difficulty counts; shows **shortfall panel** for undertocked subtopics after fetch. DB management panel with Supabase push and local dedup. |
| **Run** | Upload `.md` → source quality card → run config (count, difficulty, type, **subtopic tags**) → live execution timeline → accepted question feed. Multiple topic tags supported; the LLM assigns each question to the best-fit one. Tab stays mounted during navigation — switching tabs never interrupts a live run. |
| **Eval Set** | Create named question sets (e.g. the archived bank). Browse & Annotate: 5-star rating, Correct/Wrong toggle, notes, source excerpt. Quality Summary panel. **Promote to few-shot** — push your top-rated, confirmed-correct questions into `few_shot_examples.json` to steer future generation. Import/export JSON. |

### Dashboard — Sub-topic Coverage Panel

The **Overview** sub-tab includes a dynamic Sub-topic Coverage panel at the bottom. It queries `topic_tags` vs the `mcqs` table on every dashboard load to show how many accepted questions exist for each registered subtopic, broken down by difficulty (Easy / Medium / Hard). 

- **Status badges:** Green = "Good" (≥20 questions), Yellow = "Low" (<20), Red = "Empty" (0).
- **Coverage bar:** Proportional fill relative to the highest-count subtopic.
- **Attention strip:** Lists all subtopics below the 20-question threshold with a direct pointer to the Run tab.
- **Dynamic:** As soon as a new `topic_tag` is added to the catalog and questions are generated, the panel shows the new row automatically — no config change needed.

### Files — Question Paper Builder Shortfall Panel

After fetching questions in the Paper Builder (subtopic allocation mode), if any subtopic/difficulty combination could not be fully filled, a **Shortfall Panel** appears below the question summary. It lists each gap — subtopic, difficulty, how many were requested vs available — so you know exactly which topics to run next to fill the paper. A footer link points to the Run tab.

### Dashboard Sub-tabs in Detail

| Sub-tab | Content |
|---|---|
| **Overview** | 6 KPI cards (total questions, accepted, rejected, acceptance rate, cost, avg cost/question) · Questions per generation chart · Type distribution donut · Cost per run bar chart · Difficulty distribution · Sub-topic Coverage panel |
| **Quality** | Validator failure breakdown · Reframer class distribution · Critic criteria heatmap (pass rate per criterion per run) · Source linter stats (PASS/WARN/FAIL per check) |
| **Cost & Tokens** | Cumulative cost curve with trend line · Analyzer cache hit rate · Per-stage token usage (analyzer/generator/critic/reframer in+out) · Cost per accepted question |
| **Run History** | Full run log — generation number, timestamp, source file, generated/accepted/rejected counts, cost per run |

---

## 10. Module Reference

### Pipeline package (`mcq_agent/`)

| Module | Role |
|---|---|
| `cli.py` | Typer CLI — `generate`, `list-runs`, `show-run`, `push-supabase`, `lint`, `config-dump`, `list-tags`, `list-courses`, `retag` |
| `pipeline.py` | Orchestrator — all stages in order, guarantee-n retry, output files |
| `parser.py` | Markdown → `ParsedDocument` (T1/T2/T3 tiers) |
| `analyzer.py` | Stage 1 — `ConceptMap` extraction with MD5 SQLite cache |
| `generator.py` | Stage 2 — per-Bloom fan-out MCQ generation |
| `critic.py` | Stage 3 — per-MCQ evaluation with T3 source slicing |
| `reframer.py` | Stage 4 — 5-class targeted salvage; re-validates after each fix |
| `validators.py` | 7 deterministic checks; `shuffle_correct_answer_positions()` |
| `source_linter.py` | Layer 1+2 source quality gates |
| `schemas.py` | 40+ Pydantic v2 models for all data structures |
| `config.py` | Loads `config.yaml` + `.env`; per-stage model resolution |
| `llm_client.py` | Provider-agnostic wrapper — Anthropic, Groq, OpenRouter |
| `storage.py` | SQLite persistence — runs, mcqs, concept_maps tables |
| `sub_topic_matcher.py` | Tag assignment — `assign_tags()` builds `[TOPIC, BLOOM, IS_PUBLIC, COURSE]` per MCQ |
| `similarity.py` | Dedup core: `composite_text()`, `best_match()`, `filter_questions()` |
| `supabase_gate.py` | Cloud sync: fetch → similarity filter → renumber → push |

### GUI electron modules (`gui/electron/`)

| Module | Role |
|---|---|
| `main.ts` | Electron entry — creates `BrowserWindow`, calls `registerIpc()` |
| `ipc.ts` | 30+ `ipcMain.handle` handlers |
| `preload.ts` | `contextBridge.exposeInMainWorld('api', ...)` — frozen renderer contract |
| `db.ts` | sql.js WASM read-only snapshot; `reload()` after pipeline runs |
| `sidecar.ts` | Spawn Python subprocess; readline NDJSON stream → renderer events |
| `paths.ts` | `resolvePython()`, `REPO_ROOT`, `DB_PATH`, `CONFIG_PATH` |
| `modelConfig.ts` | YAML `Document` (comment-preserving) config read/write |
| `export.ts` | JSON / DOCX / PDF / XLSX builders |
| `evalset.ts` | `eval-sets/` JSON CRUD |
| `paperQuery.ts` | Question paper query layer (Supabase → SQLite fallback) |

### Scripts (`scripts/`)

| Script | Role |
|---|---|
| `scripts/check_similarity.py` | Check a JSON file for near-duplicates vs local SQLite DB |
| `scripts/migrate_to_supabase.py` | Push runs to Supabase; `--latest`, `--run-id`, `--dry-run` |
| `scripts/archive_and_retag.py` | Re-tag untagged questions into the module tags via LLM, drop non-matches, archive survivors to an eval set, and consolidate the DB under one run. `--apply` gates DB mutation; backs up first. See [§17](#17-maintenance-archive--re-tag). |
| `scripts/dedup_db.py` | Detect and remove near-duplicate questions from the local SQLite bank using `token_set_ratio`. Supports `--threshold`, `--apply` (dry-run by default), and `--include-supabase` to also deduplicate against the cloud bank. Emits NDJSON events for the GUI's DB Management dedup panel. |
| `scripts/setup_venv.ps1` / `setup_venv.bat` | Windows helper — create `.venv`, install deps, run smoke tests |

---

## 11. Data Models

All models live in `mcq_agent/schemas.py` (Pydantic v2).

### MCQ

```
MCQ
├── question               str
├── options                List[Option]
│   ├── label              str              "A" | "B" | "C" | "D"
│   ├── text               str
│   ├── is_correct         bool
│   └── distractor_rationale  str | None
├── explanation            str
├── source_excerpt         str              verbatim quote from document
├── source_heading         str
├── bloom_level            BloomLevel       remember|understand|apply|analyze|evaluate|create
├── difficulty             Difficulty       easy | medium | hard | expert
├── question_type          QuestionType     single_correct | multiple_correct | ordering
├── stem_pattern           StemPattern      definition|scenario|debugging|comparison|procedure
├── ordering_statements    List[str] | None for ordering questions
├── tags                   List[str]        [TOPIC_TAG, BLOOM_LEVEL, "IS_PUBLIC", COURSE_TAG]
├── sub_topic              str | None       topic tag assigned to this question
├── question_number        int | None       global sequential number
└── generation_number      int | None       which run produced this
```

**Tag format:**

```
["MY_TOPIC", "APPLY", "IS_PUBLIC", "MY_COURSE"]
  ^─ topic/subtopic   ^─ Bloom     ^─ visibility  ^─ course
```

### PipelineRun

```
PipelineRun
├── run_id, timestamp, input_file
├── run_name               str | None       set with --run-name
├── subtopics              List[str]        subtopic tags used for this run
├── config                 MCQConfig
├── concept_map            ConceptMap
├── generated_count, passed_count, salvaged_count
├── final_mcqs             List[MCQ]
├── rejected_mcqs          List[tuple[MCQ, CritiqueResult]]
├── analyzer/generator/critic/reframe_cost_usd
├── total_cost_usd
└── generation_number      sequential run counter (1, 2, 3 …)
```

---

## 12. CLI Reference

### `mcq-agent generate`

```
mcq-agent generate <input_file.md> [OPTIONS]

  -i, --input             Markdown source file (positional)
  -o, --output            Output directory (default: output/)
  --count, -n             Target question count
  --difficulty, -d        easy | medium | hard | expert
  --type, -t              single_correct | multiple_correct | ordering
  --topic, -p             Lesson topic label (stored in Supabase for navigation)
  --topic-tag, -T         Topic tag applied to every question.
                          Omit to get an interactive prompt.
  --run-name              Human-readable name for this run
  --subtopics             Comma-separated list of subtopic tags; the LLM assigns
                          each question to the most appropriate one.
                          e.g. --subtopics "TOPIC_A,TOPIC_B,TOPIC_C"
  --course, -C            Course tag appended to every question's tag list
  --no-public             Mark questions as private (omit IS_PUBLIC from tags)
  --config                Path to alternate config.yaml
  --verbose, -v           DEBUG-level structured logging
  --json-events           NDJSON event stream (used internally by the GUI)
```

**Examples:**

```bash
mcq-agent generate lesson.md
mcq-agent generate lesson.md --count 20 --difficulty hard
mcq-agent generate lesson.md --count 10 --topic-tag SLAM --run-name "Week 3 SLAM"
mcq-agent generate lesson.md --subtopics "MQTT,GPIO,PWM" --topic-tag EMBEDDED
mcq-agent generate lesson.md --config configs/groq.yaml
```

### Other commands

```bash
# History
mcq-agent list-runs [--limit N]
mcq-agent show-run <run-id>         # full UUID or first 8 chars

# Tags and courses
mcq-agent list-tags
mcq-agent list-courses

# Backfill tags on existing questions
mcq-agent retag                              # interactive
mcq-agent retag --all --topic-tag X --course Y
mcq-agent retag --run-id <uuid> --topic-tag X

# Source linter (no API cost)
mcq-agent lint lesson.md
mcq-agent lint lesson.md --json             # machine-readable

# Supabase push
mcq-agent push-supabase --latest
mcq-agent push-supabase --run-id <uuid> --dry-run

# Config inspection
mcq-agent config-dump
mcq-agent config-dump --defaults
```

---

## 13. Output Files

Each generation run produces four files in `output/`:

| File | Contents |
|---|---|
| `<label>_accepted.json` | MCQ objects that passed all quality gates, with `question_number` and `generation_number`. |
| `<label>_rejected.json` | `{mcq, critique}` pairs — questions that failed. Useful for diagnosing prompt issues. |
| `<label>_source_quality.json` | Layer 1 + Layer 2 linter results with per-check pass/warn/fail status. |
| `<label>_run_config.json` | Full run metadata — config snapshot, model routing, token counts and cost per stage. |

---

## 14. Production-Grade Engineering

### Structured Output — instructor + Pydantic v2

Every LLM call returns a fully typed Pydantic v2 model. The `instructor` library wraps each provider's SDK and automatically retries on JSON parse failure or schema mismatch. There is no string parsing anywhere in the pipeline.

### Multi-Tier Document Compression — T1 / T2 / T3

| Tier | Content | Size vs T1 | Used by |
|---|---|---|---|
| T1 | Full Markdown | 100% | Analyzer (once, then cached) |
| T2 | First 3 sentences + code blocks per section | ~30–60% | Generator, Reframer |
| T3 | Heading + top-20 key terms per section | ~5–10% | Critic source-slicing |

The Critic never reads the full document — it uses T3 fingerprints to locate the single relevant section, reducing Critic input tokens by ~88%.

### MD5-Keyed Analysis Cache

The Analyzer is the most expensive stage. The pipeline caches the `ConceptMap` by `MD5(file content)` in SQLite:

- Same content → instant cache hit, 0 tokens (regardless of file path or name)
- Any content change → MD5 changes → fresh analysis

### Guarantee-N Retry with Deficit Tracking

```
Iteration 1: ask for 20 (target 10, factor 2.0) → 7 accepted → deficit 3
Iteration 2: ask for 6 (deficit 3, factor 2.0)  → 3 accepted → deficit 0 → done
```

### Fuzzy Deduplication — token_set_ratio

`rapidfuzz.fuzz.token_set_ratio` is order-insensitive, catching paraphrasing like "Which tool builds X?" vs "What tool is used to build X?". Runs inter-batch (new vs Supabase) and intra-batch (new questions vs each other).

### Per-Bloom Temperature Fan-Out

Different cognitive levels use different generation temperatures, producing more authentic questions at each Bloom level compared to a single flat call.

### Position Bias Elimination

`shuffle_correct_answer_positions()` mechanically reassigns A/B/C/D labels post-generation to eliminate the LLM's systematic position bias toward B and C.

### Comment-Preserving Config Writes

The Model tab editor uses the `yaml` npm package's `Document` API (`setIn`) to write changes without destroying user comments in `config.yaml`.

### WASM SQLite — Cross-Machine Portability

The GUI uses `sql.js` (SQLite compiled to WebAssembly) instead of native bindings — zero native build required, installs identically on any platform.

### Subprocess Lifecycle — No Mid-Run Cut-Offs

Both long-running flows are backed by a Python sidecar (`gui/electron/sidecar.ts`):
the **generation run** and the **Supabase push**. Their UI is decoupled from their
process lifecycle so nothing is silently cut off:

- The **Run tab stays mounted** while you navigate elsewhere (`App.tsx`), so an
  in-flight generation keeps streaming its events and its progress is intact when
  you return — switching tabs never stops the run.
- The **Supabase push** event listener is torn down cleanly on unmount (no leaked
  `ipcRenderer` listeners); the short push completes server-side and the dedup
  gate makes a re-push safe.
- A **single window-close handler** (registered once per window in `main.ts`)
  reaps whichever sidecar is still running, so closing the app never orphans a
  Python process that keeps consuming API quota.

### Human-in-the-Loop Few-Shot Promotion

The Eval Set tab closes the quality loop. After a human rates questions (1–5
stars + Correct/Wrong), **Promote to few-shot** appends the top-rated,
confirmed-correct ones to `few_shot_examples.json` — the example pool the
Generator draws from. The authoritative `stem_pattern` is recovered from the
DB's `mcq_json` (the eval JSON doesn't store it), so each promoted entry is
selectable by the Generator's `(bloom_level, stem_pattern)` filter. Duplicates
are skipped and the file is backed up first. This is the no-training feedback
loop: *generate → human-rate → promote the best → better future generations.*

---

## 15. Quality Rules — Design Rationale

### Stem Economy

**Problem:** Stems over-specified context defensively after receiving harsh Critic feedback — e.g. listing 5 hardware components when only one was relevant to the question.

**Rule:** Include only context that bears directly on the question. If removing a sentence doesn't change what's being asked, remove it.

**Enforcement:** Criterion (i) in the Critic prompt; anti-pattern example in the Generator prompt.

### Option Length Parity

**Problem:** The correct answer was consistently ~27–30% longer than the median distractor. Experienced test-takers learn to pick the longest option.

**Rule:** Correct answer must stay within ±20% of median distractor word count. When the correct answer is naturally longer, expand the distractors — don't trim the correct answer.

**Enforcement:** `validate_length_parity` validator (deterministic); criterion (j) in Critic; Class A Reframer fix.

### Source-Phrase Independence

**Problem:** Correct answers frequently reproduced 5+ word verbatim phrases from `source_excerpt`, allowing phrase-matching instead of understanding.

**Rule:** The correct answer must paraphrase the source, not echo it.

**Enforcement:** `validate_source_phrase_overlap` validator (5-gram matching); criterion (k) in Critic.

### Reframer Taxonomy — Targeted Fix Over Discard

The Reframer is the difference between a ~65% and ~85%+ acceptance rate. It classifies each failure into one of 5 classes and applies the minimum intervention, reserving SKIP only for structural failures that cannot be fixed without regenerating from scratch.

---

## 16. Troubleshooting

### Environment

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'mcq_agent'` | Wrong environment or package not installed | Activate your env; run `pip install -e .` |
| `mcq-agent: command not found` | Environment not active | `conda activate mcq` or `source .venv/bin/activate` |
| GUI "Python not found" | Python not on PATH and no `.venv/` found | Activate your conda env before launching `npm run dev`, or set `MCQ_PYTHON=/path/to/python` |
| GUI shows blank window | Electron extract failed (Windows) | See §3.4 for the Expand-Archive fix |

### API and Authentication

| Symptom | Cause | Fix |
|---|---|---|
| `AuthenticationError` / HTTP 401 | Wrong or missing API key | Check `.env` matches `provider` in `config.yaml` |
| HTTP 404 from OpenRouter | Wrong model ID format | Use `provider/model-name` format, e.g. `google/gemini-2.5-flash` |
| Supabase 403 | Using anon key | Replace with **Secret (service_role)** key |
| Supabase auth broken with correct key | `.env` parser truncated base64 value at `=` | Already fixed — update to latest code |

### Generation Quality

| Symptom | Cause | Fix |
|---|---|---|
| All questions fail source grounding | `source_grounding_threshold` too high | Lower to `0.50–0.60` |
| Run produces 0 accepted questions | Source too thin | Check `*_source_quality.json`; ensure 300+ words, 2+ sections |
| `guarantee_n_retries` exhausted | Thresholds too strict | Raise `guarantee_n_retries`; lower `source_grounding_threshold` |
| Subtopic not assigned to any question | Single subtopic passed but not injected | Already fixed — update to latest code |

### Cost and Performance

| Symptom | Cause | Fix |
|---|---|---|
| High Analyzer cost on every run | Cache not populating | Check `logs/` is writable; `sqlite3 logs/runs.db "SELECT COUNT(*) FROM concept_maps;"` |
| Dashboard charts empty | No runs in DB yet | Run at least one `mcq-agent generate` first |
| clearConceptCache destroyed recent rows | Stale snapshot overwrite | Already fixed — update to latest code |

### Source Quality Linter

| Failure | Meaning | Fix |
|---|---|---|
| `word_count FAIL` | Document too short (< 300 words) | Add more content |
| `concept_density FAIL` | Too few concepts per section | Add explicit definitions and procedures |
| `technical_facts FAIL` | No unambiguous facts | Add numbered specs, benchmarks, or commands |
| `code_blocks WARN` | No code in a technical document | Add at least one code example |

### GUI Behaviour

| Symptom | Cause | Fix |
|---|---|---|
| Run appears to stop when switching tabs | Old build unmounted the Run tab | Already fixed — the Run tab now stays mounted; restart the GUI to load the fix |
| Generations tab cluttered with many old runs | Accumulated history | Run `scripts/archive_and_retag.py --apply` to consolidate ([§17](#17-maintenance-archive--re-tag)) |
| Paper Builder lists only a few sub-topics | Only sub-topics seen on questions were shown | Already fixed — it now lists the full topic-tag catalog; restart the GUI |
| GUI shows stale data after running a script | sql.js holds an in-memory snapshot | Restart the GUI (or trigger a pipeline run) to reload the DB |

---

## 17. Maintenance: Archive & Re-tag

`scripts/archive_and_retag.py` resets the question bank to a clean baseline before a new round of generations. It:

1. LLM-classifies every passed question that lacks a valid module tag into exactly one of the configured topic tags (the `topic_tags` catalog).
2. Drops any question that doesn't fit one of those tags.
3. Writes all survivors into a single eval set under `eval-sets/`, each carrying its `sub_topic` + the 4-element `tags` list.
4. Consolidates the survivors in `logs/runs.db` under one new run (generation 1) and deletes the other runs + rejected questions — so the Generations tab is a single clean entry and the next real run auto-numbers as generation 2.

```bash
# 1. Dry run — classify, write the eval set, print the distribution, NO DB change
python scripts/archive_and_retag.py

# 2. Apply — back up runs.db, consolidate under one run, prune the rest
python scripts/archive_and_retag.py --apply

# Re-run classification from scratch (ignore the cache)
python scripts/archive_and_retag.py --refresh
```

**Safety:**
- `runs.db` is copied to a timestamped `runs.db.bak-*` before any mutation.
- Classifications are cached to `output/retag_classifications.json` so re-runs don't repeat LLM calls.
- The DB is only modified with `--apply`; the mutation runs in a transaction that restores the backup on error.
- After `--apply`, restart the GUI so its in-memory DB snapshot reloads.

---

*MCQ Agent — open for contributions. Issues and PRs welcome.*
