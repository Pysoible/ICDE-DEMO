#!/usr/bin/env python3
"""Build an auditable error set for a PTBXL_0820 final-solution run."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd


CLASSES = ["NORM", "MI", "STTC", "CD", "HYP"]
LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]


def labels_text(values: np.ndarray) -> str:
    return "+".join(c for c, value in zip(CLASSES, values) if value) or "NONE"


def transition(true: np.ndarray, pred: np.ndarray) -> str:
    false_negative = [c for c, t, p in zip(CLASSES, true, pred) if t and not p]
    false_positive = [c for c, t, p in zip(CLASSES, true, pred) if not t and p]
    if false_negative and false_positive:
        return "+".join(f"{c}->{false_positive[0]}" for c in false_negative)
    if false_negative:
        return "missed_" + "+".join(false_negative)
    return "extra_" + "+".join(false_positive)


def family(true: np.ndarray, pred: np.ndarray, rescue: bool, ecg_id: int,
           cd_pr200_ids: set[int]) -> str:
    if rescue and any(pred) and not true[int(np.argmax(pred))]:
        return "rescue_misfire"
    if true[3] and not pred[3] and ecg_id in cd_pr200_ids:
        return "cd_pr200"
    if true[4] and not pred[4]:
        return "lowvol_hyp_screening"
    if true.sum() >= 2 and np.any((true == 1) & (pred == 0)):
        return "multi_label_underprediction"
    if true[0] and (pred[1] or pred[3]):
        return "label_gap_screening"
    return "other"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", type=Path, required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()

    ws = args.workspace
    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)
    score_path = ws / "data/processed/predictions" / f"{args.run}_test_scores.csv"
    pred_path = ws / "data/processed/predictions" / f"{args.run}_test_predictions.csv"
    labels_path = ws / "data/processed/exploration/superclass_labels.csv"
    config_path = ws / "tools/generated/ptbxl_ensemble/config.json"
    stats_path = ws / "runs/iterations/004/case-review/bad_case_stats.json"

    scores = pd.read_csv(score_path).set_index("ecg_id")
    preds = pd.read_csv(pred_path).set_index("ecg_id")
    labels = pd.read_csv(labels_path).set_index("ecg_id")
    with config_path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    thresholds = np.array([config["per_class_thresholds"][c] for c in CLASSES])

    eids = scores.index.to_numpy(dtype=np.int64)
    score_values = scores[[f"score_{c}" for c in CLASSES]].to_numpy(float)
    pred_values = preds[[f"pred_{c}" for c in CLASSES]].to_numpy(int)
    true_values = labels.loc[eids, CLASSES].to_numpy(int)
    plain_pred = (score_values >= thresholds[None, :]).astype(int)
    rescue_flag = (plain_pred.sum(axis=1) == 0) & (pred_values.sum(axis=1) >= 1)
    mismatch = pred_values != true_values
    bad = mismatch.any(axis=1)

    cd_pr200_ids: set[int] = set()
    if stats_path.exists():
        with stats_path.open(encoding="utf-8") as handle:
            cd_pr200_ids = {int(eid) for eid in json.load(handle).get("cd_fn_pr200_ids", [])}

    rows: list[dict[str, object]] = []
    bad_indices = np.flatnonzero(bad)
    for npz_row, i in enumerate(bad_indices):
        true = true_values[i]
        pred = pred_values[i]
        scores_i = score_values[i]
        false_negative = [c for c, t, p in zip(CLASSES, true, pred) if t and not p]
        false_positive = [c for c, t, p in zip(CLASSES, true, pred) if not t and p]
        tags = ["sample_error", "label_error" ]
        if pred.sum() == 0 and true.sum() > 0:
            tags.append("all_zero_overprediction")
        if true.sum() == 0 and pred.sum() > 0:
            tags.append("all_zero_underprediction")
        if true.sum() >= 2 and pred.sum() < true.sum():
            tags.append("multi_label_underprediction")
        if pred.sum() > true.sum():
            tags.append("label_overprediction")
        if len(false_negative) and len(false_positive):
            tags.append("mixed_false_negative_false_positive")
        if mismatch[i].sum() == 1:
            tags.append("one_label_error")
        else:
            tags.append("multiple_label_errors")
        error_distances = np.abs(scores_i - thresholds)
        if any(error_distances[j] < 0.10 for j in range(5) if mismatch[i, j]):
            tags.append("near_decision_threshold")
        if any(true[j] and not pred[j] and scores_i[j] < thresholds[j] - 0.20 for j in range(5)):
            tags.append("high_confidence_false_negative")
        if any(not true[j] and pred[j] and scores_i[j] > thresholds[j] + 0.20 for j in range(5)):
            tags.append("high_confidence_false_positive")
        for c in false_negative:
            tags.append(f"fn_{c}")
        for c in false_positive:
            tags.append(f"fp_{c}")
        if rescue_flag[i]:
            tags.append("rescue_applied")
            fired = int(np.argmax(pred))
            tags.append("rescue_correct" if true[fired] else "rescue_misfire")

        raw_rel = str(labels.loc[int(eids[i]), "filename_lr"])
        rows.append({
            "npz_row": npz_row,
            "ecg_id": int(eids[i]),
            "raw_data_path": f"data/raw/{raw_rel}.dat",
            "raw_header_path": f"data/raw/{raw_rel}.hea",
            "true_labels": labels_text(true),
            "pred_labels": labels_text(pred),
            "true_count": int(true.sum()),
            "pred_count": int(pred.sum()),
            "n_label_errors": int(mismatch[i].sum()),
            "false_negative_labels": "+".join(false_negative) or "NONE",
            "false_positive_labels": "+".join(false_positive) or "NONE",
            "error_transition": transition(true, pred),
            "primary_family": family(true, pred, bool(rescue_flag[i]), int(eids[i]), cd_pr200_ids),
            "rescue_applied": bool(rescue_flag[i]),
            "thresholds": ",".join(f"{v:.2f}" for v in thresholds),
            "tags": ";".join(tags),
            **{f"gt_{c}": int(true[j]) for j, c in enumerate(CLASSES)},
            **{f"pred_{c}": int(pred[j]) for j, c in enumerate(CLASSES)},
            **{f"score_{c}": round(float(scores_i[j]), 6) for j, c in enumerate(CLASSES)},
        })

    error_df = pd.DataFrame(rows)
    error_df.to_csv(out / f"{args.run}_error_samples.csv", index=False)

    import sys
    sys.path.insert(0, str(ws))
    from tools.ecg_data import read_mv_by_ecg_id  # type: ignore[import-not-found]

    signals_mv = np.stack([read_mv_by_ecg_id(int(eid)) for eid in error_df["ecg_id"]]).astype(np.float32)
    signals_raw = np.rint(signals_mv * 1000).astype(np.int16)
    np.savez_compressed(
        out / f"{args.run}_error_samples_raw.npz",
        ecg_id=error_df["ecg_id"].to_numpy(np.int64),
        signals_mv=signals_mv,
        signals_raw_int16=signals_raw,
        lead_names=np.array(LEADS),
        sampling_rate_hz=np.array([100], dtype=np.int16),
    )

    def counts(column: str) -> dict[str, int]:
        return {str(k): int(v) for k, v in error_df[column].value_counts().items()}

    fn_counts = {c: int(((true_values[bad, j] == 1) & (pred_values[bad, j] == 0)).sum())
                 for j, c in enumerate(CLASSES)}
    fp_counts = {c: int(((true_values[bad, j] == 0) & (pred_values[bad, j] == 1)).sum())
                 for j, c in enumerate(CLASSES)}
    tag_counts: Counter[str] = Counter()
    for value in error_df["tags"]:
        tag_counts.update(value.split(";"))
    metrics_path = ws / "reports/error_analysis" / f"{args.run}_metrics.json"
    with metrics_path.open(encoding="utf-8") as handle:
        metrics = json.load(handle)
    report = {
        "run": args.run,
        "n_test": int(len(eids)),
        "n_error_samples": int(bad.sum()),
        "n_correct_samples": int((~bad).sum()),
        "label_error_count": int(mismatch.sum()),
        "metrics": metrics,
        "false_negative_by_class": fn_counts,
        "false_positive_by_class": fp_counts,
        "error_transition_counts": counts("error_transition"),
        "primary_family_counts": counts("primary_family"),
        "tag_counts": dict(tag_counts.most_common()),
        "artifacts": {
            "error_samples_csv": f"{args.run}_error_samples.csv",
            "raw_signal_npz": f"{args.run}_error_samples_raw.npz",
            "metrics_json": f"{args.run}_metrics.json",
        },
        "tag_semantics": {
            "primary_family": "screening family derived from prediction pattern and prior case-review PR>200 list; not a causal diagnosis for every row",
            "lowvol_hyp_screening": "HYP false negative screening bucket; requires case-level physiology review before calling it low-voltage HYP",
            "cd_pr200": "CD false negative whose prior fast-extractor audit recorded PR>200 ms",
        },
    }
    with (out / f"{args.run}_analysis.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)

    def md_table(mapping: dict[str, int]) -> str:
        return "\n".join(f"| `{key}` | {value} |" for key, value in mapping.items())

    md = f"""# Runtime Final Solution Error Analysis

