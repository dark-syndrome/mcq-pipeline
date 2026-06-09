# MCQ Pipeline GUI — Build Checklist

Living progress tracker for the Electron GUI described in [`GUI_SPEC.md`](./GUI_SPEC.md).
**Every build session starts by reading this file + the one relevant spec section.**
Do not re-read the whole spec or the whole codebase. Update statuses + commit at the end of each session.

Status keys: `[ ]` not started · `[~]` in progress · `[x]` done

---

## How to run a session (token-discipline rules)
1. Read this checklist + the spec section for the slice you're building + the frozen contract files (below). Nothing else up front.
2. Build **one slice** (one row in the sequence table). Keep components small and file-scoped.
3. Run the relevant check (tests / `npm run dev`), update this file, **commit**. The commit is the context boundary — the next session needs only this file, not the prior conversation.
4. Delegate isolated leaf components (e.g. a single Recharts chart given a data shape) to a subagent so the main thread stays lean.

The Electron app lives in **`gui/`** (separate from the Python package). Run it with `cd gui && npm run dev`; build with `npm run build`.

### Stack deviations from the spec (with rationale)
- **PDF export uses Electron `webContents.printToPDF()`, not Puppeteer** (Session 8, spec §8.1). Puppeteer downloads its own ~170MB Chromium and re-introduces the heavy-dependency problem; Electron already bundles Chromium. `export.ts buildPdf()` renders the shared export HTML in a hidden `BrowserWindow({show:false, webPreferences:{javascript:false}})` and prints it. No new heavy dep; same styled output.
- **Supabase push runs through the Python CLI, not a JS client** (Session 8, spec §5.7). The dedup gate (`supabase_gate.filter_and_sync`) is Python-only; a JS client push would bypass it and create duplicates, breaking the two-store design. Added `mcq-agent push-supabase --run-id --dry-run --json-events` (reuses the gate via a new read-only `preview_sync` for dry-run); Electron drives it via the generalized `sidecar.runSidecar` on a `supabase:event` channel.
- **`docx` npm added** (Session 8) — pure-JS Word generation, no native build. Bundles into the electron main process (not externalized like `sql.js`/`yaml`).
- **Concept-cache clear is the one GUI→DB write** (Session 8, §5.7). sql.js works on an in-memory snapshot, so `db.clearConceptCache()` runs `DELETE FROM concept_maps`, exports the snapshot back to disk (`fs.writeFileSync(DB_PATH, db.export())`), then `reload()`s. Gated behind a UI confirm. All other DB access stays read-only.
- **Files tab "Topic" filter is a "Source File" filter** (Session 7, spec §5.2). The spec maps Topic to `runs.topic` or an `mcq_tags` table — neither exists in this SQLite schema (`runs` has only `input_file`; `mcqs` have no tags). The filter is backed by distinct `runs.input_file` basenames instead. All other §5.2 filters (difficulty/bloom/type/source_heading via `json_extract`, date via `runs.timestamp`, passed-only) map cleanly. Filter inputs use **sql.js prepared-statement params** (`rowsToObjectsParams` in `db.ts`), not string interpolation. Export (§5.6) + DB mgmt (§5.7) deferred to Session 8 — the export panel is a disabled stub but selection plumbing (excluded-id set) is already wired.
- **Recharts added in Session 6** (`recharts@3.x`, spec §8.1) — dashboard charts. Recharts 3.x widened tooltip/label `formatter` param types to `ValueType | undefined`; coerce with `Number(v)` inside formatters.
- **Cost Per Run chart is a single total-cost line, not the spec's 3 per-stage lines** (§4.2). The DB persists only aggregate `cost_usd` + total tokens per run — per-stage cost exists only live on `run_complete.cost_breakdown`, not in `runs`. Chart subtitle documents this. Upgrade to 3 lines if/when the pipeline persists per-stage cost.
- **Dashboard "Reframer Salvage Rate" KPI shows "—"** (§4.1): salvage is not persisted per-question in `mcqs` (no reframer-class column), so it can't be computed read-only. Card renders "—" with a "not persisted in DB" hint. Resolvable by persisting a salvaged flag when the Run-tab `question_rejected`/salvage events are wired (see GAP rows below).
- **DB access uses `sql.js` (WASM), not `better-sqlite3`** (spec §8.1). GUI DB access is read-only (the Python pipeline owns all writes), so an in-memory WASM snapshot is sufficient. `gui/electron/db.ts` caches the snapshot and exposes `reload()` to re-read after a run; all consumers go through its async exports, so a swap is isolated to that one file + the `external` line in `vite.config.ts`.
  - *Originally* chosen because the dev machine had no C++ toolchain. As of 2026-06-09 the toolchain IS installed (VS Community 2026 + VC Tools), so `better-sqlite3` is now buildable here — **we evaluated the swap and deliberately stayed on `sql.js`**. The deciding reason is no longer the dev build environment but **operator-machine portability**: `better-sqlite3` needs a native rebuild per machine/Electron-ABI, which would break on NxtWave operator machines without VS (unless we ship prebuilt binaries); `sql.js` runs everywhere with zero native build. At 225 rows queries are instant, so the spec's perf rationale doesn't yet apply.
  - Reversible trigger to revisit: interactive perf on a *large* DB becomes sluggish AND we have a packaging story for native binaries (prebuilds / `electron-rebuild` in the installer).

