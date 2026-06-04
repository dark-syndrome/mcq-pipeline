"""
Module: source_linter.py
Pre-run static quality gate for source Markdown files.

Two layers of checking:
  Layer 1 — Static linter (always free, runs before any API call)
  Layer 2 — Concept density map (runs after Analyzer, reuses its output)

Layer 1 checks (pure Python, zero tokens):
  - total word count >= linter_min_words
  - number of sections (headings) >= linter_min_sections
  - every section has >= linter_min_words_per_section words
  - presence of at least one code block (for technical/IoT content)
  - presence of definable terms (bold/backtick patterns)

Layer 2 checks (post-Analyzer, zero extra API calls):
  - concept density: concepts / sections >= linter_min_concept_density
  - procedural richness: at least one procedure found
  - fact density: technical_facts count > 0

Results are stored in a SourceQualityReport and written to:
  output/<run_id_short>_source_quality.json

The pipeline respects linter_fail_on_warn: if True, any WARN aborts the run.
FAIL always aborts.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings
from .parser import ParsedDocument, flatten_sections
from .schemas import ConceptMap


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class LintCheck:
    name: str
    status: str        # "PASS" | "WARN" | "FAIL"
    message: str
    value: float | int | str | None = None
    threshold: float | int | str | None = None


@dataclass
class SourceQualityReport:
    source_file: str
    run_id: str
    checks: list[LintCheck] = field(default_factory=list)
    concept_density_score: float | None = None  # set by Layer 2
    overall_status: str = "PASS"   # "PASS" | "WARN" | "FAIL"
    recommendation: str = ""

    def to_dict(self) -> dict:
        return {
            "source_file": self.source_file,
            "run_id": self.run_id,
            "overall_status": self.overall_status,
            "concept_density_score": self.concept_density_score,
            "recommendation": self.recommendation,
            "checks": [
                {
                    "name": c.name,
                    "status": c.status,
                    "message": c.message,
                    "value": c.value,
                    "threshold": c.threshold,
                }
                for c in self.checks
            ],
        }

    def write(self, output_dir: Path, short_run_id: str) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"{short_run_id}_source_quality.json"
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        return path


# ---------------------------------------------------------------------------
# Layer 1 — Static linter
# ---------------------------------------------------------------------------


def _count_words(text: str) -> int:
    return len(text.split())


def _count_definable_terms(text: str) -> int:
    """Count bold (**term**) and inline code (`term`) occurrences as proxy
    for defined vocabulary density."""
    bold = re.findall(r"\*\*[^*]+\*\*", text)
    inline_code = re.findall(r"`[^`]+`", text)
    return len(bold) + len(inline_code)


def run_static_linter(
    document: ParsedDocument,
    settings: Settings,
    source_file: str,
    run_id: str,
) -> SourceQualityReport:
    """
    Layer 1: run all static checks against *document*.

    Returns a SourceQualityReport with overall_status set.
    Does NOT abort — the caller decides whether to proceed.
    """
    report = SourceQualityReport(source_file=source_file, run_id=run_id)
    checks = report.checks

    all_sections = flatten_sections(document)
    # Exclude the empty preamble section from heading count
    heading_sections = [s for s in all_sections if s.heading]

    # --- Check 1: total word count ---
    total_words = _count_words(document.raw_text)
    if total_words >= settings.linter_min_words:
        checks.append(LintCheck(
            "word_count", "PASS",
            f"Document has {total_words} words.",
            value=total_words, threshold=settings.linter_min_words,
        ))
    elif total_words >= settings.linter_min_words * 0.6:
        checks.append(LintCheck(
            "word_count", "WARN",
            f"Document has only {total_words} words (recommended: "
            f"{settings.linter_min_words}+). May not support {settings.num_questions} "
            f"diverse questions.",
            value=total_words, threshold=settings.linter_min_words,
        ))
    else:
        checks.append(LintCheck(
            "word_count", "FAIL",
            f"Document has only {total_words} words — too short to generate "
            f"quality questions (minimum: {settings.linter_min_words}).",
            value=total_words, threshold=settings.linter_min_words,
        ))

    # --- Check 2: section count ---
    n_sections = len(heading_sections)
    if n_sections >= settings.linter_min_sections:
        checks.append(LintCheck(
            "section_count", "PASS",
            f"Found {n_sections} sections.",
            value=n_sections, threshold=settings.linter_min_sections,
        ))
    else:
        checks.append(LintCheck(
            "section_count", "WARN",
            f"Only {n_sections} section(s) found (recommended: "
            f"{settings.linter_min_sections}+). Flat documents produce "
            f"shallow questions.",
            value=n_sections, threshold=settings.linter_min_sections,
        ))

    # --- Check 3: thin sections ---
    thin_sections = [
        s.heading for s in heading_sections
        if _count_words(s.content) < settings.linter_min_words_per_section
        and s.heading  # skip preamble
    ]
    if not thin_sections:
        checks.append(LintCheck(
            "thin_sections", "PASS",
            "All sections meet minimum word count.",
        ))
    else:
        checks.append(LintCheck(
            "thin_sections", "WARN",
            f"Thin sections (< {settings.linter_min_words_per_section} words): "
            + ", ".join(f'"{h}"' for h in thin_sections[:5]),
            value=len(thin_sections),
        ))

    # --- Check 4: code blocks (important for IoT / technical content) ---
    n_code = len(document.code_blocks)
    if n_code >= 1:
        checks.append(LintCheck(
            "code_blocks", "PASS",
            f"Found {n_code} code block(s).",
            value=n_code,
        ))
    else:
        checks.append(LintCheck(
            "code_blocks", "WARN",
            "No code blocks found. Technical content without code examples "
            "limits procedural question quality.",
            value=0,
        ))

    # --- Check 5: definable terms (bold / inline-code density) ---
    n_terms = _count_definable_terms(document.raw_text)
    term_density = n_terms / max(total_words, 1) * 100
    if term_density >= 0.5:
        checks.append(LintCheck(
            "term_density", "PASS",
            f"Term density {term_density:.1f}% ({n_terms} bold/code terms).",
            value=round(term_density, 2),
        ))
    else:
        checks.append(LintCheck(
            "term_density", "WARN",
            f"Low term density ({term_density:.1f}%). Consider adding bold "
            "definitions or inline code for key vocabulary.",
            value=round(term_density, 2),
        ))

    # --- Determine overall status ---
    statuses = [c.status for c in checks]
    if "FAIL" in statuses:
        report.overall_status = "FAIL"
        report.recommendation = (
            "Source document does not meet minimum quality requirements. "
            "Expand the content before generating questions."
        )
    elif "WARN" in statuses and settings.linter_fail_on_warn:
        report.overall_status = "FAIL"
        report.recommendation = (
            "Source document has warnings and linter_fail_on_warn is enabled. "
            "Address warnings or set linter_fail_on_warn: false in config.yaml."
        )
    elif "WARN" in statuses:
        report.overall_status = "WARN"
        report.recommendation = (
            "Source document has minor quality issues. Questions may be generated "
            "but quality could be limited. Review warnings above."
        )
    else:
        report.overall_status = "PASS"
        report.recommendation = "Source document meets all quality requirements."

    return report


# ---------------------------------------------------------------------------
# Layer 2 — Concept density map (post-Analyzer)
# ---------------------------------------------------------------------------


def run_concept_density_check(
    concept_map: ConceptMap,
    document: ParsedDocument,
    settings: Settings,
    report: SourceQualityReport,
) -> SourceQualityReport:
    """
    Layer 2: retroactively score the source using the Analyzer's ConceptMap.

    Appends additional checks to *report* and updates overall_status.
    Returns the same report object (mutated in-place).

    This runs AFTER the Analyzer and adds zero API calls — it just re-reads
    the ConceptMap the Analyzer already produced.
    """
    all_sections = flatten_sections(document)
    n_sections = max(len([s for s in all_sections if s.heading]), 1)
    n_concepts = len(concept_map.concepts)
    n_procedures = len(concept_map.procedures)
    n_facts = len(concept_map.technical_facts)

    density = n_concepts / n_sections
    report.concept_density_score = round(density, 3)

    # --- Concept density ---
    threshold = settings.linter_min_concept_density
    if density >= threshold:
        report.checks.append(LintCheck(
            "concept_density", "PASS",
            f"Concept density {density:.2f} concepts/section "
            f"({n_concepts} concepts across {n_sections} sections).",
            value=round(density, 3), threshold=threshold,
        ))
    elif density >= threshold * 0.6:
        report.checks.append(LintCheck(
            "concept_density", "WARN",
            f"Low concept density: {density:.2f} concepts/section "
            f"(recommended ≥ {threshold}). "
            f"Questions may repeat similar topics.",
            value=round(density, 3), threshold=threshold,
        ))
    else:
        report.checks.append(LintCheck(
            "concept_density", "FAIL",
            f"Very low concept density: {density:.2f} concepts/section. "
            f"Not enough distinct concepts to generate {settings.num_questions} "
            f"unique questions.",
            value=round(density, 3), threshold=threshold,
        ))

    # --- Procedural richness ---
    if n_procedures >= 1:
        report.checks.append(LintCheck(
            "procedural_richness", "PASS",
            f"Found {n_procedures} procedure(s) — supports procedural questions.",
            value=n_procedures,
        ))
    else:
        report.checks.append(LintCheck(
            "procedural_richness", "WARN",
            "No procedures found. All questions will be conceptual/factual.",
            value=0,
        ))

    # --- v0.4 enrichment checks ---
    n_templates = sum(len(c.question_templates) for c in concept_map.concepts)
    n_confusion_pairs = sum(len(c.confusion_pairs) for c in concept_map.concepts)
    n_high_testability = sum(1 for c in concept_map.concepts if c.testability_score >= 4)
    n_failure_modes = sum(len(p.common_failure_modes) for p in concept_map.procedures)
    n_clusters = len(concept_map.thematic_clusters)

    if n_templates >= settings.num_questions:
        report.checks.append(LintCheck(
            "question_templates", "PASS",
            f"{n_templates} question template(s) extracted — enough to seed all {settings.num_questions} questions.",
            value=n_templates,
        ))
    elif n_templates >= settings.num_questions // 2:
        report.checks.append(LintCheck(
            "question_templates", "WARN",
            f"Only {n_templates} question template(s) for {settings.num_questions} target questions. "
            "Generator will need to create more questions from scratch.",
            value=n_templates,
        ))
    else:
        report.checks.append(LintCheck(
            "question_templates", "WARN",
            f"Very few question templates ({n_templates}). Source may lack enough scenario variety.",
            value=n_templates,
        ))

    if n_confusion_pairs >= 3:
        report.checks.append(LintCheck(
            "confusion_pairs", "PASS",
            f"{n_confusion_pairs} confusion pair(s) found — strong distractor quality expected.",
            value=n_confusion_pairs,
        ))
    else:
        report.checks.append(LintCheck(
            "confusion_pairs", "WARN",
            f"Only {n_confusion_pairs} confusion pair(s). Distractors may be less plausible.",
            value=n_confusion_pairs,
        ))

    if n_high_testability >= 3:
        report.checks.append(LintCheck(
            "high_testability_concepts", "PASS",
            f"{n_high_testability} concept(s) with testability ≥ 4/5 — rich question variety expected.",
            value=n_high_testability,
        ))
    else:
        report.checks.append(LintCheck(
            "high_testability_concepts", "WARN",
            f"Only {n_high_testability} concept(s) with testability ≥ 4/5. "
            "Questions may skew toward simple recall.",
            value=n_high_testability,
        ))

    # --- Technical facts ---
    if n_facts >= 3:
        report.checks.append(LintCheck(
            "technical_facts", "PASS",
            f"Found {n_facts} technical fact(s).",
            value=n_facts,
        ))
    elif n_facts >= 1:
        report.checks.append(LintCheck(
            "technical_facts", "WARN",
            f"Only {n_facts} technical fact(s). "
            "Fewer recall-level questions available.",
            value=n_facts,
        ))
    else:
        report.checks.append(LintCheck(
            "technical_facts", "FAIL",
            "No technical facts found in concept map. "
            "The Analyzer found nothing unambiguously testable. "
            "Check your source content.",
            value=0,
        ))

    # Re-evaluate overall status with new checks
    statuses = [c.status for c in report.checks]
    if "FAIL" in statuses:
        report.overall_status = "FAIL"
        report.recommendation = (
            "Post-analyzer density check failed. "
            "The source lacks enough distinct concepts or facts to generate "
            f"{settings.num_questions} quality questions."
        )
    elif "WARN" in statuses and report.overall_status == "PASS":
        report.overall_status = "WARN"
        report.recommendation = (
            "Post-analyzer density check found warnings. "
            "Proceeding with generation but output quality may be limited."
        )

    return report
