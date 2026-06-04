"""
Module: parser.py
Parses a Markdown file into a structured ParsedDocument model.

Document tiers
--------------
The parser produces three representations of the same document.  Downstream
stages pick the tier that gives them exactly the information they need without
paying for tokens they don't use:

  T1 — raw_text          : full original Markdown (used by Analyzer only)
  T2 — section_summaries : first 3 sentences of each section + all code blocks
                           (used by Generator — 40-70% fewer tokens than T1)
  T3 — section_index     : heading + key terms only
                           (used by Critic source-slicing fallback)

Public API
----------
- DocumentSection   — heading + content + subsections
- ParsedDocument    — top-level document model (all tiers attached)
- parse_markdown()  — main entry point
- flatten_sections() — depth-first flattening helper
"""

import re
from pathlib import Path

from markdown_it import MarkdownIt
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class DocumentSection(BaseModel):
    heading: str
    level: int
    content: str
    subsections: list["DocumentSection"] = []


class SectionSummary(BaseModel):
    """T2 representation of one section."""
    heading: str
    level: int
    summary: str        # first 3 sentences of prose + code blocks
    word_count: int     # raw word count of full section content


class SectionFingerprint(BaseModel):
    """T3 representation of one section — heading + top key terms."""
    heading: str
    level: int
    key_terms: list[str]   # up to 20 most-distinctive words (stop-words removed)


class ParsedDocument(BaseModel):
    # T1 — full text (Analyzer only)
    raw_text: str

    # structured sections (used by Critic heading-match)
    sections: list[DocumentSection]
    code_blocks: list[str]
    tables: list[str]

    # T2 — section summaries (Generator)
    section_summaries: list[SectionSummary] = []

    # T3 — section fingerprints (Critic fallback)
    section_fingerprints: list[SectionFingerprint] = []


# ---------------------------------------------------------------------------
# Stop-words for T3 key-term extraction
# ---------------------------------------------------------------------------

