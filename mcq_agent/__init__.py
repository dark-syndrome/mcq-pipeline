"""
mcq_agent — AI-powered MCQ generation pipeline.

Stages:
  1. Analyzer  — ConceptMap extraction (premium model, cached per source file)
  2. Generator — MCQ candidate generation (T2 compressed input, batched)
  3. Critic    — Quality evaluation (T3 section-sliced, per-MCQ)
  4. Reframer  — Targeted salvage of rejected MCQs (length, sourcing, distractors)

Quality gates:
  - Layer 1: Static source linter (free, pre-run)
  - Layer 2: Concept density map (free, post-Analyzer)
  - Validators: rule-based checks (free, per-MCQ)
  - Critic: LLM-based quality evaluation (per-MCQ)
  - Supabase gate: similarity deduplication before cloud push (optional)
"""
