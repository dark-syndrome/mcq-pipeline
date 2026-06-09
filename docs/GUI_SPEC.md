<!-- AUTO-EXTRACTED from MCQ_Pipeline_GUI_Spec.docx (v1.0, June 2026). Source of truth for the GUI build. Tables are flattened to label/value line pairs by the .docx text extraction; refer to the original .docx for exact table grids. -->

MCQ PIPELINE
GUI Application Design Specification
Internal Operator Tool  —  NxtWave Robotics Engineering
Version
1.0
Date
June 2026
Pipeline
v0.3.0
Author
Sky
Table of Contents
TOC \h \o "1-3" \t "undefined,1,undefined,2,undefined,3"
1. Executive Summary
This document is the complete design specification for the MCQ Pipeline GUI — a production-grade internal operator tool built on top of the mcq_agent Python pipeline (v0.3.0). The GUI replaces the command-line interface for day-to-day operations at NxtWave, enabling educators and content engineers to generate, review, and export multiple-choice questions without writing a single terminal command.
The application is structured around five primary navigation tabs that map directly onto the pipeline's operational surface: Model (configuration), Dashboard (analytics), Files (data access), Run (execution), and Eval Set (evaluation dataset management). Together they expose every capability of the CLI, add visual feedback for the agentic pipeline stages, and provide export tooling that the CLI does not offer.
1.1 Design Philosophy
Principle
What It Means for This Tool
Pipeline-first
Every UI control maps to a real config.yaml key or CLI flag. No phantom settings that do nothing.
Zero terminal dependency
All generation, database access, and export runs through the GUI. Operators who have never opened PowerShell can drive the full pipeline.
Cost transparency
Every run shows token usage and USD cost per stage. The dashboard trends this over time. There are no surprises on the OpenRouter invoice.
Quality visibility
The Run tab shows each pipeline stage live. Rejection reasons and Reframer interventions are surfaced, not buried in JSON logs.
Non-destructive by default
The GUI never modifies config.yaml silently. Changes are staged in-app and written to disk only on explicit save. DB operations have dry-run previews.
1.2 Recommended Tech Stack
Implementation Target
Phase 1: Electron + React + Tailwind CSS desktop app. Python pipeline runs as a child process (sidecar), streaming structured JSON events to the frontend via IPC. SQLite accessed via better-sqlite3 in the main process. This mirrors the Tauri Phase 2 architecture from the README roadmap but uses the existing JavaScript ecosystem for faster delivery.
2. Application Structure Overview
2.1 Navigation Architecture
The application uses a fixed left-side navigation rail with five primary tabs. Each tab maps to a distinct operational domain. A persistent status bar at the bottom shows the active provider, model route, database connection status, and the running cost total for the current session.
#
Tab
Icon
Primary Responsibility
1
Model
Sliders / Settings
Edit all config.yaml parameters via a structured form UI. Save/load named config profiles.
2
Dashboard
Chart / Analytics
Interactive analytics across all runs: token usage, cost trends, acceptance rates, Bloom distribution.
3
Files
Database / Export
Query SQLite/Supabase with a graphical filter builder. Download accepted questions in JSON, DOCX, or PDF.
4
Run
Play / Pipeline
Upload .md source, configure run parameters, execute the pipeline with live stage-by-stage progress.
5
Eval Set
Checkmark / Evaluation
View, edit, and manage evaluation question sets. Annotate questions with correctness labels.
2.2 Persistent Status Bar
Docked at the bottom of every screen, the status bar shows:
Provider: openrouter (green dot = connected, red = auth error)
Model route: Analyzer → gemini-2.5-flash | Generator → gemini-2.5-flash | Critic → gemini-2.5-flash
SQLite: logs/runs.db (N rows)  |  Supabase: enabled / disabled
Session cost: $0.000  (live counter, increments during a run)
2.3 Global Homepage Banner
When the app first opens, a landing banner occupies the main content area before any tab is selected. It contains:
Application title and NxtWave branding
One-paragraph description: "MCQ Pipeline is an agentic system that transforms Markdown lesson files into high-quality multiple-choice questions. It runs a five-stage pipeline—Parse → Analyze → Generate → Critique → Reframe—enforcing 7 deterministic validators and 13 LLM quality criteria on every question before acceptance."
Quick-start cards: four action cards (New Run, Browse Questions, View Dashboard, Edit Config) that navigate to the corresponding tab on click
Last run summary: generated / accepted / cost / timestamp from the most recent PipelineRun in SQLite
3. Tab 1 — Model
The Model tab is the GUI equivalent of config.yaml. Every field in the YAML file has a corresponding control here. Changes are staged in-app (shown with a yellow dot on modified fields) and written to disk only when the operator clicks Save Config. A profile system allows named snapshots of the full config to be saved and restored.
3.1 Section Layout
The tab is divided into six collapsible accordion sections, each matching a logical group in config.yaml:
Section A — LLM Provider & Model Routing
This is the most critical section. A three-column card grid shows the three agent roles side by side for easy comparison:
Analyzer Agent
Generator Agent
Critic Agent
Provider:
Dropdown: anthropic | groq | openrouter
Model ID:
Text input with autocomplete from known model list
Max Tokens:
Number input (analyzer_max_tokens: 20000)
Temperature:
Slider 0.0 – 1.0 (default 0.2)
Cache badge: "MD5 cache active"
Provider:
Dropdown: anthropic | groq | openrouter
Model ID:
Text input with autocomplete
Max Tokens:
Number input (max_tokens: 32000)
Temperature:
Slider 0.0 – 1.0 (default 0.7)
Provider:
Dropdown: anthropic | groq | openrouter
Model ID:
Text input with autocomplete
Max Tokens:
Number input (critic_max_tokens: 4000)
Temperature:
Slider 0.0 – 1.0 (default 0.2)
Below the agent cards, a Global Fallback row allows setting the top-level provider and model used when no per-stage override is set.
Section B — Question Generation Defaults
These are the baseline defaults that pre-populate each Run. They can be overridden per-run in the Run tab.
Control
Config Key
UI Element & Range
Default Question Count
num_questions
Number spinner, 1–200
Default Difficulty
difficulty
Segmented control: easy | medium | hard | expert
Question Type
question_type
Multi-select toggle: single_correct, ordering, code_snippet
Options Per Question
num_options
Number spinner, 3–6
Mixed Question Types
mixed_question_types
Toggle switch (on/off)
Over-Generation Factor
over_generation_factor
Slider 1.0–3.0, step 0.1 (default 2.0). Tooltip: "Generates N× factor candidates; Critic filters down."
Section C — Quality Control Thresholds
This section exposes the parameters that most directly affect acceptance rate and generation cost. Each control has an inline explanation and a live impact estimate where applicable.
Control
Config Key
UI Element & Notes
Source Grounding Threshold
source_grounding_threshold
Slider 0.40–0.90, step 0.05 (default 0.65). Warning badge appears below 0.50: "Low threshold may allow weakly grounded questions."
Guarantee-N Retries
guarantee_n_retries
Number spinner 1–50 (default 20). Tooltip: "Max Generator→Critic loops per run. Higher = more API cost but better fill rate."
Supabase Dedup Threshold
supabase_similarity_threshold
Slider 60–100 (default 80). Lower = stricter. Tooltip: "Questions scoring ≥ this against existing bank are dropped."
Fail on Linter Warning
linter_fail_on_warn
Toggle switch. When on, any WARN from source linter aborts the run before API calls.
Include Rejected in Output
include_rejected_in_output
Toggle switch. Controls whether rejected MCQs are written to output JSON.
Section D — Bloom Level & Difficulty Tuning
A visual matrix allows per-Bloom-level temperature adjustment. This controls how creatively the Generator approaches questions at each cognitive level.
Remember
Understand
Apply
Analyze
Evaluate
Create
Temp: 0.5
Temp: 0.6
Temp: 0.7
Temp: 0.7
Temp: 0.8
Temp: 0.9
Each cell contains a slider. The column header shows the Bloom level and a tooltip with its definition (e.g., "Remember: recall of facts and basic concepts").
Section E — Source Linter Thresholds
Control
Config Key
Default
Min Words
linter_min_words
300
Min Sections
linter_min_sections
2
Min Words Per Section
linter_min_words_per_section
50
Min Concept Density
linter_min_concept_density
0.3 (slider 0.1–1.0)
Section F — Pricing & API Settings
Cost reporting fields (per-million token prices) for each provider/stage combination. Also covers API retry settings:
Input price / 1M tokens: Analyzer, Generator, Critic (separate number inputs in USD)
Output price / 1M tokens: same three fields
API Max Retries: spinner 1–5 (default 3)
API Retry Initial Backoff: spinner 0.5–10.0 seconds (default 2.0)
3.2 Config Profile Management
At the top of the Model tab, a profile bar shows the currently loaded profile name with three buttons:
Save — writes current form state to config.yaml and saves a named profile snapshot to local storage
Load — opens a dropdown of saved profiles (e.g., "groq-dev", "openrouter-prod", "budget-critic") and restores all fields
Reset to Defaults — restores all fields to pipeline defaults; requires confirmation dialog
Config Diff View
When a field is modified from its saved value, it shows a yellow dot and a small "was: X" tooltip. This allows operators to see at a glance what is different from the last saved state before committing the change.
4. Tab 2 — Dashboard
The Dashboard tab is the operational analytics hub. It reads exclusively from SQLite (logs/runs.db) and optionally from Supabase. All charts are interactive: hovering shows exact values, clicking a run row highlights it in all charts simultaneously.
4.1 Top KPI Strip
A horizontal strip of six metric cards pinned at the top of the dashboard. These are global totals across all runs:
Total Questions
in Bank
Overall Acceptance
Rate
Critic Rejection
Rate
Reframer
Salvage Rate
Total API Cost
(All Runs)
Avg Cost
Per Question
247
87.3%
12.7%
34.1%
$1.84
$0.007
4.2 Sub-Tab Row
Below the KPI strip, a horizontal tab row switches between four analytic views:
Sub-Tab 1 — Overview
Two-column layout with four charts:
Questions Per Generation (bar chart, last 15 runs): accepted vs rejected bars stacked per run, x-axis = generation_number, tooltip = run_id and timestamp
Question Type Distribution (donut chart): single_correct / ordering / code_snippet percentages across all accepted questions
Cost Per Run (line chart, last 15 runs): three lines for Analyzer cost, Generator cost, and Critic cost. Hover shows per-stage breakdown.
Difficulty Distribution (horizontal bar chart): easy / medium / hard / expert counts and percentages
Sub-Tab 2 — Quality
Deep view of the quality pipeline:
Validator Failure Breakdown (grouped bar chart): for each of the 7 validators, shows how many questions failed that check across all runs. Identifies the most common failure mode at a glance.
Critic Criteria Heatmap (13×N grid): rows = the 13 Critic criteria (a–m), columns = last 10 runs, cell color = pass rate (green→red). Immediately surfaces which criterion is most often failing.
Reframer Intervention by Class (pie chart): Class A / B / C / D / E / SKIP breakdown shows which types of rewriting are most needed.
Source Linter Stats (table): per-run PASS/WARN/FAIL counts for all 8 linter checks
Sub-Tab 3 — Cost & Tokens
Financial and token efficiency view:
Cumulative Cost Trend (area chart, all runs): total cost over time, with a linear regression forecast line. Shows expected cost if current run cadence continues.
Token Usage by Stage (stacked bar, last 15 runs): analyzer / generator / critic / reframer input and output tokens per run. Highlights runs where the Reframer was expensive.
Cost per Accepted Question (scatter plot): each point is a run. X-axis = num_questions, Y-axis = cost/question. Surfaces runs with poor cost efficiency.
Analyzer Cache Hit Rate (stat card): shows how often the Analyzer skipped the LLM due to cache hits. Target: 100% for the same source file.
Sub-Tab 4 — Run History
A sortable, filterable table of all runs with the following columns:
Gen#
Timestamp
Source File
Generated
Accepted
Rejected
Cost
Actions
12
2026-06-04
14:23
mqtt_protocol.md
20
17
3
$0.047
▶ Inspect | ↓ Export
Actions per row: Inspect (opens a side drawer with the full run config + all accepted questions), Export (downloads accepted JSON for that run).
5. Tab 3 — Files
The Files tab is the data access and export layer. It provides a fully graphical interface for querying both SQLite and Supabase, with no SQL knowledge required from the operator. It also handles file uploads for source lessons and direct download of generated outputs.
5.1 Three-Panel Layout
The Files tab uses a three-panel horizontal layout: Filter Builder (left, ~320px), Results Preview (center, ~60% width), and Export Options (right, ~240px). Panels can be collapsed.
5.2 Filter Builder — Graphical Query Interface
The left panel contains a set of tag-input and dropdown controls that build a database query without any SQL. The operator sets any combination of the following filters:
Filter
UI Control
Maps To
Topic
Tag input (multi-value, autocomplete from DB)
runs.topic or mcq_tags.value WHERE key='topic'
Run ID
Dropdown, all generation_numbers + run_id prefixes
mcqs.run_id
Difficulty
Multi-select badge toggles: easy | medium | hard | expert
mcqs.difficulty (Supabase) or JSON extract (SQLite)
Bloom Level
Multi-select badge toggles: remember … create
mcqs.bloom_level
Question Type
Multi-select badge toggles: SC | Ordering | Code
mcqs.question_type
Source Heading
Tag input with autocomplete from distinct headings in DB
mcqs.source_heading
Date Range
Date range picker (from – to)
runs.timestamp
Passed Only
Toggle switch (default: on)
mcqs.passed = 1
5.3 Difficulty Ratio Picker
When a question count is specified, an optional ratio control appears below the main filters. This allows the operator to specify the proportion of each difficulty level in the result set:
Example Ratio Request
Request 30 questions: Easy 30% • Medium 50% • Hard 20% • Expert 0%
This generates three separate sub-queries (LIMIT 9 easy + LIMIT 15 medium + LIMIT 6 hard) merged and shuffled. If fewer questions exist in a bucket than requested, the deficit is shown in an orange badge and the remaining slots are unfilled (not silently backfilled from another difficulty).
The ratio controls are four sliders that always sum to 100%. Adjusting one auto-redistributes the remainder proportionally across the others. A "Reset to Equal" button sets all four to 25%.
5.4 Fetch Mode
A radio group below the filters sets how questions are retrieved from the matched pool:
Sequential — ordered by question_number ASC (reproducible, useful for course sequencing)
Random — shuffled on each fetch (useful for generating varied quiz sets)
Stratified Random — random within each difficulty bucket before merging (combines ratio picker with randomness)
5.5 Results Preview Panel
The center panel shows a live preview of matched questions before export. It has two view modes:
Card View — each MCQ is shown as a card with the question stem, options, difficulty badge, Bloom level badge, and source heading. Correct option is visually marked.
Table View — compact grid with columns: #, Stem (truncated), Difficulty, Bloom, Type, Source Heading, Actions
The panel header shows: "Showing 28 of 247 questions matched — 30 requested (2 unfilled: expert bucket empty)"
Individual questions can be deselected from the export set by unchecking a checkbox on each card/row.
5.6 Export Options Panel
The right panel controls the output format and file naming:
Format selector: JSON | DOCX | PDF (radio buttons with format description tooltips)
JSON: raw MCQ objects array, same schema as the pipeline output files. Option to include/exclude distractor_rationale and explanation fields.
DOCX: formatted question document. Options: include answer key (separate section), include explanations, include Bloom/difficulty metadata, cover page with topic and date.
PDF: same as DOCX but rendered to PDF via headless conversion.
File name template: text input pre-filled with "{topic}_{difficulty}_{count}_{date}"
Download button — triggers the export and opens the OS save dialog
5.7 Database Management Panel
A collapsible accordion at the bottom of the Files tab provides direct database operations:
SQLite status: path, file size, row counts for all three tables
Supabase sync: "Push latest run to Supabase" button with dry-run toggle. Shows a preview of which questions would be pushed and which would be filtered as duplicates.
Concept Map Cache: shows count of cached concept maps, source file names, and a "Clear Cache" button (with confirmation). Clearing forces a fresh Analyzer run on the next generate.
DB Health Check: validates SQLite integrity, checks for orphaned rows (mcqs with no parent run), reports on Supabase connection status
6. Tab 4 — Run
The Run tab is the execution surface. It provides the full pipeline run experience: source file upload, run parameter configuration, live agent progress monitoring, and result review. It is the most interactive tab in the application.
6.1 Three-Phase Layout
The Run tab has three phases that appear in sequence. Phases 1 and 2 are visible simultaneously before execution. Phase 3 replaces them during and after the run.
Phase 1 — Source Upload
A large drag-and-drop zone accepts .md files (max 10 MB). On drop or file selection:
File name and size appear below the drop zone
A free Layer 1 linter check runs immediately (no API call): word count, section count, thin sections
A Source Quality card appears with a traffic-light indicator for each Layer 1 check
If Layer 1 fails (e.g., word count < 180), a red banner prevents proceeding with a specific fix suggestion
If Layer 1 passes, the Proceed to Configuration button activates
The Source Quality card shows:
Linter Check
Status
Detail
Word Count
✅ PASS
1,247 words (min: 300)
Section Count
✅ PASS
6 sections (min: 2)
Thin Sections
⚠️ WARN
Section "Quick Check" has 42 words (min: 50)
Code Blocks
✅ PASS
3 code blocks found
Phase 2 — Run Configuration
A compact parameter panel appears to the right of the source card. These settings override the config.yaml defaults for this run only:
Parameter
Config Key
UI Element
Number of Questions
--count / num_questions
Large number spinner (1–200)
Difficulty Level
--difficulty
4-button segmented control: easy | medium | hard | expert
Question Type
--type
Multi-select: single_correct, ordering, code_snippet
Topic Label
--topic
Text input (used for Supabase tagging + file naming)
Config Profile
--config
Dropdown of saved profiles from the Model tab
A Pre-flight Cost Estimate panel below the run config shows an estimated token budget and USD cost based on the source file word count, num_questions, over_generation_factor, and pricing settings. This is a heuristic, not a guarantee.
The Generate button is large, prominently colored (electric blue), and disabled until Phase 1 passes. Clicking it locks both panels and starts Phase 3.
Phase 3 — Live Execution
The upload and config panels are replaced by the execution view, which fills the screen:
Pipeline Stage Progress
A vertical timeline shows all 6 pipeline stages. Each stage has:
Stage icon and name
Status badge: Pending (grey) → Running (blue, spinning) → Done (green) → Failed (red) → Skipped (grey, strikethrough)
Elapsed time (live counter while running, total time once done)
Stage-specific detail line (described below)
Stage
Detail Line While Running
Detail Line When Done
Parse
Reading file...
T1: 1247 words | T2: ~370 tokens | T3: ~65 tokens
Linter (Layer 1)
Running static checks...
6/6 checks passed (1 WARN: thin section)
Analyze
Sending T1 to gemini-2.5-flash...
Cache HIT — 0 tokens | OR: 4,200 in + 1,800 out tokens | $0.001
Linter (Layer 2)
Checking concept density...
Density: 0.48 ✓ | Procedures: 3 ✓ | Facts: 7 ✓
Generate (Loop N)
Generating batch 1 of 1 (20 candidates)...
Loop 1: 20 generated → 18 passed validators → 15 passed Critic. 2 sent to Reframer.
Reframe
Reframing 2 questions (Class A: 1, Class B: 1)...
2 reframed → 2 passed Critic. Salvaged: 2.
Live Accepted Questions Feed
As questions are accepted during the generate loop, they appear in a scrolling card list below the timeline in real time. Each card shows the question stem, difficulty badge, Bloom badge, and a green checkmark. This provides immediate visual feedback that the pipeline is producing output.
Completion Summary Card
When all retries are exhausted or the target count is met, a summary card replaces the generate button area:
Accepted
Rejected
Salvaged
Total Cost
10 / 10
3
2
$0.038
Download buttons appear in the completion card: Download Accepted JSON, Download Rejected JSON, View in Files Tab. If Supabase is enabled, a "Push to Supabase" button with a dedup preview appears.
7. Tab 5 — Eval Set
The Eval Set tab manages the evaluation question set used for pipeline quality measurement. It provides an interface to view, annotate, and export the evaluation dataset that can be used to benchmark Critic performance and Generator quality over time.
7.1 Eval Set Overview
An evaluation set is a curated subset of accepted questions that have been manually labeled with correctness confidence scores. This set is used to measure whether the Critic is correctly identifying good vs bad questions, and to track whether quality degrades over model or prompt changes.
7.2 Eval Set Views
View A — Browse & Annotate
A card-per-question view where each MCQ card has:
Full question stem and all four options (correct answer revealed with green highlight)
Critic criteria verdict display: 13 criteria shown as ✓ / ✗ badges
Manual annotation controls: a 5-star quality rating, a "Confirm Correct" / "Flag as Wrong" toggle, and a free-text notes field
Source excerpt viewer: the quoted excerpt and source section name
View B — Eval Set Table
Compact tabular view of all questions in the current eval set with columns: #, Stem, Difficulty, Bloom, Critic Pass, Manual Rating, Flagged. Sortable by all columns.
7.3 Eval Set Management
Create Eval Set — select questions from the full question bank using the same filter builder as the Files tab, then save as a named eval set
Import / Export — import a JSON eval set from disk, export the current set with annotations
Quality Summary Panel — shows Critic accuracy vs manual labels, common false-positive and false-negative criteria, and a recommendation to tighten/loosen specific Critic criteria
8. Tech Stack & Implementation Guide
8.1 Recommended Stack
Layer
Technology
Rationale
Shell
Electron 30
Native desktop app for Windows. No hosting. API keys stay local in .env.
Frontend Framework
React 18 + Vite
Component-based UI, fast HMR in dev, small production bundle.
Styling
Tailwind CSS v3
Utility-first; matches the futuristic dark palette with minimal custom CSS.
Charts
Recharts
React-native, composable, and sufficient for all dashboard charts.
SQLite Access
better-sqlite3 (main process)
Synchronous Node.js bindings; Electron main process exposes query functions via IPC.
Python Sidecar
Node child_process
Spawns the activated venv Python with mcq-agent generate. Streams stdout JSON events via readline.
State Management
Zustand
Lightweight global store for run state, config, and DB cache. No Redux boilerplate.
Export (DOCX/PDF)
docx npm + Puppeteer
docx npm generates Word files; Puppeteer renders a styled HTML page to PDF.
8.2 Python–Electron IPC Protocol
The pipeline is invoked as a subprocess with a --json-events flag (to be added to cli.py). It emits newline-delimited JSON events to stdout:
Event Type
Payload Example
stage_start
{"event":"stage_start","stage":"analyze","ts":1234567890}
stage_done
{"event":"stage_done","stage":"analyze","tokens_in":4200,"tokens_out":1800,"cost":0.001,"cache_hit":false}
question_accepted
{"event":"question_accepted","question_number":7,"stem":"Which protocol...","difficulty":"easy"}
question_rejected
{"event":"question_rejected","failure_class":"B","issues":["source_excerpt not found"]}
run_complete
{"event":"run_complete","run_id":"uuid","accepted":10,"rejected":3,"cost_usd":0.038}
error
{"event":"error","stage":"generate","message":"API rate limit exceeded","retryable":true}
8.3 Color Palette
Token
Hex
Usage
Background
#0a0e1a
App root background (near-black navy)
Surface
#111827
Card and panel backgrounds
Border
#1e293b
Subtle dividers, card outlines
Accent Primary
#3b82f6
CTA buttons, active states, links
Accent Success
#10b981
Accepted questions, PASS badges, push success
Accent Warning
#f59e0b
Duplicates detected, linter WARNs, modified fields
Accent Danger
#ef4444
Rejections, errors, linter FAILs
Text Primary
#f1f5f9
Main body text
Text Muted
#64748b
Labels, metadata, secondary info
9. Implementation Phases
Phase 1 — Core Shell (Week 1–2)
Deliverable: working Electron app that can run the pipeline and display results.
Electron + React + Vite boilerplate with Tailwind CSS
Navigation rail with 5 tabs (placeholder content)
Persistent status bar (static data for now)
Python sidecar IPC: spawn venv Python, stream events, parse JSON
Run Tab Phase 1 & 2: file upload + Layer 1 linter display
Run Tab Phase 3: live stage timeline driven by IPC events
Completion card with download buttons
Phase 2 — Dashboard & Model Config (Week 3–4)
Deliverable: fully functional Model tab and Dashboard KPI strip.
Model tab: all 6 sections with form controls wired to config.yaml read/write
Config profile save/load/reset
Dashboard KPI strip reading from better-sqlite3
Dashboard Sub-Tab 1 Overview: 4 charts (Recharts)
Run History table with Inspect drawer
Phase 3 — Files & Export (Week 5–6)
Deliverable: fully functional Files tab with graphical query builder and export.
Filter builder panel: all filter controls wired to SQLite/Supabase queries
Difficulty ratio picker with auto-rebalancing sliders
Results preview: Card View and Table View
Export: JSON download (immediate), DOCX (docx npm), PDF (Puppeteer)
DB management panel: cache controls, Supabase sync
Phase 4 — Advanced Analytics & Eval Set (Week 7–8)
Deliverable: complete Dashboard with all sub-tabs and Eval Set tab.
Dashboard Sub-Tabs 2, 3, 4: quality heatmap, cost/token charts, full run history
Eval Set tab: browse/annotate, table view, eval set management
Quality Summary Panel with Critic accuracy metrics
End-to-end testing and performance profiling
9.1 Key Pipeline Integration Points
These are the specific changes needed in the Python pipeline to support the GUI:
Add --json-events flag to cli.py: when present, emit structured JSON events to stdout instead of pretty-printed human text
Add --count and --difficulty flags to the generate command (they already exist; verify they override num_questions and difficulty in config)
Ensure all pipeline exceptions are caught and emitted as {"event":"error",...} JSON rather than raising to stderr
The concept map cache and DB access work as-is via better-sqlite3 reading logs/runs.db directly; no pipeline changes needed for read-only DB access
10. Wireframe Reference
10.1 Overall Layout
The application window is divided into three fixed zones:
Zone
Description
Left Navigation Rail
64px wide. Contains 5 tab icons with tooltips. Active tab highlighted in electric blue. Logo at top, settings gear at bottom.
Main Content Area
Fills remaining width. Each tab renders its full UI here. Scrollable vertically.
Status Bar
32px tall, pinned at bottom. Provider | Model Route | DB Status | Session Cost.
10.2 Run Tab Wireframe (ASCII)
+------------------------------------------------------------------+
|  [Source Upload Zone]              [Run Parameters]             |
|   Drop .md here or Browse          Count:    [10  v]            |
|   +-----------------------+         Difficulty:[medium]          |
|   | Source Quality        |         Type:     [SC] [Ord] [Code] |
|   | [PASS] Word count: OK |         Topic:    [mqtt_protocol  ] |
|   | [PASS] Sections:   6 |                                    |
|   | [WARN] Thin section  |    Est cost: ~$0.04 / ~14k tokens  |
|   +-----------------------+                                    |
|                              [         GENERATE (10 Qs)      ] |
+------------------------------------------------------------------+
|  PIPELINE STAGES              |  LIVE QUESTION FEED            |
|  [Done]  Parse        0.3s   |  Q1: "Which protocol..."       |
|  [Done]  Linter L1    0.1s   |  Q2: "What is the purpose..."  |
|  [Done]  Analyze      2.1s   |  Q3: "Given the code below..." |
|  [Run]   Generate loop [|||] |  ...                           |
|  [ ]     Reframe              |                                |
+------------------------------------------------------------------+
10.3 Files Tab Wireframe (ASCII)
+---------------------+-----------------------------+-------------+
| FILTER BUILDER      | RESULTS PREVIEW (28 of 247)| EXPORT      |
| Topic: [mqtt][ros2] | [Card] [Table]             | Format:     |
| Diff:  [M][H]       | Q1: "Which protocol..."    | (o) JSON    |
| Bloom: [Apply]      |   [medium] [apply]         | ( ) DOCX    |
| Count: [30     ]    |                            | ( ) PDF     |
| Ratio: E30 M50 H20  | Q2: "What is the..."       |             |
| Mode: (o)Random     |   [easy] [remember]        | Filename:   |
|     ( )Sequential   |                            | [mqtt_...]  |
| [Fetch Questions]   |                            | [Download]  |
+---------------------+-----------------------------+-------------+
11. Open Items & Future Enhancements
11.1 Open Items (Must Resolve Before Build)
#
Item
Owner
Priority
1
Add --json-events flag to cli.py generate command
Sky (pipeline dev)
P0 — blocks Run tab
2
Confirm venv Python path resolution on NxtWave machines for Electron sidecar
Sky (env setup)
P0 — blocks all execution
3
Decide on DOCX export schema: which MCQ fields are included vs hidden by default
Content team
P1 — blocks Files export
4
Confirm Supabase service_role key access from Electron (no RLS bypass needed if already using service key)
Sky (DB)
P1 — blocks Supabase sync
5
Define per-Bloom-level temperature config schema in config.yaml (currently a single temperature key)
Sky (pipeline dev)
P2 — Model tab Bloom section
11.2 Future Enhancements (Post-v1)
Multi-file batch processing: upload multiple .md files, generate questions for each in sequence with shared config, combined export
Side-by-side diff view: compare two runs on the same source file to see which questions changed after a config/prompt update
Prompt editor: in-app editor for the four prompt files (analyzer.txt, generator.txt, critic.txt, few_shot_examples.json) with syntax highlighting and save-to-disk
Few-shot example manager: GUI to add, remove, and tag gold-standard example MCQs that are injected into the Generator prompt
Scheduled runs: schedule a run to execute at a set time (e.g., overnight batch for large lesson sets)
Team mode (Supabase): multi-user annotation of eval sets via Supabase; multiple operators can label the same questions independently and a consensus view is computed
Tauri migration: Phase 2 of the README roadmap; rewrite the shell in Tauri/Rust for smaller binary, faster startup, and a signed Windows installer
MCQ Pipeline GUI Specification — v1.0
NxtWave Robotics Engineering — Internal Document — June 2026