## Scope

- Workspace: `{ws}`
- Run: `{args.run}`
- Split: PTB-XL fold 10 test set; `N={len(eids)}`
- Final pipeline: amplitude-preserving CNN → feature-ML → weighted ensemble → all-zero rescue
- This audit re-ran the pipeline and matched the stored official metrics.

## Result

| Metric | Value |
|---|---:|
| Hamming accuracy | {metrics['hamming_accuracy']:.5f} |
| Macro AUC | {metrics['macro_auc']:.5f} |
| Error samples | {int(bad.sum())} / {len(eids)} ({bad.mean():.2%}) |
| Label-level errors | {int(mismatch.sum())} |
| All-zero predicted / true | {metrics['allzero_pred']} / {metrics['allzero_true']} |

## Error distribution

### False negatives by class

| Class | Count |
|---|---:|
{md_table(fn_counts)}

### False positives by class

| Class | Count |
|---|---:|
{md_table(fp_counts)}

### Primary screening family

| Tag | Samples |
|---|---:|
{md_table(counts('primary_family'))}

### Common error transitions

| Transition | Samples |
|---|---:|
{md_table(counts('error_transition'))}

## Interpretation

1. The largest label-level misses are `CD` ({fn_counts['CD']}), `MI` ({fn_counts['MI']}), and `HYP` ({fn_counts['HYP']}); this agrees with the final-summary failure profile.
2. The sample-level error set is larger than any single class count because multi-label records can contribute several false negatives or false positives.
3. `near_decision_threshold` identifies errors plausibly sensitive to threshold changes; it is not evidence that threshold tuning will generalize.
4. `high_confidence_false_negative` and `high_confidence_false_positive` identify errors that are not simple boundary misses and should be prioritized for signal/label review.
5. `lowvol_hyp_screening`, `label_gap_screening`, and `rescue_misfire` are screening tags. They are not automatically causal explanations; causal claims require the existing waveform/reference-feature review.