## Frozen contracts (read these in every tab session)
| Contract | Location | Status |
|---|---|---|
| IPC event protocol (Python→JS NDJSON) | `mcq_agent/cli.py` header + `GUI_SPEC.md` §8.2; mirrored in `gui/src/types.ts` | `[x]` frozen |
| IPC API surface (main↔renderer) | `gui/electron/preload.ts` + `gui/electron/ipc.ts`; renderer types in `gui/src/api.d.ts` | `[x]` frozen |
| Shared TS types + Tailwind theme tokens | `gui/src/types.ts`, `gui/tailwind.config.js` | `[x]` frozen |

---

## Session sequence
| # | Slice | Spec § | Depends on | Status |
|---|---|---|---|---|
| 0 | Spec→repo, checklist, memory, reconcile §8.2 event schema | 8.2, 9.1 | — | `[x]` |
| 1 | Electron+Vite+React+Tailwind scaffold; nav rail + status bar shell; Zustand store; theme tokens; home banner; 5 placeholder tabs | 2, 8.1, 8.3, 10 | 0 | `[x]` |
| 2 | IPC layer: sidecar spawn/stream + DB queries (sql.js); status bar + home banner wired to live data | 8.1, 8.2 | 1 | `[x]` |
| 3 | Run tab Phase 1+2 (upload, Layer-1 linter card, run config, pre-flight estimate) | 6.1 | 2 | `[x]` |
| 4 | Run tab Phase 3 (live stage timeline + accepted feed + completion card; session-cost + DB reconcile) | 6.1, 10.2 | 3 | `[x]` |
| 5 | Model tab (6 config sections, profile save/load, non-destructive comment-preserving save) | 3 | 2 | `[x]` |
| 6 | Dashboard KPI strip + Overview sub-tab (4 charts) | 4.1, 4.2 | 2 | `[x]` |
| 7 | Files tab (filter builder + results preview) | 5.1–5.5, 10.3 | 2 | `[x]` |
| 8 | Files export (JSON/DOCX/PDF) + DB mgmt panel | 5.6, 5.7 | 7 | `[x]` |
| 9 | Dashboard sub-tabs 2–4 (quality heatmap, cost/tokens, run history) | 4.2 | 6 | `[ ]` |
| 10 | Eval Set tab (browse/annotate, table, management) | 7 | 7 | `[ ]` |

---

