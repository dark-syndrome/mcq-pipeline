# MCQ Pipeline — Master Reference

> **Returning after a break?** Jump to [Quick-Start Checklist](#0-quick-start-checklist).

---

## Table of Contents

0. [Quick-Start Checklist](#0-quick-start-checklist)
1. [What This Project Does](#1-what-this-project-does)
2. [Architecture Overview](#2-architecture-overview)
3. [Environment Setup (from scratch)](#3-environment-setup-from-scratch)
   - 3.1 [Prerequisites](#31-prerequisites)
   - 3.2 [Create the virtual environment](#32-create-the-virtual-environment)
   - 3.3 [Configure API keys (.env)](#33-configure-api-keys-env)
   - 3.4 [Verify the install](#34-verify-the-install)
4. [Configuration Reference (config.yaml)](#4-configuration-reference-configyaml)
5. [LLM Providers](#5-llm-providers)
6. [The Pipeline — Stage by Stage](#6-the-pipeline--stage-by-stage)
   - [Stage 0 — Parse](#stage-0--parse)
   - [Stage 1 — Analyze](#stage-1--analyze)
   - [Stage 2 — Generate](#stage-2--generate)
   - [Stage 3 — Critique](#stage-3--critique)
   - [Stage 4 — Reframe](#stage-4--reframe)
   - [Quality Gates](#quality-gates)
   - [Guarantee-N Retry Loop](#guarantee-n-retry-loop)
7. [Storage: SQLite + Supabase](#7-storage-sqlite--supabase)
   - 7.1 [SQLite (local — always active)](#71-sqlite-local--always-active)
   - 7.2 [Concept Map Cache](#72-concept-map-cache)
   - 7.3 [Supabase (cloud — optional)](#73-supabase-cloud--optional)
   - 7.4 [Deduplication Algorithm](#74-deduplication-algorithm)
8. [Module Reference](#8-module-reference)
9. [Data Models](#9-data-models)
10. [CLI Reference](#10-cli-reference)
11. [Output Files](#11-output-files)
12. [Quality Rules — Design Rationale](#12-quality-rules--design-rationale)
13. [GUI Roadmap](#13-gui-roadmap)
14. [Troubleshooting](#14-troubleshooting)

---

## 0. Quick-Start Checklist

Use this every time you return to the project after a break.

```
[ ] 1. Open a terminal in:  C:\Users\Akash\Documents\mcq_pipeline

[ ] 2. Activate the virtual environment:
        PowerShell:       .\.venv\Scripts\Activate.ps1
        Command Prompt:   .\.venv\Scripts\activate.bat
        Prompt shows (.venv) when active.

[ ] 3. If step 2 fails (venv missing), rebuild it:
        .\setup_venv.ps1        ← PowerShell
        setup_venv.bat          ← Command Prompt

[ ] 4. Confirm install is healthy:
        python -m pytest tests/ -v     (5 smoke tests, no API calls)

[ ] 5. Check .env has a valid API key for the configured provider:
        Current default provider: openrouter
        Key needed:               OPENROUTER_API_KEY=sk-or-...

[ ] 6. Run a quick test generation:
        mcq-agent generate examples/sample_lesson.md --count 3

[ ] 7. Check output/:
        ls output/    (should show 4 files per run)
```

---

## 1. What This Project Does

The **MCQ Agent** is an AI-powered pipeline that transforms Markdown lesson files into high-quality Multiple-Choice Questions ready for use in courses. Given a `.md` file, it:

1. Analyses the document and extracts a structured **concept map** (concepts, procedures, facts, code examples)
2. Generates MCQ candidates covering the lesson's key ideas using compressed document summaries
3. Runs every candidate through **7 deterministic rule checks** (free, no API cost)
4. Evaluates each candidate against **13 quality criteria** via an independent LLM Critic
5. Salvages borderline rejections through targeted rewrites (**Reframer**, 5-class taxonomy)
6. Stores all results in a local SQLite database and optionally syncs a deduplicated set to Supabase cloud

**What it is NOT:** a simple "ask GPT to write questions" script. Every MCQ must pass deterministic validators, an independent LLM critic, and a class-based reframer before it is accepted. A deduplication gate prevents re-generating questions already in the bank.

**Key design principles:**
- **Quality over quantity:** multiple retry loops + Reframer before giving up on any question
- **Cost efficiency:** the most expensive LLM call (Analyzer) is MD5-cached in SQLite and never re-runs on unchanged source files; each stage uses the cheapest model that can handle it
- **Two-store architecture:** SQLite is the authoritative local log; Supabase is the clean, deduplicated cloud bank with gapless question numbers
- **Structured output throughout:** every LLM response is a validated Pydantic model via `instructor` — never raw text

---

## 2. Architecture Overview

```
Input (.md file)
       │
       ▼
┌──────────────────────────────────────┐
│  parser.py — Stage 0                 │
│  Builds THREE document tiers at once:│
│  T1: raw_text   (full Markdown)      │ ← Analyzer only
│  T2: section_summaries               │ ← Generator, Reframer
│       (first 3 sentences + code)     │
│  T3: section_fingerprints            │ ← Critic (source slicing)
│       (heading + top-20 key terms)   │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  source_linter.py — Layer 1          │  FREE — static checks
│  word count, section count,          │  FAIL → abort before any API call
│  thin sections, code density         │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  analyzer.py — Stage 1               │  PREMIUM MODEL, runs ONCE then cached
│  Checks SQLite cache by MD5 first.   │  Cache hit = zero tokens
│  On miss: sends T1 to LLM →          │
│  returns ConceptMap, saves to cache  │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  source_linter.py — Layer 2          │  FREE — uses Analyzer output
│  concept density, procedural         │  FAIL → abort
│  richness, technical fact count      │
└───────────────┬──────────────────────┘
                │
         ┌──────▼──────────────────────────────────────────────┐
         │  GUARANTEE-N RETRY LOOP (up to guarantee_n_retries)  │
         │                                                       │
         │  ┌─────────────────────────────────────────────────┐ │
         │  │  generator.py — Stage 2                         │ │
         │  │  T2 + slim ConceptMap → candidate MCQs          │ │
         │  │  Generates n × over_generation_factor           │ │
         │  └─────────────────┬───────────────────────────────┘ │
         │                    │                                  │
         │  ┌─────────────────▼───────────────────────────────┐ │
         │  │  validators.py — 7 rule checks (FREE)           │ │
         │  │  grounding, uniqueness, length parity, etc.     │ │
         │  └─────────────────┬───────────────────────────────┘ │
         │                    │                                  │
         │  ┌─────────────────▼───────────────────────────────┐ │
         │  │  critic.py — Stage 3                            │ │
         │  │  LLM evaluates each MCQ against 13 criteria     │ │
         │  │  Uses T3 fingerprints to find relevant section  │ │
         │  └───────┬─────────────────────┬───────────────────┘ │
         │        PASS                  FAIL                     │
         │          │                    │                       │
         │          │       ┌────────────▼──────────────────┐   │
         │          │       │  reframer.py — Stage 4        │   │
         │          │       │  Classify failure → targeted  │   │
         │          │       │  fix → re-validate            │   │
         │          │       └────────────┬──────────────────┘   │
         │          │                 PASS / FAIL                │
         │          └──────────┬──────────────────────────────  │
         │               accepted_count >= target?               │
         │               YES → exit loop                         │
         │               NO  → next retry                        │
         └─────────────────────────────────────────────────────-┘
                │
                ▼
┌──────────────────────────────────────┐
│  supabase_gate.py (if enabled)        │  Cross-bank dedup via token_set_ratio
│  Fetch existing → similarity filter  │  Drops questions scoring ≥ threshold
│  → renumber survivors → push         │
└───────────────┬──────────────────────┘
                │
                ▼
        SQLite (logs/runs.db)
        output/ JSON files (4 per run)
```

**Token efficiency by tier:**

| Tier | Content | Token size vs T1 | Used by |
|------|---------|-----------------|---------|
| T1 | Full Markdown | 100% | Analyzer (once, cached) |
| T2 | First 3 sentences + code blocks per section | ~30–60% | Generator, Reframer |
| T3 | Heading + top-20 key terms per section | ~5–10% | Critic source slicing |

**Real-world token savings (example: 5000-word lesson, 10 MCQs):**

| Stage | Before T2/T3 | After T2/T3 | Saving |
|-------|-------------|-------------|--------|
| Analyzer | 5000 tokens × every run | 5000 tokens × 1, then 0 | 100% on repeat |
| Generator input | ~5000 tokens | ~1500 tokens | ~70% |
| Critic input per MCQ | ~5000 tokens | ~600 tokens | ~88% |
| **Total for 10 MCQs** | **~105,000 tokens** | **~27,500 tokens** | **~74%** |

---

## 3. Environment Setup (from scratch)

### 3.1 Prerequisites

| Requirement | Notes |
|-------------|-------|
| Python 3.10+ | Check: `python --version` |
| pip | Bundled with Python 3.10+ |
| At least one API key | OpenRouter recommended (one key, all models) |

Get API keys at:
- **OpenRouter** (recommended): https://openrouter.ai/keys
- **Groq** (free tier): https://console.groq.com/keys
- **Anthropic**: https://console.anthropic.com

---

### 3.2 Create the virtual environment

**Recommended — run the setup script:**

```powershell
# PowerShell
.\setup_venv.ps1

# Command Prompt
setup_venv.bat
```

Both scripts do the following automatically (safe to re-run):
1. Check Python ≥ 3.10
2. Create `.venv/` virtual environment
3. Upgrade pip
4. Install all packages from `requirements.txt`
5. Install the `mcq-agent` CLI in editable mode (`pip install -e .`)
6. Copy `.env.example` → `.env` if `.env` doesn't exist
7. Create `output/` and `logs/` directories
8. Run smoke tests to verify the install

**Manual alternative:**

```powershell
# 1. Create venv
python -m venv .venv

# 2. Activate
.\.venv\Scripts\Activate.ps1          # PowerShell
# OR: .\.venv\Scripts\activate.bat    # Command Prompt

# 3. Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# 4. Install the CLI
pip install -e .

# 5. Create directories
New-Item -ItemType Directory -Force output, logs

# 6. Run smoke tests
python -m pytest tests/ -v
```

**Activate the environment at the start of every session:**

```powershell
.\.venv\Scripts\Activate.ps1       # PowerShell — prompt shows (.venv)
.\.venv\Scripts\activate.bat       # Command Prompt
```

---

### 3.3 Configure API keys (.env)

If the setup script ran, `.env` already exists (copied from `.env.example`). Open it and fill in the key for your provider:

```env
# OpenRouter (current default — one key for all models):
OPENROUTER_API_KEY=sk-or-your-real-key-here

# Groq (if switching to groq provider):
GROQ_API_KEY=gsk_your-real-key-here

# Anthropic (if switching to anthropic provider):
ANTHROPIC_API_KEY=sk-ant-your-real-key-here

# Supabase (only if enable_supabase: true in config.yaml):
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=eyJhbGci...   # Secret (service_role) key — NOT the anon key
```

You only need the key for the `provider:` value currently set in `config.yaml`. Leave other lines as placeholders.

---

### 3.4 Verify the install

```powershell
# Check CLI is registered
mcq-agent --help

# Check config loads cleanly
python -c "from mcq_agent.config import load_config; s = load_config(); print('Config OK:', s.model)"

# Run offline smoke tests (no API calls)
python -m pytest tests/ -v

# Quick generation test
mcq-agent generate examples/sample_lesson.md --count 3
```

---

## 4. Configuration Reference (config.yaml)

All runtime settings live in `config.yaml` in the project root. Changes take effect immediately on the next run — no restart needed.

```yaml
# ── LLM Provider ──────────────────────────────────────────────────────────
# Global fallback — used for any stage that doesn't have an override.
provider: openrouter           # anthropic | groq | openrouter
model: google/gemini-2.5-flash

# Per-stage overrides. Set any to null to fall back to the global model.
# Analyzer runs ONCE then is cached — use your best model here.
analyzer_provider: openrouter
analyzer_model: google/gemini-2.5-flash

generator_provider: openrouter
generator_model: google/gemini-2.5-flash

critic_provider: openrouter
critic_model: google/gemini-2.5-flash

# ── Question Generation ────────────────────────────────────────────────────
num_questions: 10              # Target number of accepted questions
difficulty: medium             # easy | medium | hard | expert
question_type: single_correct  # single_correct | ordering | code_snippet
num_options: 4                 # Options per question (3–6)

# Generates 2× the target so the critic can filter down without running out.
over_generation_factor: 2.0

# Allow mix of single_correct, ordering, and code_snippet types.
mixed_question_types: true

# ── Quality Control ────────────────────────────────────────────────────────
# Fuzzy-match ratio for source_excerpt vs document (0–1).
# Large documents with T2 truncation typically score 0.65–0.75.
# Lowering to 0.55–0.60 helps if all questions fail on first pass.
source_grounding_threshold: 0.65

# How many full Generator+Critic loops to run before giving up.
# Each loop asks only for the remaining deficit (e.g. if 7/10 passed, asks for 3 more).
guarantee_n_retries: 20

# ── Token Budgets Per Stage ────────────────────────────────────────────────
max_tokens: 32000              # Generator output budget
critic_max_tokens: 4000        # Critic output budget (per MCQ evaluation)
analyzer_max_tokens: 20000     # Analyzer output budget

# ── LLM Temperatures ──────────────────────────────────────────────────────
temperature: 0.7               # Generator — creative, diverse MCQs
critic_temperature: 0.2        # Critic — strict, deterministic evaluation
analyzer_temperature: 0.2      # Analyzer — deterministic concept extraction

# ── Source Linter Thresholds ───────────────────────────────────────────────
linter_min_words: 300
linter_min_sections: 2
linter_min_words_per_section: 50
linter_min_concept_density: 0.3
linter_fail_on_warn: false     # Set to true to abort on any WARN (stricter)

# ── Retry / Rate Limit ────────────────────────────────────────────────────
api_max_retries: 3
api_retry_initial_backoff: 2.0

# ── Pricing (for cost reporting only — does not affect generation) ─────────
pricing:
  input_per_million_tokens: 0.15     # google/gemini-2.5-flash via OpenRouter
  output_per_million_tokens: 0.60

generator_pricing:
  input_per_million_tokens: 0.15
  output_per_million_tokens: 0.60

critic_pricing:
  input_per_million_tokens: 0.15
  output_per_million_tokens: 0.60

# ── Cloud Storage (Supabase) ──────────────────────────────────────────────
enable_supabase: false
supabase_similarity_threshold: 80  # 0–100; lower = stricter dedup

# ── Output ────────────────────────────────────────────────────────────────
output_format: json
include_rejected_in_output: false

# ── Paths ─────────────────────────────────────────────────────────────────
log_db_path: logs/runs.db
prompts_dir: prompts
few_shot_examples_file: prompts/few_shot_examples.json
```

**Common config adjustments:**

| Goal | What to change |
|------|---------------|
| Generate more questions | `num_questions: 50`; also raise `guarantee_n_retries` |
| Fewer questions fail grounding | Lower `source_grounding_threshold` to `0.55–0.60` |
| Use premium model only for Analyzer | `analyzer_model: anthropic/claude-opus-4-7` |
| Switch to Groq provider | Change all `*_provider` to `groq`, all `*_model` to a Groq model ID |
| Stricter duplicate filtering | Lower `supabase_similarity_threshold` to `70` |
| Pipeline exits before reaching target | Raise `guarantee_n_retries` to `30` |

---

## 5. LLM Providers

Three providers are supported. Switch by editing `provider:` and the matching `*_provider` fields in `config.yaml`, plus the corresponding key in `.env`.

| Provider | Env var | Model format | Example model | Cost |
|----------|---------|-------------|---------------|------|
| OpenRouter | `OPENROUTER_API_KEY` | `provider/model-name` | `google/gemini-2.5-flash` | Very cheap |
| Groq | `GROQ_API_KEY` | plain model ID | `llama-3.3-70b-versatile` | Free tier available |
| Anthropic | `ANTHROPIC_API_KEY` | plain model ID | `claude-sonnet-4-6` | Medium cost |

**OpenRouter advantage:** One API key gives access to hundreds of models — Gemini, Claude, GPT-4o, Llama, Mistral, and more. Use it to switch models without creating new accounts.

**Current production config:** OpenRouter → `google/gemini-2.5-flash` for all stages.

### Model selection guide per stage

| Stage | Priority | Recommended models |
|-------|---------|-------------------|
| Analyzer | Quality > Speed > Cost — runs once, cached | `anthropic/claude-opus-4-7`, `openai/gpt-4o`, `google/gemini-2.5-flash` |
| Generator | Quality + instruction-following | `google/gemini-2.5-flash`, `meta-llama/llama-4-scout-17b-16e-instruct`, `claude-sonnet-4-6` |
| Critic | Speed > Cost > Quality — runs once per MCQ | `llama-3.1-8b-instant`, `claude-haiku-4-5`, `google/gemini-2.5-flash` |

### Provider comparison for this workload

| Aspect | Groq Llama 3.3 70B | Anthropic Claude Sonnet | Google Gemini 2.5 Flash |
|--------|-------------------|------------------------|------------------------|
| Cost / 1M in | ~$0.59 | ~$3.00 | ~$0.15 |
| Cost / 1M out | ~$0.79 | ~$15.00 | ~$0.60 |
| Speed | Very fast | Standard | Fast |
| JSON reliability | Strong | Excellent | Strong |
| Best for | Development + bulk | HARD/EXPERT difficulty | Production default |

### Example: all-Groq config (free tier)

```yaml
provider: groq
model: llama-3.3-70b-versatile
analyzer_provider: groq
analyzer_model: llama-3.3-70b-versatile
generator_provider: groq
generator_model: meta-llama/llama-4-scout-17b-16e-instruct
critic_provider: groq
critic_model: llama-3.1-8b-instant
```

### Example: mixed-provider config (cost-optimised)

```yaml
provider: openrouter
model: google/gemini-2.5-flash
analyzer_provider: anthropic           # premium for concept extraction (runs once)
analyzer_model: claude-opus-4-7
generator_provider: openrouter          # cheap for bulk generation
generator_model: google/gemini-2.5-flash
critic_provider: groq                   # fastest for per-MCQ eval
critic_model: llama-3.1-8b-instant
```

---

## 6. The Pipeline — Stage by Stage

### Stage 0 — Parse

**File:** `mcq_agent/parser.py`

Reads the `.md` file once and builds all three document tiers:

- **T1 `raw_text`** — verbatim file content. Only the Analyzer uses this.
- **T2 `section_summaries`** — first 3 sentences of prose + all code blocks per section. Reduces token count by 40–70% vs T1. Generator and Reframer use this.
- **T3 `section_fingerprints`** — section heading + top-20 key terms (stop-words removed). The Critic uses this to locate the relevant section without reading the full document.

The parser also extracts section hierarchy, tables, and code blocks for structural metadata.

---

### Stage 1 — Analyze

**File:** `mcq_agent/analyzer.py`

Sends T1 (full document) to the LLM and extracts a `ConceptMap` — a structured knowledge graph of the lesson.

A `ConceptMap` contains:
- **Concepts** — each enriched with testability score (1–5), difficulty range, question templates, prerequisite concepts, and confusion pairs (used by Reframer for distractor replacement)
- **Procedures** — step-by-step workflows with decision points and failure modes
- **Technical Facts** — discrete verifiable statements anchored to section headings
- **Code Examples** — code snippets with line-by-line annotations and testable behaviours
- **Thematic Clusters** — groups of related concepts across sections
- **Prerequisite Chains** — ordered learning sequences from foundational to advanced

**Caching:** Before calling the LLM, the Analyzer computes the MD5 hash of the source file and queries SQLite. If the file hasn't changed, the cached `ConceptMap` is returned instantly at zero token cost. The cache is permanent — run against the same file a hundred times, pay the LLM once.

**Temperature:** 0.2 — deterministic extraction, not creative.

---

### Stage 2 — Generate

**File:** `mcq_agent/generator.py`

Takes T2 summaries + a compact serialisation of the `ConceptMap` (sorted by testability score) and generates MCQ candidates.

Each candidate `MCQ` includes:
- Question stem
- 4 options (A/B/C/D), each with `is_correct`, `text`, and `distractor_rationale`
- `explanation` (the correct reasoning, must explain why distractors are wrong)
- `source_excerpt` (verbatim quote from the document supporting the answer)
- `bloom_level`, `difficulty`, `question_type`, `stem_pattern`

Key generation behaviours:
- **Over-generation:** generates `num_questions × over_generation_factor` candidates to account for critic rejections
- **Mixed types:** with `mixed_question_types: true`, distributes across `single_correct`, `ordering` (step-sequencing), and `code_snippet` types
- **Batch processing:** chunks large concept maps to stay within token budgets
- **Position bias fix:** prompted to distribute correct answers across A/B/C/D evenly (a post-generation shuffle in `validators.py` enforces this mechanically)

**Quality rules enforced in the generator prompt:**
- **Stem economy (#9):** only include context that bears on the question — no defensive over-specification
- **Source-phrase independence (#10):** correct answer must paraphrase, not echo, the source excerpt
- **Option length parity (#11):** correct answer must stay within ±20% of median distractor length; expand distractors rather than trimming the correct answer

**Temperature:** 0.7 — creative, diverse question generation.

---

### Stage 3 — Critique

**File:** `mcq_agent/critic.py`

Evaluates each candidate MCQ independently. The Critic does NOT see other candidates — each is judged in isolation.

**Source slicing (avoids sending the full document every time):**

The Critic finds the relevant source section using T3 fingerprints in priority order:
1. Case-insensitive substring match of the MCQ's `source_heading` against section headings
2. Match of the first 60 characters of `source_excerpt` against section content
3. `rapidfuzz.partial_ratio` scoring of the question text against each section's T3 key terms — sends the highest-scoring section

There is **no full-document fallback** — if none of the three methods finds a match, the question fails automatically. This prevents the Critic from wasting tokens and ensures it always judges against the right source material.

**The 13 quality criteria evaluated:**

| # | Criterion |
|---|-----------|
| a | Source grounding (excerpt matches document) |
| b | Unique correct answer (for single_correct type) |
| c | Factual accuracy of correct answer |
| d | Distractor plausibility (wrong but not absurd) |
| e | Stem clarity (question is unambiguous) |
| f | Bloom level matches declared difficulty |
| g | Explanation quality (teaches why correct; addresses distractors) |
| h | Source heading accuracy |
| i | Stem economy (no non-load-bearing context) |
| j | Option length parity (correct answer not much longer than distractors) |
| k | Source-phrase independence (correct answer doesn't echo excerpt verbatim) |
| l | Distractor rationale present for all incorrect options |
| m | No option can be immediately eliminated as absurd |

Questions where `passes=True` move to the accepted list. Failures go to the Reframer.

**Temperature:** 0.2 — strict, deterministic evaluation.

---

### Stage 4 — Reframe

**File:** `mcq_agent/reframer.py`

When a question fails the Critic, the Reframer classifies the failure and applies the minimum intervention rather than discarding the question entirely.

**Failure class taxonomy:**

| Class | Failure | Fix |
|-------|---------|-----|
| A | `length_parity` — correct answer is >30% longer than median distractor | Expand distractors using ConceptMap `confusion_pairs` |
| B | `source_excerpt` doesn't match the document | Re-ground: find a verbatim excerpt from the relevant source section |
| C | Distractors are implausible or not grounded | Replace weak distractors using ConceptMap `confusion_pairs` |
| D | Correct answer contains unsourced claims | Trim correct answer to only source-supported content |
| E | Both B and A fail | Fix B (re-grounding) first, then A (length parity) |
| SKIP | Structural failure: wrong option count, duplicate options, uniqueness | Not reframeable — stays rejected |

After the fix, the reframed MCQ goes through validators and the Critic again. If it passes both, it joins the accepted list. If it fails again, it is rejected.

---

### Quality Gates

**Validators (`mcq_agent/validators.py`) — run before the Critic, free, deterministic:**

All 7 checks run on every candidate — no short-circuit — so you always see the full failure picture.

| # | Check | What it catches |
|---|-------|----------------|
| 1 | `source_grounding` | `source_excerpt` fuzzy-match score vs document < threshold |
| 2 | `uniqueness` | Correct option count doesn't match question type |
| 3 | `option_count` | Number of options doesn't match `num_options` config |
| 4 | `distractor_rationales` | Any incorrect option missing `distractor_rationale` |
| 5 | `bloom_difficulty_alignment` | Bloom level inconsistent with difficulty level |
| 6 | `length_parity` | Correct answer >30% longer than median distractor |
| 7 | `source_phrase_overlap` | Correct answer reproduces a 5-gram verbatim from `source_excerpt` |

A utility `shuffle_correct_answer_positions()` runs after generation to randomly reassign A/B/C/D labels, mechanically removing the LLM's built-in B/C position bias.

**Source Linter (`mcq_agent/source_linter.py`) — runs before any API call:**

*Layer 1 — static checks (word count, section density):*

| Check | PASS | WARN | FAIL |
|-------|------|------|------|
| `word_count` | ≥ min_words | ≥ 60% of min | < 60% of min |
| `section_count` | ≥ min_sections | < min_sections | — |
| `thin_sections` | none thin | some thin | — |
| `code_blocks` | ≥ 1 | 0 | — |
| `term_density` | ≥ 0.5% | < 0.5% | — |

*Layer 2 — concept density checks (runs after Analyzer, uses its output, no extra API cost):*

| Check | PASS | WARN | FAIL |
|-------|------|------|------|
| `concept_density` | ≥ threshold | ≥ 60% of threshold | < 60% |
| `procedural_richness` | ≥ 1 procedure | 0 procedures | — |
| `technical_facts` | ≥ 3 facts | 1–2 facts | 0 facts |

A `FAIL` aborts the run immediately before spending further API tokens. A `WARN` continues unless `linter_fail_on_warn: true` in config.

Results are saved to `output/<label>_source_quality.json`.

---

### Guarantee-N Retry Loop

The pipeline runs Generator → Validators → Critic → Reframer in a loop until either:
- `accepted_count >= num_questions`, **or**
- `guarantee_n_retries` iterations are exhausted

Each loop iteration asks only for the remaining deficit: if 7/10 questions have been accepted, the next batch requests 3. This means a run configured for 10 questions always tries to deliver exactly 10, regardless of how many candidates get rejected along the way.

---

## 7. Storage: SQLite + Supabase

### 7.1 SQLite (local — always active)

**Location:** `logs/runs.db` (auto-created on first run)
**Module:** `mcq_agent/storage.py`

Three tables:

**`runs`** — one row per pipeline execution:
```
run_id              TEXT PRIMARY KEY    UUID
timestamp           TEXT                ISO datetime
input_file          TEXT                path to source .md
config_json         TEXT                full settings snapshot
generated_count     INTEGER
passed_count        INTEGER
total_input_tokens  INTEGER
total_output_tokens INTEGER
cost_usd            REAL
generation_number   INTEGER             sequential run counter (1, 2, 3 …)
```

**`mcqs`** — one row per question (both accepted and rejected):
```
id              INTEGER PRIMARY KEY AUTOINCREMENT
run_id          TEXT    REFERENCES runs(run_id)
mcq_json        TEXT    full MCQ as JSON
passed          INTEGER 1 = accepted, 0 = rejected
critique_json   TEXT    Critic result JSON
question_number INTEGER NULL for rejected; global sequential number for accepted
```

**`concept_maps`** — Analyzer cache:
```
file_hash           TEXT PRIMARY KEY   MD5 of source file content
source_file         TEXT
analyzer_model      TEXT
created_at          TEXT               ISO datetime
concept_map_json    TEXT               full ConceptMap as JSON
```

**Key functions in `storage.py`:**
- `init_db(db_path)` — creates tables; runs migrations for older DBs
- `log_run(run, db_path)` — persists a completed PipelineRun
- `get_run(run_id, db_path)` — reconstructs a PipelineRun from the DB
- `list_recent_runs(db_path, limit)` — lightweight summary rows for the CLI
- `get_total_accepted_count(db_path)` — used to assign the next `question_number`
- `get_run_count(db_path)` — used to assign the `generation_number`

**Useful raw SQLite commands:**

```powershell
# List all runs
sqlite3 logs/runs.db "SELECT run_id, timestamp, passed_count, cost_usd FROM runs;"

# Check what's in the concept map cache
sqlite3 logs/runs.db "SELECT source_file, analyzer_model, created_at FROM concept_maps;"

# Count all accepted questions
sqlite3 logs/runs.db "SELECT COUNT(*) FROM mcqs WHERE passed=1;"

# Clear concept map cache (forces re-analysis on next run)
sqlite3 logs/runs.db "DELETE FROM concept_maps;"

# Clear cache for one file only
sqlite3 logs/runs.db "DELETE FROM concept_maps WHERE source_file LIKE '%my_lesson%';"
```

---

### 7.2 Concept Map Cache

The Analyzer is the most expensive LLM call (premium model, full document). The cache eliminates this cost on every run after the first.

**How it works:**

1. Compute MD5 hash of the source file content
2. Query `concept_maps` table: `SELECT … WHERE file_hash = '<hash>'`
3. **Cache hit** → return the stored ConceptMap instantly. Token cost = 0. Logs `analyzer_cache_hit`.
4. **Cache miss** → call the LLM, save result with `INSERT OR REPLACE`

**Why MD5 of content (not file path):** The same content always hits the cache regardless of whether you renamed or moved the file. If you edit the file (even a typo fix), the MD5 changes → cache miss → fresh Analyzer run.

---

### 7.3 Supabase (cloud — optional)

**Purpose:** A clean, deduplicated cloud question bank for use by an internal application. Unlike SQLite (which stores everything including test runs and rejected questions), Supabase stores only accepted, deduplicated questions with gapless sequential numbering.

**Complete setup guide:** `SUPABASE_SETUP.txt` — contains all SQL to run, step-by-step instructions, query examples, and troubleshooting. Anyone setting up or managing the database should start there.

**Schema:** `supabase_schema.sql` (v2) — for fresh projects only. Upgrading from v1 uses the migration block in `SUPABASE_SETUP.txt`.

**First-time setup (summary):**

1. Go to https://supabase.com → create a free project
2. In the dashboard: **SQL Editor** → **New query** → paste `supabase_schema.sql` → **Run**
3. **Project Settings** → **Data API** tab → copy **Project URL** → `SUPABASE_URL` in `.env`
4. **Project Settings** → **API Keys** tab → copy **Secret (service_role)** key → `SUPABASE_KEY` in `.env`
   - Use the Secret key, **NOT** the Publishable (anon) key — the anon key is blocked by Row Level Security and causes a 403 error
5. In `config.yaml`: set `enable_supabase: true`

**Verification:**

```powershell
python migrate_to_supabase.py --latest --dry-run
```

**Schema v2 additions (navigation layer):**

| Table/Column | Purpose |
|---|---|
| `runs.generation_label` | Auto-derived timestamp label `YYYYMMDD-HHMM` (e.g. `20260604-1423`) |
| `runs.topic` | Human-readable lesson topic set via `--topic` CLI flag |
| `runs.source_lesson` | Filename stem of the source `.md` file |
| `run_tags` table | Extensible key-value tags per run (`course`, `unit`, `week`, `cohort`, …) |
| `mcqs.difficulty` | Promoted from `mcq_json` — indexed for fast filtering |
| `mcqs.bloom_level` | Promoted from `mcq_json` — indexed |
| `mcqs.question_type` | Promoted from `mcq_json` — indexed |
| `mcqs.stem_pattern` | Promoted from `mcq_json` — indexed |
| `mcqs.source_heading` | Promoted from `mcq_json` — indexed |
| `mcqs.quality_score` | 0–100; 100 for accepted, computed from 12 Critic criteria for rejected |
| `mcq_tags` table | Per-question override tags (use sparingly; most tags belong on the run) |
| `v_questions` view | Join surface — navigation columns + `mcq_json` in one row |

The `mcq_json` blob is **never modified**. All new columns sit beside it.

---

### 7.4 Deduplication Algorithm

**Module:** `mcq_agent/similarity.py`, `mcq_agent/supabase_gate.py`

The gate runs automatically at the end of each pipeline run when Supabase is enabled, or manually via `check_similarity.py`.

**Algorithm:**

1. Fetch all accepted questions from Supabase (paginated in batches of 1000)
2. For each new question, compute composite text: question stem + all option texts (including distractors)
3. Score with `rapidfuzz.fuzz.token_set_ratio` against every existing question's composite text
4. Questions scoring ≥ `supabase_similarity_threshold` (default 80%) are dropped as duplicates
5. Also run intra-batch check: new questions are compared against each other to avoid uploading duplicates from the same run
6. Survivors are renumbered starting from `max(existing) + 1` for gapless numbering
7. Filtered run is inserted into Supabase (idempotent: if `run_id` already exists, the call is skipped)

**Why `token_set_ratio`:** It tokenises both strings, sorts the tokens, and computes ratios on the sorted + unsorted combinations. This is order-insensitive — it catches paraphrasing like "Which tool builds X?" vs "What tool is used to build X?" better than a plain string ratio.

**Manual deduplication tools:**

```powershell
# Check a generated file for duplicates against local SQLite DB
python check_similarity.py output/my_lesson_accepted.json

# Stricter threshold (drops more)
python check_similarity.py output/my_lesson_accepted.json --threshold 70

# Report only — don't write a cleaned output file
python check_similarity.py output/my_lesson_accepted.json --report-only

# Manual Supabase migration
python migrate_to_supabase.py --latest         # push most recent run
python migrate_to_supabase.py --run-id <uuid>  # push specific run
python migrate_to_supabase.py                  # push all runs (idempotent)
python migrate_to_supabase.py --latest --dry-run  # preview without writing
```

---

## 8. Module Reference

### Pipeline package (`mcq_agent/`)

| Module | Role |
|--------|------|
| `cli.py` | Typer CLI — 3 commands: `generate`, `list-runs`, `show-run` |
| `pipeline.py` | Orchestrator — runs all stages in order, manages guarantee-n retry loop, writes output files |
| `parser.py` | Markdown → `ParsedDocument` (T1/T2/T3 tiers) using `markdown-it` |
| `analyzer.py` | Stage 1 — `ConceptMap` extraction with SQLite cache; uses `resolved_analyzer_model()` |
| `generator.py` | Stage 2 — MCQ candidate generation (batched, mixed types, concept-sorted) |
| `critic.py` | Stage 3 — per-MCQ LLM quality evaluation with T3 source slicing |
| `reframer.py` | Stage 4 — 5-class targeted salvage; re-validates after each fix |
| `validators.py` | 7 deterministic pre-critic checks; `shuffle_correct_answer_positions()` utility |
| `source_linter.py` | 2-layer source quality gate (Layer 1: static; Layer 2: post-Analyzer) |
| `schemas.py` | 40+ Pydantic v2 models for all data structures |
| `config.py` | Loads `config.yaml` + `.env`; 6 `resolved_*()` methods for per-stage model resolution |
| `llm_client.py` | Provider-agnostic LLM wrapper (`AnthropicClient`, `GroqClient`, `OpenRouterClient`); all expose `.call(prompt, response_model)` |
| `storage.py` | SQLite persistence — runs, mcqs, concept_maps tables |
| `similarity.py` | Shared dedup logic: `composite_text()`, `best_match()`, `filter_questions()` |
| `supabase_gate.py` | Cloud sync: fetch → similarity filter → renumber → push |
| `supabase_storage.py` | Supabase CRUD operations |

### Standalone scripts (project root)

| Script | Role |
|--------|------|
| `check_similarity.py` | CLI — check a JSON file for near-duplicates against local SQLite DB |
| `migrate_to_supabase.py` | CLI — push local SQLite runs to Supabase; supports `--latest`, `--run-id`, `--dry-run`, `--threshold` |
| `setup_venv.ps1` | PowerShell — create `.venv`, install deps, run smoke tests |
| `setup_venv.bat` | Batch — same as above for Command Prompt users |

### Prompts (editable)

| File | What it controls |
|------|----------------|
| `prompts/analyzer.txt` | How the Analyzer extracts concepts, procedures, facts, etc. from source |
| `prompts/generator.txt` | Quality criteria, stem patterns, distractor strategy, anti-patterns |
| `prompts/critic.txt` | Evaluation rubric (13 criteria), scoring logic, pass/fail gating |
| `prompts/few_shot_examples.json` | Gold-standard example MCQs injected into the Generator prompt |

---

## 9. Data Models

All models are in `mcq_agent/schemas.py` (Pydantic v2).

### MCQ — the core output unit

```
MCQ
├── question_stem          str        — the question text
├── options                List[Option]
│   ├── label              str        — "A" | "B" | "C" | "D"
│   ├── text               str        — option text
│   ├── is_correct         bool
│   └── distractor_rationale  str | None  — why this wrong answer is plausible
├── explanation            str        — correct reasoning; must explain why distractors fail
├── source_excerpt         str        — verbatim quote from the document
├── source_heading         str        — section heading where the answer is found
├── bloom_level            BloomLevel — remember | understand | apply | analyze | evaluate | create
├── difficulty             Difficulty — easy | medium | hard | expert
├── question_type          QuestionType — single_correct | ordering | code_snippet
├── stem_pattern           StemPattern — definition | scenario | debugging | comparison | procedure
├── topic_tags             List[str]
├── question_number        int | None  — global sequential number (assigned end-of-pipeline)
└── generation_number      int | None  — which run produced this question
```

### ConceptMap — knowledge graph extracted by the Analyzer

```
ConceptMap
├── concepts               List[Concept]
│   ├── name               str
│   ├── definition         str
│   ├── testability_score  int (1–5)    — higher = more likely to produce good MCQs
│   ├── difficulty_range   DifficultyRange
│   ├── question_templates List[QuestionTemplate]
│   ├── prerequisite_concepts  List[str]
│   └── confusion_pairs    List[ConfusionPair]   — used by Reframer for distractor fix
├── procedures             List[Procedure]
│   ├── name, steps, decision_points, failure_modes
├── technical_facts        List[str]
├── code_examples          List[CodeExample]
├── thematic_clusters      List[ThematicCluster]
└── prerequisite_chains    List[PrerequisiteChain]
```

### CritiqueResult — Critic's verdict per MCQ

```
CritiqueResult
├── passed                 bool
├── issues                 List[str]    — human-readable failure reasons
├── suggested_fix          str | None
├── criteria               dict[str, bool]   — 13 binary criteria (a–m)
└── failure_class          str | None   — A | B | C | D | E | SKIP (for Reframer)
```

### PipelineRun — complete run record

```
PipelineRun
├── run_id                 str          — UUID
├── timestamp              datetime
├── input_file             str
├── config                 MCQConfig    — settings snapshot
├── concept_map            ConceptMap
├── generated_count        int          — total candidates generated
├── passed_count           int          — candidates that passed all gates
├── final_mcqs             List[MCQ]    — accepted questions
├── rejected_mcqs          List[tuple[MCQ, CritiqueResult]]
├── analyzer_cost_usd      float
├── generator_cost_usd     float
├── critic_cost_usd        float
├── reframe_cost_usd       float
├── total_cost_usd         float
├── salvaged_count         int          — questions rescued by the Reframer
├── generation_number      int          — sequential run counter (1, 2, 3 …)
└── topic                  str | None   — lesson topic label (set via --topic CLI flag)
```

---

## 10. CLI Reference

### `mcq-agent generate` — run the full pipeline

```powershell
mcq-agent generate <input_file.md> [OPTIONS]

Options:
  --output, -o        Output directory (default: output/)
  --count, -n         Target question count; overrides config.yaml
  --difficulty, -d    easy | medium | hard | expert
  --type, -t          single_correct | ordering | code_snippet
  --topic, -T         Lesson topic label stored in Supabase for filtering
                      (e.g. 'MQTT Protocol'). Defaults to filename stem in title case.
  --config            Path to an alternate config.yaml
  --verbose, -v       Enable DEBUG-level structured logging

Examples:
  mcq-agent generate examples/sample_lesson.md
  mcq-agent generate lesson.md --count 20 --difficulty hard
  mcq-agent generate lesson.md --count 10 --topic "MQTT Protocol"
  mcq-agent generate lesson.md --count 10 --verbose
  mcq-agent generate lesson.md --config configs/groq_config.yaml
```

### `mcq-agent list-runs` — view run history

```powershell
mcq-agent list-runs [--limit N]

# Shows: run_id, timestamp, input file, generated/accepted counts, cost per run
```

### `mcq-agent show-run` — inspect a specific run

```powershell
mcq-agent show-run <run-uuid>
# or (short ID works too):
mcq-agent show-run <first-8-chars>

# Shows: full config, model routing, all accepted questions, per-stage cost breakdown
```

---

## 11. Output Files

Each generation run produces four files in `output/` named with the source file's stem and difficulty:

| File | Contents |
|------|----------|
| `<label>_accepted.json` | Array of MCQ objects that passed all quality gates. Includes `question_number` and `generation_number`. |
| `<label>_rejected.json` | Array of `{mcq, critique}` pairs — questions that failed. Useful for diagnosing prompt issues or thin source material. |
| `<label>_source_quality.json` | `SourceQualityReport` — Layer 1 and Layer 2 linter results. Shows which checks passed, warned, or failed and by how much. |
| `<label>_run_config.json` | Full run metadata — config used, model routing, token usage per stage, cost breakdown per stage, number of questions salvaged by Reframer. |

**Example `_accepted.json` entry:**

```json
{
  "question_stem": "Which protocol does MQTT use at the transport layer?",
  "options": [
    {"label": "A", "text": "UDP",  "is_correct": false, "distractor_rationale": "UDP is connectionless; MQTT requires reliable delivery."},
    {"label": "B", "text": "TCP",  "is_correct": true,  "distractor_rationale": null},
    {"label": "C", "text": "HTTP", "is_correct": false, "distractor_rationale": "HTTP is the application layer; MQTT is a separate protocol."},
    {"label": "D", "text": "TLS",  "is_correct": false, "distractor_rationale": "TLS is the security layer, not the transport protocol."}
  ],
  "explanation": "MQTT runs over TCP because it requires an ordered, reliable, connection-oriented channel. TLS can wrap the TCP connection for encryption but is not itself the transport layer.",
  "source_excerpt": "MQTT relies on TCP/IP as its transport protocol, which guarantees ordered and reliable message delivery.",
  "bloom_level": "remember",
  "difficulty": "easy",
  "question_type": "single_correct",
  "question_number": 42,
  "generation_number": 5
}
```

---

## 12. Quality Rules — Design Rationale

These rules were added based on systematic analysis of output quality across two pipeline builds.

### Stem economy (rule #9)

**Problem identified:** Stems averaged 60 words vs 37 words in a better build. Brutal Critic feedback caused the Generator to over-specify context defensively. One question listing 5 hardware components and a 15-minute compliance window only asked "which component is an actuator."

**Rule:** Include only context that bears directly on the question. If removing a sentence doesn't change what's being asked, remove it.

**Enforcement:** Criterion (i) in the Critic prompt; anti-pattern example ("BAD: stem inflation") in the Generator prompt.

### Option length parity (rule #11)

**Problem identified:** Across two output sets, the correct answer was consistently 27–30% longer than the median distractor. Experienced test-takers learn to pick the longest option. File 1: correct options averaged 22.0 words, distractors 17.3 (1.27×). File 2: 17.3 vs 13.3 (1.30×).

**Rule:** Correct answer must stay within ±20% of median distractor word count. When the correct answer is naturally longer, expand the distractors — don't trim the correct answer.

**Enforcement:** `validate_length_parity` validator (deterministic, free); criterion (j) in the Critic prompt.

### Source-phrase independence (rule #10)

**Problem identified:** In both output sets, the correct answer frequently reproduced 5+ word verbatim phrases from `source_excerpt`. One example: "fundamental intelligence must be local and robust" — copied word-for-word. This allows phrase-matching instead of understanding.

**Rule:** The correct answer must paraphrase the source, not echo it.

**Enforcement:** `validate_source_phrase_overlap` validator (5-gram string matching, free); criterion (k) in the Critic prompt.

### Correct answer position distribution

**Problem identified:** Across 8 questions in two output sets, the correct answer was never at position A or D — all correct answers were B or C. This is a known LLM position bias.

**Fix:** Generator prompt instructs distributing correct answers evenly across A/B/C/D. `shuffle_correct_answer_positions()` in `validators.py` mechanically reassigns labels post-generation.

### Quick Check section flagging

**Problem identified:** Questions drawn from a document's "Quick Check" section are near-paraphrases of the source's own self-assessment prompts — students who read the chapter already saw the question.

**Fix:** The Analyzer prompt flags Quick Check / self-assessment sections with `is_foundational=true` and a transformation warning. The Generator is instructed to significantly transform scenarios from these sections.

---

## 13. GUI Roadmap

### Phase 1 — Streamlit PoC (current target)

**Why Streamlit:** Pure Python, no frontend skills needed, direct pipeline import, free hosting on Streamlit Community Cloud. Right tool for a fast internal demo.

**Install:**
```powershell
pip install streamlit plotly
streamlit run app.py
```

**Planned screens:**

```
Sidebar navigation
├── Generate       ← Upload .md → one-click generate → live progress → results
├── Dashboard      ← Metrics: total questions, acceptance rate, cost per run, chart
├── History        ← Table of all runs, download accepted/rejected JSON
└── Duplicate Check ← Upload a JSON → similarity report vs DB + Supabase
```

**Security model:**
- API keys stay in `.env` on the server; Streamlit reads them via `python-dotenv`
- If deploying to Streamlit Community Cloud: store secrets in `.streamlit/secrets.toml` (not committed) — Streamlit maps these as env vars automatically
- For internal use: run on localhost only

---

### Phase 2 — Tauri Desktop App (production)

**Why Tauri:** Native Windows/Linux installer, no hosting, API keys stay in `.env` on the operator's machine, full control over UI design (React + Tailwind CSS).

**Architecture:**

```
┌─────────────────────────────────┐
│  Tauri shell (Rust)             │
│  ┌───────────────────────────┐  │
│  │  React frontend           │  │
│  │  (all UI, charts, upload) │  │
│  └─────────────┬─────────────┘  │
│                │ Tauri commands  │
│  ┌─────────────▼─────────────┐  │
│  │  Python sidecar process   │  │
│  │  (mcq_agent pipeline)     │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

The Python pipeline runs as a sidecar. Tauri manages the subprocess, forwards commands, and streams stdout as events to the React UI.

**Tech stack:** Tauri (MIT, free), React + Vite, Tailwind CSS, Recharts or Nivo for charts.

---

### UI Design Specifications

**Colour palette (futuristic dark theme):**

```
Background      #0a0e1a   near-black navy
Surface         #111827   dark card background
Border          #1e293b   subtle divider
Accent primary  #3b82f6   electric blue — actions, highlights
Accent success  #10b981   emerald green — accepted questions, push success
Accent warning  #f59e0b   amber — duplicates, warnings
Accent danger   #ef4444   red — rejections, errors
Text primary    #f1f5f9   near-white
Text muted      #64748b   slate grey
```

**Dashboard layout:**

```
┌──────────┬──────────┬──────────┬──────────┐
│ 247      │ 89.3%    │ 14.2%    │ $0.042   │
│ Questions│ Accept   │ Filtered │ Avg cost │
│ in bank  │ rate     │ rate     │ per run  │
└──────────┴──────────┴──────────┴──────────┘

┌──────────────────────────────┬─────────────────────────┐
│ Questions per generation     │ Type breakdown           │
│ [bar chart, last 10 runs]    │ [donut: SC/Order/Code]   │
└──────────────────────────────┴─────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ Run history table (sortable)                         │
│ Gen | File | Date | Generated | Accepted | Cost | ↓  │
└──────────────────────────────────────────────────────┘
```

**Generate screen UX flow:**
1. Drag-and-drop `.md` file upload (10 MB limit)
2. Instant preview: file name, word count, section count (from linter Layer 1 — free)
3. Config summary panel (read-only): model, difficulty, target count
4. Large **Generate** button — disabled while running
5. Live progress: stage name + spinner + elapsed time
6. Completion card: generated / accepted / rejected / cost / time
7. Download buttons: accepted JSON, rejected JSON, run config JSON

---

## 14. Troubleshooting

### Environment issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: No module named 'mcq_agent'` | Package not installed or wrong env active | Activate venv, then `pip install -e .` |
| `mcq-agent: command not found` | Venv not active or package not installed | Activate venv; run `pip install -e .` |
| `(.venv)` not showing in prompt | Venv not activated | `.\.venv\Scripts\Activate.ps1` |
| Venv missing after OS restart | Expected — venv is a local directory | Activate with Activate.ps1; run `setup_venv.ps1` if it's gone |
| Garbled characters in terminal | Windows CP1252 encoding | Use Windows Terminal or VS Code terminal; or `chcp 65001` |

### API and authentication

| Symptom | Cause | Fix |
|---------|-------|-----|
| `AuthenticationError` / HTTP 401 | Wrong or missing API key | Check `.env` has the key for the `provider` in `config.yaml` |
| HTTP 404 from OpenRouter | Model ID incorrect | Use `provider/model-name` format; check https://openrouter.ai/models |
| HTTP 404 from Groq | Model retired or renamed | Check https://console.groq.com/docs/models |
| `supabase` module not found | Cloud dependency missing | `pip install supabase>=2.3.0` |
| RLS violation from Supabase (403) | Using anon key instead of service_role | Replace `SUPABASE_KEY` with the **Secret** (service_role) key |

### Generation quality

| Symptom | Cause | Fix |
|---------|-------|-----|
| All questions fail source grounding on first pass | `source_grounding_threshold` too high for document size | Lower to `0.55–0.60` in `config.yaml` |
| Run produces 0 accepted questions | Source document too thin or structurally poor | Check `<label>_source_quality.json`; ensure 300+ words and 2+ sections |
| `guarantee_n_retries` exhausted before hitting target | Thresholds too strict or document too narrow | Raise `guarantee_n_retries`; lower `source_grounding_threshold` |
| Bloom/difficulty mismatch errors (Class SKIP, not reframeable) | Generator produces wrong Bloom level for difficulty | Use `difficulty: easy` for first runs; increase `over_generation_factor` |
| Questions are near-duplicates of prior runs | Supabase gate disabled | Set `enable_supabase: true`; or run `check_similarity.py` manually |
| Questions are similar within one run | Narrow concept map | Check concept density score in `_source_quality.json`; enrich source document |
| Analyzer runs every time (no cache hit) | Source file content changed (even whitespace) | Expected — MD5 cache is content-based. Unchanged file = cache hit. |

### Cost and performance

| Symptom | Cause | Fix |
|---------|-------|-----|
| Unexpectedly high Analyzer cost | Cache not being populated | Run: `sqlite3 logs/runs.db "SELECT COUNT(*) FROM concept_maps;"` — if 0, check `logs/` is writable |
| Slow generation overall | Large document + many questions | Use a fast model for Generator/Critic; premium model only for Analyzer (cached) |
| `instructor` JSON parse failures | Complex schema + low-quality model | Lower `temperature`; switch to a more capable model for that stage |

### Source quality

| Linter failure | Meaning | Fix |
|---------------|---------|-----|
| `word_count FAIL` | Document too short | Add more content to the lesson |
| `concept_density FAIL` | Analyzer found too few concepts per section | Add explicit definitions, procedures, or split a monolithic section |
| `technical_facts FAIL` | No unambiguous facts found | Add explicit numbered facts, specifications, or benchmarks |
| `code_blocks WARN` | No code blocks in a technical document | Add at least one code example or terminal command |

---

*MCQ Agent v0.3.0 — Internal, NxtWave — Last updated: 2026-06-04*
