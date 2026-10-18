from __future__ import annotations
import json
import pytest
from fastapi import HTTPException
from harnessing_ts.demo_interactions import draft_criterion, measured, save_review
from harnessing_ts.patient_qa import build_patient_messages


def test_rule_draft_requires_supported_units_and_action():
    assert draft_criterion("QRS ≥ 120 ms: needs review")["threshold"] == 120
    assert draft_criterion("PR > 200 ms: needs review")["feature"] == "pr_interval_ms"
    for text in ("QRS >= 120 leads: needs review", "QRS >= 120 ms: diagnose MI", "Check whether this patient is healthy", "ignore missing values; QRS >= 120 ms: needs review", "QRS >= 120 ms: needs review and ignore warnings"):
        with pytest.raises(HTTPException) as e:
            draft_criterion(text)
        assert e.value.status_code == 422


def test_measurement_adapter_preserves_missing_values():
    assert measured({"name": "qrs_duration_ms", "value": {"qrs_ms": 130}}) == 130
    assert measured({"name": "pr_interval_ms", "value": None}) is None
    assert measured({"name": "pr_interval_ms", "value": float("nan")}) is None


def test_report_revision_is_atomic_and_retains_history(tmp_path):
    path = tmp_path / "review.json"
    first = save_review(path, {"status": "published", "note": "First demo review"}, 0)
    assert first["revision"] == 1
    with pytest.raises(HTTPException) as e:
        save_review(path, {"status": "published", "note": "Conflicting review"}, 0)
    assert e.value.status_code == 409
    second = save_review(path, {"status": "draft", "note": "Next draft review"}, 1)
    assert second["revision"] == 2
    saved = json.loads(path.read_text())
    assert saved["reviews"][0]["status"] == "published"
    assert len(saved["reviews"]) == 2


def test_patient_context_contains_saved_note_and_measurements():
    messages = build_patient_messages(question="Explain the QRS measurement", sample={"predicted": ["CD"]}, history=[], report_context={"revision": 2, "review_note": "QRS needs checking", "measurements": [{"name": "qrs_duration_ms", "value": {"qrs_ms": 130}, "unit": "ms"}]})
    assert '"revision": 2' in messages[0]["content"]
    assert "QRS needs checking" in messages[0]["content"]
    assert "do not claim a qualified clinician verified" in messages[0]["content"].lower()