## Pipeline-side prep (Python — Open Items §11.1)
| Item | Spec ref | Status | Notes |
|---|---|---|---|
| `--json-events` NDJSON stream | Open #1 (P0) | `[x]` | `cli.py:58–`; structlog→GUI protocol |
| `--count` / `--difficulty` (+ `--type`, `--topic`) overrides | Open #2 / §9.1 | `[x]` | `cli.py` generate command |
| Exceptions emitted as `error` events | §9.1 | `[x]` | `cli.py` except block |
| `run_complete` with cost_breakdown + output_files | §8.2 | `[x]` | `cli.py` |
| Per-stage tokens/cost on `stage_done` (analyze) + `stage_progress` (generate) | §8.2 | `[x]` | Session 0 — wired from `analyze_usage`/`gen_usage` |
| `cache_hit` field naming aligned with §8.2 | §8.2 | `[x]` | Session 0 (was `cached`) |
| `question_rejected` event | §8.2 | `[ ]` | **GAP** — spec defines it; not emitted. Add when Run-tab rejection feed needs it |
| Per-stage cost for `generate`/`critic` on `stage_done` | §8.2 | `[ ]` | Currently only aggregate in `run_complete.cost_breakdown` (generate is a retry loop) |
| Per-Bloom-level temperature config schema | Open #5 (P2) | `[x]` | `BloomTemperatures` model + `bloom_temperatures` in config.yaml (spec §3.4 defaults). **Schema only — not yet consumed by the Generator** (follow-up) |
| `config-dump` CLI (`--json`, `--defaults`) | §3 | `[x]` | Authoritative full-Settings read for the Model tab; `--defaults` powers Reset |
| Non-destructive config write (comment-preserving) | §1.1, §3 | `[x]` | `gui/electron/modelConfig.ts` writeConfig via YAML Document setIn; writes only changed leaves |
| venv Python path resolution for Electron sidecar | Open #2 (P0) | `[x]` | `gui/electron/paths.ts` resolvePython(): `MCQ_PYTHON` env → `.venv`/`venv` → PATH. Conda users launch from an activated env or set `MCQ_PYTHON` |
| `python -m mcq_agent.cli` entry (`__main__` guard) | — | `[x]` | Added so the sidecar invokes the module directly |
| `lint` CLI command (`--json`) — Layer-1 only, no API calls | §6.1 | `[x]` | Reuses parser + run_static_linter; powers the Run-tab Source Quality card via `lint:run` IPC |
| Supabase service_role key access from Electron | Open #4 (P1) | `[x]` | **Resolved (Session 8):** Electron does NOT use a JS Supabase client. Push goes through the Python `push-supabase` CLI (sidecar), which reuses the existing `supabase_gate` + the same `.env` (`SUPABASE_URL`/`SUPABASE_KEY` service_role). Keeps the dedup gate authoritative; no key handling in Electron. |
| DOCX export field schema decision | Open #3 (P1) | `[x]` | **Resolved (Session 8):** defaults ON = question+options (always), answer key (separate section), explanations, Bloom/difficulty metadata; cover page OFF. All toggleable in the Export panel. |

---

## Troubleshooting (environment quirks)
- **"Electron failed to install correctly" on `npm run dev`** (seen on this Windows machine): Electron's `install.js` uses `extract-zip`, which silently fails mid-extract here — it leaves only `node_modules/electron/dist/LICENSES.chromium.html` and exits 0. The full zip *is* cached at `%LOCALAPPDATA%\electron\Cache\<hash>\electron-v33.*-win32-x64.zip`. Fix without re-downloading:
  ```powershell
  $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter *.zip | Select -First 1
  Remove-Item -Recurse -Force node_modules\electron\dist
  Expand-Archive $zip.FullName node_modules\electron\dist -Force
  Set-Content node_modules\electron\path.txt "electron.exe" -NoNewline -Encoding ascii
  ```
  Recurs after any `node_modules` wipe / fresh `npm install`. Verify with `node -e "console.log(require('electron'))"`.

## Decisions / open questions to resolve before the slice that needs them
- **Bloom temperature schema** (before Session 5): how to represent the 6-level temp matrix in `config.yaml` (e.g. `bloom_temperatures: {remember: 0.5, ...}`) and thread it into the Generator.
- **DOCX export fields** (before Session 8): which MCQ fields included vs hidden by default.
- **venv resolution** (during Session 2): how the Electron sidecar locates the activated venv Python on NxtWave machines.