_STOP_WORDS = {
    "a","an","the","and","or","but","in","on","at","to","for","of","with",
    "is","are","was","were","be","been","being","have","has","had","do","does",
    "did","will","would","could","should","may","might","shall","can","need",
    "this","that","these","those","it","its","we","you","i","they","he","she",
    "not","no","nor","so","yet","both","either","neither","each","few","more",
    "most","other","some","such","than","too","very","just","also","as","if",
    "by","from","about","into","through","during","before","after","above",
    "below","between","out","off","over","under","then","once","here","there",
    "when","where","why","how","all","any","both","each","more","up","down",
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _heading_text(tokens: list, index: int) -> str:
    if index + 1 < len(tokens) and tokens[index + 1].type == "inline":
        return tokens[index + 1].content
    return ""


def _build_hierarchy(
    flat: list[tuple[int, int, str, str]],
) -> list[DocumentSection]:
    stack: list[tuple[int, DocumentSection]] = []
    roots: list[DocumentSection] = []
    for _line, level, heading, content in flat:
        section = DocumentSection(heading=heading, level=level, content=content)
        while stack and stack[-1][0] >= level:
            stack.pop()
        if stack:
            stack[-1][1].subsections.append(section)
        else:
            roots.append(section)
        stack.append((level, section))
    return roots


def _extract_code_blocks(tokens: list, lines: list[str]) -> list[str]:
    blocks: list[str] = []
    for token in tokens:
        if token.type == "fence" and token.map:
            start, end = token.map
            blocks.append("".join(lines[start:end]))
    return blocks


def _extract_tables(tokens: list, lines: list[str]) -> list[str]:
    tables: list[str] = []
    for token in tokens:
        if token.type == "table_open" and token.map:
            start, end = token.map
            tables.append("".join(lines[start:end]))
    return tables


def _first_n_sentences(text: str, n: int = 3) -> str:
    """Return the first *n* sentences of *text* (rough split on . ! ?)."""
    # Strip markdown syntax noise before sentence-splitting
    clean = re.sub(r"[#*`_\[\]()>]", " ", text).strip()
    # Sentence boundary: period/bang/question followed by whitespace + uppercase
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", clean)
    return " ".join(parts[:n]).strip()


def _key_terms(text: str, max_terms: int = 20) -> list[str]:
    """Extract top distinctive words from *text*, filtering stop-words."""
    words = re.findall(r"[a-zA-Z]{3,}", text.lower())
    seen: dict[str, int] = {}
    for w in words:
        if w not in _STOP_WORDS:
            seen[w] = seen.get(w, 0) + 1
    # Sort by frequency desc, return top max_terms
    ranked = sorted(seen.items(), key=lambda x: -x[1])
    return [w for w, _ in ranked[:max_terms]]


def _build_summaries(
    flat: list[tuple[int, int, str, str]],
    code_blocks: list[str],
    max_code_chars: int = 600,
    min_section_words: int = 30,
    t2_char_budget: int = 40000,
) -> list[SectionSummary]:
    """
    Build T2: first 3 sentences of prose + any code blocks in that section.

    Guards against T2 being larger than T1:
    - Sections with fewer than min_section_words are skipped (headings-only noise).
    - Each code block is capped at max_code_chars characters.
    - Total T2 output is capped at t2_char_budget characters; sections beyond
      the budget are dropped with a notice appended at the end.
    """
    summaries: list[SectionSummary] = []
    code_text = "\n\n".join(code_blocks) if code_blocks else ""
    total_chars = 0

    for _line, level, heading, content in flat:
        word_count = len(content.split())

        # Skip sections that are too thin to be testable
        if word_count < min_section_words and not any(
            marker in content for marker in ("```", "    ")
        ):
            summaries.append(SectionSummary(
                heading=heading, level=level, summary="", word_count=word_count
            ))
            continue

        prose_summary = _first_n_sentences(content, n=3)
        extra = ""
        if "```" in content and code_text:
            section_codes = re.findall(r"```[\s\S]*?```", content)
            if section_codes:
                truncated: list[str] = []
                for block in section_codes:
                    if len(block) > max_code_chars:
                        truncated.append(
                            block[:max_code_chars] + "\n... [truncated]```"
                        )
                    else:
                        truncated.append(block)
                extra = "\n\n" + "\n\n".join(truncated)

        summary = (prose_summary + extra).strip()
        total_chars += len(summary)

        if total_chars > t2_char_budget:
            # Budget exhausted — add a sentinel and stop
            summaries.append(SectionSummary(
                heading="[remaining sections omitted — T2 budget reached]",
                level=0, summary="", word_count=0
            ))
            break

        summaries.append(SectionSummary(
            heading=heading, level=level, summary=summary, word_count=word_count
        ))

    return summaries
    return summaries


def _build_fingerprints(
    flat: list[tuple[int, int, str, str]],
) -> list[SectionFingerprint]:
    """Build T3: heading + top key terms per section."""
    fingerprints: list[SectionFingerprint] = []
    for _line, level, heading, content in flat:
        fingerprints.append(SectionFingerprint(
            heading=heading,
            level=level,
            key_terms=_key_terms(content),
        ))
    return fingerprints


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def parse_markdown(file_path: Path) -> ParsedDocument:
    """
    Parse the Markdown file at *file_path* into a ParsedDocument.

    Populates all three tiers (T1 raw_text, T2 section_summaries,
    T3 section_fingerprints) in one pass so no file is read twice.
    """
    if not file_path.exists():
        raise FileNotFoundError(f"Markdown file not found: {file_path}")

    raw_text = file_path.read_text(encoding="utf-8")
    if not raw_text.strip():
        raise ValueError(f"Markdown file is empty: {file_path}")

    lines: list[str] = raw_text.splitlines(keepends=True)
    md = MarkdownIt()
    tokens = md.parse(raw_text)

    # Collect headings
    headings: list[tuple[int, int, str]] = []
    for i, token in enumerate(tokens):
        if token.type == "heading_open" and token.map:
            level = int(token.tag[1])
            line_0 = token.map[0]
            text = _heading_text(tokens, i)
            headings.append((line_0, level, text))

    # Build flat section list
    flat: list[tuple[int, int, str, str]] = []
    preamble_end = headings[0][0] if headings else len(lines)
    preamble_content = "".join(lines[0:preamble_end])
    if preamble_content.strip():
        flat.append((0, 0, "", preamble_content))

    for idx, (line_0, level, text) in enumerate(headings):
        end_line = len(lines)
        for j in range(idx + 1, len(headings)):
            if headings[j][1] <= level:
                end_line = headings[j][0]
                break
        content = "".join(lines[line_0 + 1 : end_line])
        flat.append((line_0, level, text, content))

    if not headings and not preamble_content.strip():
        flat.append((0, 0, "", raw_text))

    sections = _build_hierarchy(flat)
    code_blocks = _extract_code_blocks(tokens, lines)
    tables = _extract_tables(tokens, lines)
    section_summaries = _build_summaries(flat, code_blocks)
    section_fingerprints = _build_fingerprints(flat)

    return ParsedDocument(
        raw_text=raw_text,
        sections=sections,
        code_blocks=code_blocks,
        tables=tables,
        section_summaries=section_summaries,
        section_fingerprints=section_fingerprints,
    )


def flatten_sections(doc: ParsedDocument) -> list[DocumentSection]:
    """Depth-first flattening of all DocumentSection objects."""
    result: list[DocumentSection] = []

    def _visit(section: DocumentSection) -> None:
        result.append(section)
        for child in section.subsections:
            _visit(child)

    for section in doc.sections:
        _visit(section)
    return result


def build_t2_prompt_text(doc: ParsedDocument) -> str:
    """
    Build the T2 text to inject into the Generator prompt.

    Returns section summaries joined with clear separators.
    Typically 40-70% fewer tokens than raw_text for IoT lesson documents.
    """
    parts: list[str] = []
    for s in doc.section_summaries:
        prefix = "#" * max(s.level, 1)
        parts.append(f"{prefix} {s.heading}\n{s.summary}")
    return "\n\n---\n\n".join(parts)