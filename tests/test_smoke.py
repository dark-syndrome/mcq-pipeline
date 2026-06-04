"""Offline smoke tests — verify imports, schemas, and the provider factory."""

from pathlib import Path

import pytest

from mcq_agent.parser import parse_markdown
from mcq_agent.schemas import Difficulty, MCQConfig, QuestionType


def test_imports():
    """All key modules import cleanly."""
    from mcq_agent import (  # noqa: F401
        analyzer,
        cli,
        config,
        critic,
        generator,
        llm_client,
        parser,
        pipeline,
        schemas,
        storage,
        validators,
    )


def test_parser_on_sample_lesson():
    """parse_markdown should yield sections and non-empty raw_text."""
    path = Path(__file__).parent.parent / "examples" / "sample_lesson.md"
    doc = parse_markdown(path)
    assert doc.raw_text.strip()
    assert len(doc.sections) >= 1


def test_mcq_config_validation():
    """MCQConfig should accept valid values."""
    cfg = MCQConfig(
        num_questions=5,
        difficulty=Difficulty.MEDIUM,
        question_type=QuestionType.SINGLE_CORRECT,
    )
    assert cfg.num_questions == 5
    assert cfg.num_options == 4


def test_make_client_factory_validation():
    """Factory rejects unknown providers without needing real keys."""
    from mcq_agent.llm_client import make_client

    with pytest.raises(ValueError, match="Unknown provider"):
        make_client(
            provider="cohere",
            api_key="fake",
            default_model="anything",
        )


def test_provider_enum_in_config():
    """Provider enum is reachable from config module."""
    from mcq_agent.config import Provider

    assert Provider.GROQ.value == "groq"
    assert Provider.ANTHROPIC.value == "anthropic"
