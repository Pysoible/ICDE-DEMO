"""Bounded expert collaboration. Model proposals never mutate predictions or reports."""
from __future__ import annotations

import difflib
import json
import os
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field
from harnessing_ts.review_policy import Candidate


class ModelServiceUnavailable(RuntimeError):
    """Safe, user-actionable model error with no raw provider details."""


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["review_evidence", "rerun_measurements", "audit_sources"]
    focus: str = Field(max_length=100)
    reason: str = Field(min_length=1, max_length=500)


class Proposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    response: str = Field(min_length=1, max_length=4000)
    draftNote: str = Field(min_length=10, max_length=3000)
    unresolved: list[str] = Field(max_length=8)
    nextChecks: list[str] = Field(max_length=5)
    featureNames: list[str] = Field(max_length=10)
    candidate: Candidate | None = None


def prompt(name: str) -> str:
    return (Path(__file__).parent / "config/prompts/expert-collaboration" / f"{name}.md").read_text()


async def complete_json(config: Any, messages: list[dict[str, str]]) -> dict[str, Any]:
    key = config.apiKey or os.getenv("DEEPSEEK_API_KEY")
    if not key:
        raise ModelServiceUnavailable("No model credential is configured. Configure the existing model service before requesting analysis.")
    base = config.baseUrl or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
    payload = {"model": config.model.strip() or "deepseek-chat", "messages": messages,
               "temperature": 0.1, "max_tokens": 8192,
               "response_format": {"type": "json_object"}}
    # Official DeepSeek reasoning tokens share the output budget. Use its documented
    # non-thinking mode for these bounded JSON calls; do not send vendor extensions
    # to unrelated OpenAI-compatible providers.
    if urlsplit(base).hostname == "api.deepseek.com":
        payload["thinking"] = {"type": "disabled"}
    try:
        async with httpx.AsyncClient(timeout=55.0) as client:
            response = await client.post(base.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {key}"}, json=payload)
        safe_errors = {
            401: "The model service rejected its credential. Check the existing model configuration.",
            402: "The model service returned HTTP 402 (payment/quota issue). Restore service availability before retrying.",
            403: "The model service denied access. Check the configured model and account permissions.",
            429: "The model service is rate-limited. Wait before retrying.",
        }
        if response.status_code in safe_errors:
            raise ModelServiceUnavailable(safe_errors[response.status_code])
        if response.is_error:
            raise ModelServiceUnavailable("The model service is temporarily unavailable. Retry shortly.")
        envelope = response.json()
        choice = envelope["choices"][0]
        if choice.get("finish_reason") == "length":
            raise ModelServiceUnavailable("The model reached its output limit before completing the analysis. Retry with a more focused question.")
        text = choice["message"]["content"]
        if not isinstance(text, str) or not text.strip():
            raise ModelServiceUnavailable("The model returned an empty analysis. Retry the question.")
        result = json.loads(text)
        if not isinstance(result, dict):
            raise ValueError("Expected a JSON object")
        return result
    except httpx.TimeoutException as exc:
        raise ModelServiceUnavailable("The model analysis timed out. Retry with a more focused question.") from exc
    except httpx.RequestError as exc:
        raise ModelServiceUnavailable("The model service could not be reached. Retry shortly.") from exc
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise ModelServiceUnavailable("The model returned an invalid analysis format. Retry the question.") from exc


async def plan_check(config: Any, feedback: str, focus: str, feature_names: list[str], previous: dict | None) -> Plan:
    result = await complete_json(config, [
        {"role": "system", "content": prompt("system") + "\n" + prompt("plan")},
        {"role": "user", "content": json.dumps({"feedback": feedback, "selectedFeature": focus,
            "availableFeatures": feature_names, "previousAnalysis": previous}, ensure_ascii=False)}])
    plan = Plan.model_validate(result)
    if plan.focus and plan.focus not in feature_names:
        raise ValueError("Model selected an unavailable measurement.")
    return plan


async def propose(config: Any, *, feedback: str, context: dict, result: dict,
                  plan: Plan, checks: list[dict], history: list[dict]) -> dict:
    data = {"question": feedback, "case": context, "plan": plan.model_dump(),
            "executedChecks": checks, "measurements": result.get("features", []),
            "quality": result.get("quality", {}), "warnings": result.get("warnings", []),
            "limitations": result.get("adapterNotes", []), "previousRounds": history[-4:]}
    raw = await complete_json(config, [
        {"role": "system", "content": prompt("system") + "\n" + prompt("proposal")},
        {"role": "user", "content": json.dumps(data, ensure_ascii=False)}])
    proposal = Proposal.model_validate(raw)
    allowed = {f["name"] for f in result.get("features", [])}
    if set(proposal.featureNames) - allowed:
        raise ValueError("The response cited an unavailable measurement.")
    if proposal.candidate and proposal.candidate.feature not in allowed:
        raise ValueError("The candidate uses an unavailable measurement.")
    if proposal.candidate and proposal.candidate.feature not in proposal.featureNames:
        proposal.featureNames = [proposal.candidate.feature, *proposal.featureNames][:10]
    if any(len(s) > 800 for s in proposal.unresolved + proposal.nextChecks):
        raise ValueError("The response exceeded the review limits.")
    return proposal.model_dump()


def note_diff(before: str, after: str) -> list[dict[str, str]]:
    """Actual text diff, never a model's unverified claim of what changed."""
    return [{"kind": {"+": "added", "-": "removed", " ": "same"}[line[0]], "text": line[2:]}
            for line in difflib.ndiff(before.splitlines(), after.splitlines()) if line[0] != "?"]


def measurement_changes(before: list[dict], after: list[dict]) -> list[dict]:
    old = {f["name"]: f.get("value") for f in before}
    return [{"name": f["name"], "before": old.get(f["name"]), "after": f.get("value")}
            for f in after if f["name"] in old and old[f["name"]] != f.get("value")]
