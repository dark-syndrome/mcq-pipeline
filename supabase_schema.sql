-- ================================================================
--  MCQ Pipeline — Supabase schema  v2
--  Run this ONCE in the Supabase SQL editor on a FRESH project.
--  If you are UPGRADING from v1, use the migration block in
--  SUPABASE_SETUP.txt instead of running this file.
-- ================================================================


-- ----------------------------------------------------------------
-- RUNS  — one row per pipeline execution
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
    run_id               TEXT        PRIMARY KEY,
    timestamp            TIMESTAMPTZ NOT NULL,
    input_file           TEXT        NOT NULL,
    config_json          JSONB       NOT NULL,
    generated_count      INTEGER     NOT NULL,
    passed_count         INTEGER     NOT NULL,
    total_input_tokens   INTEGER     NOT NULL,
    total_output_tokens  INTEGER     NOT NULL,
    cost_usd             REAL        NOT NULL,
    generation_number    INTEGER     NOT NULL DEFAULT 0,

    -- v2 navigation columns
    generation_label     TEXT,        -- 'YYYYMMDD-HHMM', e.g. '20260604-1423'
    topic                TEXT,        -- human-readable lesson topic set at CLI time
    source_lesson        TEXT         -- input filename stem, e.g. 'mqtt_protocol_lesson'
);

CREATE INDEX IF NOT EXISTS idx_runs_generation_label ON runs (generation_label);
CREATE INDEX IF NOT EXISTS idx_runs_topic            ON runs (topic);
CREATE INDEX IF NOT EXISTS idx_runs_source_lesson    ON runs (source_lesson);


-- ----------------------------------------------------------------
-- RUN_TAGS  — extensible operator-defined labels per run
--
-- Use this table to attach any dimension you need later without
-- schema changes: course, unit, week, cohort, reviewer, etc.
-- One row per tag per run. PRIMARY KEY prevents duplicate keys.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_tags (
    run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    tag_key   TEXT NOT NULL,   -- e.g. 'course', 'unit', 'week', 'cohort'
    tag_value TEXT NOT NULL,   -- e.g. 'Python 101', 'Unit 3', 'Week 7'
    PRIMARY KEY (run_id, tag_key)
);

CREATE INDEX IF NOT EXISTS idx_run_tags_key_value ON run_tags (tag_key, tag_value);


-- ----------------------------------------------------------------
-- MCQS  — one row per question (accepted and rejected)
--
-- mcq_json  : the full original MCQ as produced by the pipeline.
--             This blob is NEVER modified after insert.
-- passed    : 1 = accepted, 0 = rejected
-- The v2 columns below are extracted from mcq_json at insert time
-- so that queries can filter by index without touching the JSON.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcqs (
    id               BIGSERIAL   PRIMARY KEY,
    run_id           TEXT        NOT NULL REFERENCES runs(run_id),
    mcq_json         JSONB       NOT NULL,
    passed           INTEGER     NOT NULL,
    critique_json    JSONB,
    question_number  INTEGER,                -- NULL for rejected questions

    -- v2 promoted navigation columns
    difficulty       TEXT,        -- 'easy' | 'medium' | 'hard' | 'expert'
    bloom_level      TEXT,        -- 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create'
    question_type    TEXT,        -- 'single_correct' | 'ordering' | 'code_snippet'
    stem_pattern     TEXT,        -- 'definition' | 'scenario' | 'debugging' | 'comparison' | 'procedure'
    source_heading   TEXT,        -- section heading the question is drawn from
    quality_score    REAL         -- 0.0–100.0; 100 for accepted, computed for rejected
);

CREATE INDEX IF NOT EXISTS idx_mcqs_run_id         ON mcqs (run_id);
CREATE INDEX IF NOT EXISTS idx_mcqs_passed         ON mcqs (passed);
CREATE INDEX IF NOT EXISTS idx_mcqs_question_number ON mcqs (question_number);
CREATE INDEX IF NOT EXISTS idx_mcqs_difficulty     ON mcqs (difficulty);
CREATE INDEX IF NOT EXISTS idx_mcqs_bloom_level    ON mcqs (bloom_level);
CREATE INDEX IF NOT EXISTS idx_mcqs_question_type  ON mcqs (question_type);
CREATE INDEX IF NOT EXISTS idx_mcqs_quality_score  ON mcqs (quality_score);
CREATE INDEX IF NOT EXISTS idx_mcqs_source_heading ON mcqs (source_heading);


-- ----------------------------------------------------------------
-- MCQ_TAGS  — per-question override tags
--
-- Use sparingly. Most tags belong on the run (run_tags).
-- Use mcq_tags when a single question within a run needs a tag
-- that differs from the rest: 'subtopic', 'flagged', 'reviewed_by'.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcq_tags (
    mcq_id    BIGINT NOT NULL REFERENCES mcqs(id) ON DELETE CASCADE,
    tag_key   TEXT   NOT NULL,
    tag_value TEXT   NOT NULL,
    PRIMARY KEY (mcq_id, tag_key)
);

CREATE INDEX IF NOT EXISTS idx_mcq_tags_key_value ON mcq_tags (tag_key, tag_value);


-- ----------------------------------------------------------------
-- CONCEPT_MAPS  — Analyzer cache (unchanged from v1)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS concept_maps (
    file_hash         TEXT        PRIMARY KEY,
    source_file       TEXT        NOT NULL,
    analyzer_model    TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL,
    concept_map_json  JSONB       NOT NULL
);


-- ----------------------------------------------------------------
-- v_questions VIEW  — primary query surface
--
-- Joins mcqs + runs so every row has navigation metadata AND the
-- original mcq_json blob.  Always query this view, not mcqs directly.
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_questions AS
SELECT
    m.id                           AS mcq_id,
    m.question_number,
    m.passed,
    m.difficulty,
    m.bloom_level,
    m.question_type,
    m.stem_pattern,
    m.source_heading,
    m.quality_score,
    r.run_id,
    r.generation_number,
    r.generation_label,
    r.topic,
    r.source_lesson,
    r.timestamp                    AS generated_at,
    m.mcq_json                     -- full original JSON, returned as-is
FROM mcqs m
JOIN runs r ON m.run_id = r.run_id;
