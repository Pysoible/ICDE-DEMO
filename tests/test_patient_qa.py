from __future__ import annotations

import asyncio

import pytest

from harnessing_ts.patient_qa import answer_patient_question, build_patient_messages
from harnessing_ts.settings.llm import LlmConfig


def test_prompt_uses_predictions_without_claiming_a_diagnosis() -> None:
    messages = build_patient_messages(
        question="What does this result mean?",
        sample={"predicted": ["MI", "STTC"], "truth": ["HYP"], "scores": {"MI": 0.8}},
        history=[{"role": "user", "text": "Earlier question"}],
    )

    assert '"model_predicted_classes": ["MI", "STTC"]' in messages[0]["content"]
    assert "HYP" not in str(messages)
    assert "not a diagnosis" in messages[0]["content"].lower()
    assert messages[-1] == {"role": "user", "content": "What does this result mean?"}


def test_browser_review_is_identified_as_unverified_local_input() -> None:
    messages = build_patient_messages(
        question="What does my report say?",
        sample={"predicted": ["MI"]},
        history=[],
        review_labels=["CD"],
    )

    assert '"browser_review_labels": ["CD"]' in messages[0]["content"]
    assert "do not claim that a clinician verified them" in messages[0]["content"]


def test_urgent_symptoms_are_handled_before_llm_call() -> None:
    async def unavailable(_messages: list[dict[str, str]]) -> str:
        raise AssertionError("LLM must not be called for urgent symptoms")

    result = asyncio.run(answer_patient_question(
        question="I have chest pain and feel faint",
        sample={"predicted": ["NORM"]},
        history=[],
        llm_config=LlmConfig(authMode="manual", model="deepseek-chat", apiKey="test"),
        complete=unavailable,
    ))

    assert result["source"] == "safety"
    assert "urgent medical care" in result["answer"]


def test_nonurgent_questions_reach_llm_with_case_context() -> None:
    seen: list[dict[str, str]] = []

    async def complete(messages: list[dict[str, str]]) -> str:
        seen.extend(messages)
        return "The model flagged MI and STTC; please discuss the ECG with a clinician."

    result = asyncio.run(answer_patient_question(
        question="What does this result mean?",
        sample={"predicted": ["MI", "STTC"]},
        history=[],
        llm_config=LlmConfig(authMode="manual", model="deepseek-chat", apiKey="test"),
        complete=complete,
    ))

    assert result["source"] == "llm"
    assert "MI and STTC" in result["answer"]
    assert '"model_predicted_classes": ["MI", "STTC"]' in seen[0]["content"]


def test_empty_model_response_is_not_disguised_as_a_rule_answer() -> None:
    async def empty(_messages: list[dict[str, str]]) -> str:
        return "  "

    with pytest.raises(RuntimeError, match="empty response"):
        asyncio.run(answer_patient_question(
            question="Explain this ECG",
            sample={"predicted": ["CD"]},
            history=[],
            llm_config=LlmConfig(authMode="manual", model="deepseek-chat", apiKey="test"),
            complete=empty,
        ))
