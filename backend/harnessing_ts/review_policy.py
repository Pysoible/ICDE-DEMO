"""Experimental, case-local review overlays; never execute generated code."""
from __future__ import annotations

import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

METRICS = {"qrs_duration_ms": ("qrs_ms", "ms"), "pr_interval_ms": (None, "ms"),
           "pathological_q_wave_count_other_leads": ("count", "leads")}


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    feature: Literal["qrs_duration_ms", "pr_interval_ms", "pathological_q_wave_count_other_leads"]
    lower: float | None = Field(default=None, ge=0, le=10000, strict=True)
    upper: float | None = Field(default=None, ge=0, le=10000, strict=True)
    lowerInclusive: bool = True
    upperInclusive: bool = False
    action: Literal["needs_review"] = "needs_review"
    rationale: str = Field(min_length=3, max_length=800)

    @model_validator(mode="after")
    def check_range(self):
        if self.lower is None and self.upper is None:
            raise ValueError("At least one bound is required")
        if self.lower is not None and self.upper is not None and self.lower >= self.upper:
            raise ValueError("Lower bound must be smaller than upper bound")
        return self


def scalar(feature: dict | None) -> float | None:
    if not feature or feature.get("name") not in METRICS:
        return None
    key, _ = METRICS[feature["name"]]
    value = feature.get("value")
    if key:
        value = value.get(key) if isinstance(value, dict) else None
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def matches(candidate: Candidate, value: float | None) -> bool | None:
    if value is None or not math.isfinite(value):
        return None
    return ((candidate.lower is None or (value >= candidate.lower if candidate.lowerInclusive else value > candidate.lower))
            and (candidate.upper is None or (value <= candidate.upper if candidate.upperInclusive else value < candidate.upper)))


def replay_row(candidate: Candidate, feature: dict | None, ecg_id: int, context_id: str) -> dict:
    value = scalar(feature)
    original = (feature or {}).get("judgment", {}).get("status", "unavailable")
    usable = original in {"normal", "abnormal"}
    matched = matches(candidate, value) if usable else None
    return {"ecgId": ecg_id, "contextId": context_id, "value": value, "originalStatus": original,
            "matched": matched, "beforeFlag": "no_overlay",
            "afterFlag": "needs_review" if matched else "no_overlay" if matched is False else "not_assessable",
            "outcome": "changed" if matched else "unchanged" if matched is False else "not_assessable"}


def boundary_tests(candidate: Candidate) -> list[dict]:
    points = set()
    for bound in (candidate.lower, candidate.upper):
        if bound is not None:
            points.update(x for x in (bound - 1, bound, bound + 1) if x >= 0)
    if candidate.lower is not None and candidate.upper is not None:
        points.add((candidate.lower + candidate.upper) / 2)
    return [{"value": v, "matched": matches(candidate, v), "kind": "synthetic_boundary"} for v in sorted(points)] + [
        {"value": None, "matched": None, "kind": "missing_measurement"}]