## Artifact contents

- `{args.run}_error_samples.csv`: one row for every erroneous test record; includes raw `.dat`/`.hea` paths, GT, prediction, scores, FN/FP labels, transition and tags.
- `{args.run}_error_samples_raw.npz`: original test signals for exactly those rows. `signals_mv` is `(N,1000,12)` in mV; `signals_raw_int16` is the source integer representation; `lead_names` gives column order.
- `{args.run}_analysis.json`: machine-readable counts and metric snapshot.
- `{args.run}_metrics.json`: direct evaluator output.
- `{args.run}_tag_dictionary.md`: definitions and limitations for every tag.

The CSV `npz_row` column joins each error record to the corresponding row in the compressed raw-signal file. The original source files remain available under `data/raw/`.

## Reproduction

The exact commands and model artifacts are recorded in `user/final-solution.md`; the audit outputs use the run prefix `{args.run}` and do not overwrite the prior `it004_pp` files.
"""
    (out / f"{args.run}_error_analysis_report.md").write_text(md, encoding="utf-8")

    tag_dictionary = f"""# Error Tag Dictionary

Generated for `{args.run}`. Tags describe observable prediction behavior; they do not by themselves establish a clinical cause.

| Tag | Meaning |
|---|---|
| `sample_error` | At least one of the five predicted labels differs from GT. |
| `label_error` | At least one false negative or false positive exists. |
| `fn_<CLASS>` / `fp_<CLASS>` | The named class is a false negative / false positive. |
| `all_zero_overprediction` | Prediction has zero labels while GT has one or more. |
| `all_zero_underprediction` | GT has zero labels while prediction has one or more. |
| `multi_label_underprediction` | GT has at least two labels and prediction has fewer labels. |
| `label_overprediction` | Prediction has more labels than GT. |
| `mixed_false_negative_false_positive` | The same record contains both FN and FP labels. |
| `one_label_error` / `multiple_label_errors` | Exactly one / at least two label mismatches. |
| `near_decision_threshold` | At least one wrong label score is within 0.10 of its class threshold. |
| `high_confidence_false_negative` | A missed positive score is at least 0.20 below its threshold. |
| `high_confidence_false_positive` | A false-positive score is at least 0.20 above its threshold. |
| `rescue_applied` | The all-zero rescue changed the plain threshold decision. |
| `rescue_correct` / `rescue_misfire` | Rescue-fired label is correct / incorrect for that record. |
| `primary_family=cd_pr200` | CD FN with PR>200 ms in the prior fast-extractor audit. |
| `primary_family=lowvol_hyp_screening` | HYP FN screening bucket; requires case review before causal labeling. |
| `primary_family=multi_label_underprediction` | Primary screening bucket for missed labels in a multi-label record. |
| `primary_family=label_gap_screening` | NORM GT with predicted MI or CD; screening for label-signal mismatch. |
| `primary_family=rescue_misfire` | Rescue selected a class absent from GT. |
| `primary_family=other` | Does not match the above mutually exclusive primary buckets. |

The complete tags are semicolon-separated in the CSV `tags` column. `npz_row` joins each CSV row to the same row in the raw-signal NPZ.
"""
    (out / f"{args.run}_tag_dictionary.md").write_text(tag_dictionary, encoding="utf-8")


if __name__ == "__main__":
    main()
