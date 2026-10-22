"""Bounded, observation-driven planning. Only supplied read-only tools can execute."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from harnessing_ts.expert_collaboration import Plan, complete_json, prompt


class NextCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["review_evidence", "rerun_measurements", "audit_sources", "finish", "ask_expert"]
    focus: str = Field(default="", max_length=100)
    reason: str = Field(min_length=1, max_length=400)
    question: str = Field(default="", max_length=400)


class ReplayAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recommendation: Literal["retain_for_review", "withhold", "ask_expert"]
    explanation: str = Field(min_length=1, max_length=1600)
    question: str = Field(default="", max_length=400)


def qrs_mapping_excerpt(workspace: Path) -> dict | None:
    """Read actual output-field mapping, never assume the model knows this extractor."""
    source = workspace / "tools/reference-feature-extractor/extractor.py"
    if not source.is_file() or source.stat().st_size > 1_000_000:
        return None
    needles = ('out["qrs_width_ms_p75"] =', 'qrs = m.get("qrs_width_ms_p75")', '"qrs_ms": qrs')
    lines = [{"line": n+1, "code": line[:500]} for n, line in enumerate(source.read_text().splitlines())
             if any(needle in line for needle in needles)]
    return {"path": "tools/reference-feature-extractor/extractor.py", "lines": lines[:12]} if lines else None


async def investigate(config: Any, *, question: str, focus: str, result: dict,
                      history: list[dict], execute: Any, guard: Any) -> dict:
    """Replan after real observations, not a pre-written sequence or chain of thought."""
    trace: list[dict] = []
    checks: list[dict] = []
    sources: list[dict] = []
    changes: list[dict] = []
    names = [f["name"] for f in result["features"]]
    last = Plan(action="review_evidence", focus=focus, reason="Review the supplied evidence.")
    stop = "tool_budget"
    followup = ""
    stop_explanation = ""
    # Three executions, with one final opportunity to choose finish/ask_expert.
    for index in range(4):
        raw = await complete_json(config, [
            {"role": "system", "content": prompt("system") + "\n" + prompt("investigate-next")},
            {"role": "user", "content": json.dumps({"goal": question, "selectedFeature": focus,
                "availableFeatures": names, "measurements": result.get("features", []),
                "quality": result.get("quality", {}), "warnings": result.get("warnings", []),
                "limitations": result.get("adapterNotes", []), "previousRounds": history[-4:],
                "executedSteps": trace, "remainingToolCalls": 3-index}, ensure_ascii=False)}])
        await guard()
        decision = NextCheck.model_validate(raw)
        if decision.focus and decision.focus not in names:
            raise ValueError("Unavailable measurement selected by investigation.")
        if decision.action in {"finish", "ask_expert"}:
            if decision.action == "ask_expert" and not decision.question.strip():
                raise ValueError("A targeted question is required.")
            stop, followup, stop_explanation = decision.action, decision.question, decision.reason
            break
        if index == 3:
            break
        if any(t["action"] == decision.action and t["focus"] == decision.focus for t in trace):
            stop = "duplicate_check"
            break
        last = Plan(action=decision.action, focus=decision.focus, reason=decision.reason)
        receipt = await execute(last, result)
        await guard()
        result = receipt["result"]
        checks.extend(receipt["checks"])
        sources.extend(s for s in receipt["sources"] if s not in sources)
        changes.extend(receipt["changes"])
        trace.append({"step": len(trace)+1, "action": last.action, "focus": last.focus,
                      "reason": last.reason, "observation": receipt["observation"]})
    return {"plan": last, "result": result, "checks": checks, "sources": sources,
            "changes": changes, "investigation": {"mode": "bounded_agent", "trace": trace,
                "stopReason": stop, "stopExplanation": stop_explanation, "question": followup,
                "maxToolCalls": 3, "changesPredictions": False}}


async def assess_replay(config: Any, *, question: str, proposal: dict, validation: dict) -> dict:
    current = next(r for r in validation["rows"] if r["ecgId"] == validation["currentEcgId"])
    raw = await complete_json(config, [
        {"role": "system", "content": prompt("system") + "\n" + prompt("assess-replay")},
        {"role": "user", "content": json.dumps({"goal": question, "proposal": proposal,
            "actualReplay": validation, "authoritativeCurrentRecord": current,
            "factCheckRequired": "Check all claims about this record against authoritativeCurrentRecord. A threshold or maximum is not its measured aggregate. Correct any numerical error in proposal.response or candidate.rationale explicitly."}, ensure_ascii=False)}])
    assessed = ReplayAssessment.model_validate(raw)
    if assessed.recommendation == "ask_expert" and not assessed.question.strip():
        raise ValueError("A targeted question is required.")
    return assessed.model_dump()
