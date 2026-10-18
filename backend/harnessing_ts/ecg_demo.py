from __future__ import annotations

from array import array
import ast
import csv
import json
from pathlib import Path
import struct
import sys
from typing import Any
import zipfile


ECG_CLASSES = ("NORM", "MI", "STTC", "CD", "HYP")
WORKSPACE_ROOT = Path.home() / ".harnessts" / "workspaces"
DATASET_DEFINITIONS = (
    {
        "key": "ptbxl",
        "name": "PTB-XL",
        "workspace_names": ("PTB-XL_learning_WEM_extension_20260908", "PTB-XL_learning"),
    },
    {
        "key": "georgia",
        "name": "Georgia",
        "workspace_names": ("Georgia_v6_1", "Georgia_v6"),
    },
    {
        "key": "cpsc",
        "name": "CPSC",
        "workspace_names": ("CPSC_v5_1", "CPSC_v6"),
    },
)


class EcgDemoUnavailable(RuntimeError):
    pass


def build_ecg_overview(
    workspace: Path,
    *,
    status: str = "errors",
    label: str | None = None,
    limit: int = 80,
    dataset_key: str | None = None,
    ecg_id: int | None = None,
) -> dict[str, Any]:
    iteration = _latest_complete_iteration(workspace)
    metrics = _read_json(iteration / "metrics_formal.json")
    ids, ids_shape = _read_npz_array(iteration / "val_probs.npz", "ids")
    flat_probs, probs_shape = _read_npz_array(iteration / "val_probs.npz", "probs")
    if len(probs_shape) != 2 or probs_shape[1] != len(ECG_CLASSES) or ids_shape != (probs_shape[0],):
        raise EcgDemoUnavailable("Latest validation probabilities have an unexpected shape.")
    probs = [flat_probs[index : index + len(ECG_CLASSES)] for index in range(0, len(flat_probs), len(ECG_CLASSES))]

    metadata = _read_metadata(workspace)
    thresholds = {
        name: float(metrics.get("thresholds", {}).get(name, 0.5))
        for name in ECG_CLASSES
    }
    rows: list[dict[str, Any]] = []
    for sample_id, scores in zip(ids, probs, strict=True):
        if ecg_id is not None and int(sample_id) != ecg_id:
            continue
        meta = metadata.get(int(sample_id))
        if not meta:
            continue
        truth = [name for name in ECG_CLASSES if _truth_value(meta, name)]
        predicted = [name for name, score in zip(ECG_CLASSES, scores, strict=True) if score >= thresholds[name]]
        missed = [name for name in truth if name not in predicted]
        added = [name for name in predicted if name not in truth]
        exact = not missed and not added
        if status == "errors" and exact:
            continue
        if status == "correct" and not exact:
            continue
        if label and label not in truth and label not in predicted:
            continue
        rows.append({
            "ecgId": int(sample_id),
            "age": _optional_number(meta.get("age")),
            "sex": "女" if meta.get("sex") == "0" else "男" if meta.get("sex") == "1" else "未知",
            "truth": truth,
            "predicted": predicted,
            "missed": missed,
            "added": added,
            "exact": exact,
            "scores": {name: round(float(score), 6) for name, score in zip(ECG_CLASSES, scores, strict=True)},
            "margins": {name: round(float(score) - thresholds[name], 6) for name, score in zip(ECG_CLASSES, scores, strict=True)},
            "subclasses": _subclasses(meta),
        })

    if status == "all":
        # The all-samples view is paginated by the UI. Keep it in ECG order so
        # the first page is representative instead of silently error-only.
        rows.sort(key=lambda item: item["ecgId"])
    else:
        rows.sort(key=lambda item: (item["exact"], -len(item["missed"]), -len(item["added"]), item["ecgId"]))
    return {
        "workspace": str(workspace),
        "datasetKey": dataset_key or _dataset_key(workspace),
        "datasetName": _dataset_name(dataset_key) or workspace.name,
        "iteration": iteration.name,
        "split": metrics.get("split", "unknown"),
        "sampleCount": int(metrics.get("n", len(ids))),
        "macroAuc": metrics.get("macro_auc"),
        "macroF1": metrics.get("macro_f1"),
        "thresholds": thresholds,
        "classes": metrics.get("per_class", []),
        "filters": {"status": status, "label": label or ""},
        "matchedCount": len(rows),
        "samples": rows[: max(1, min(limit, 200))],
    }


def list_ecg_datasets(current_workspace: Path) -> dict[str, Any]:
    datasets = []
    for definition in DATASET_DEFINITIONS:
        workspace = _resolve_dataset_workspace(definition, current_workspace)
        descriptor = _dataset_descriptor(workspace, current_workspace) if workspace else None
        if descriptor:
            descriptor.update({"key": definition["key"], "name": definition["name"], "available": True})
            datasets.append(descriptor)
            continue
        datasets.append({
            "key": definition["key"],
            "name": definition["name"],
            "workspace": str(workspace) if workspace else "",
            "iteration": None,
            "split": None,
            "sampleCount": 0,
            "macroF1": None,
            "current": bool(workspace and workspace.resolve() == current_workspace.resolve()),
            "available": False,
            "message": "当前没有可直接展示的 ECG 指标和波形产物",
        })
    selected = "ptbxl"
    if not any(item["key"] == selected and item["available"] for item in datasets):
        selected = next((item["key"] for item in datasets if item["available"]), "ptbxl")
    return {"selected": selected, "datasets": datasets}


def resolve_ecg_workspace(current_workspace: Path, dataset_key: str | None) -> Path:
    if not dataset_key:
        return current_workspace
    registry = list_ecg_datasets(current_workspace)
    for dataset in registry["datasets"]:
        if dataset["key"] == dataset_key:
            if not dataset.get("available"):
                raise EcgDemoUnavailable(dataset.get("message") or f"Dataset {dataset_key} is unavailable.")
            return Path(dataset["workspace"])
    raise EcgDemoUnavailable(f"Unknown ECG dataset: {dataset_key}")


def load_ecg_waveform(workspace: Path, ecg_id: int) -> dict[str, Any]:
    metadata = _read_metadata(workspace)
    meta = metadata.get(ecg_id)
    if not meta:
        raise EcgDemoUnavailable(f"ECG sample {ecg_id} is not present in workspace metadata.")
    dataset = workspace / "data" / "raw" / "dataset"
    relative = meta.get("filename_lr", "")
    if not relative:
        raise EcgDemoUnavailable(f"ECG sample {ecg_id} has no low-resolution waveform path.")
    record = dataset / relative
    header_path = record.with_suffix(".hea")
    data_path = record.with_suffix(".dat")
    if not header_path.is_file() or not data_path.is_file():
        raise EcgDemoUnavailable(f"Waveform files for ECG sample {ecg_id} are unavailable.")

    header_lines = header_path.read_text(encoding="ascii", errors="replace").splitlines()
    first = header_lines[0].split()
    signal_count = int(first[1])
    sample_rate = float(first[2].split("/")[0])
    sample_count = int(first[3])
    signals = []
    for line in header_lines[1 : 1 + signal_count]:
        fields = line.split()
        if len(fields) < 9 or fields[1] != "16":
            raise EcgDemoUnavailable("Only standard WFDB format-16 ECG records are supported.")
        gain = float(fields[2].split("(")[0].split("/")[0])
        baseline = float(fields[4])
        signals.append({"gain": gain, "baseline": baseline, "lead": fields[-1]})

    raw = array("h")
    raw.frombytes(data_path.read_bytes())
    if sys.byteorder != "little":
        raw.byteswap()
    expected = signal_count * sample_count
    if len(raw) < expected:
        raise EcgDemoUnavailable("Waveform data is shorter than declared by its WFDB header.")

    leads = []
    for index, signal in enumerate(signals):
        values = [
            round((raw[offset + index] - signal["baseline"]) / signal["gain"], 4)
            for offset in range(0, expected, signal_count)
        ]
        leads.append({"name": signal["lead"], "unit": "mV", "values": values})
    return {
        "ecgId": ecg_id,
        "sampleRate": sample_rate,
        "durationSeconds": round(sample_count / sample_rate, 3),
        "sampleCount": sample_count,
        "leads": leads,
    }


def _latest_complete_iteration(workspace: Path) -> Path:
    root = workspace / "runs" / "iterations"
    candidates = [
        path
        for path in root.iterdir()
        if path.is_dir()
        and path.name.isdigit()
        and (path / "metrics_formal.json").is_file()
        and (path / "val_probs.npz").is_file()
    ] if root.is_dir() else []
    if not candidates:
        raise EcgDemoUnavailable("No completed ECG iteration with metrics and validation probabilities was found.")
    return max(candidates, key=lambda path: int(path.name))


def _workspace_candidates() -> list[Path]:
    if not WORKSPACE_ROOT.is_dir():
        return []
    return sorted((path for path in WORKSPACE_ROOT.iterdir() if path.is_dir()), key=lambda path: path.name)


def _resolve_dataset_workspace(definition: dict[str, Any], current_workspace: Path) -> Path | None:
    names = set(definition["workspace_names"])
    if definition["key"] == "ptbxl" and current_workspace.name.lower().startswith("ptb"):
        return current_workspace
    for workspace in _workspace_candidates():
        if workspace.name in names:
            return workspace
    return None


def _dataset_descriptor(workspace: Path, current_workspace: Path) -> dict[str, Any] | None:
    try:
        iteration = _latest_complete_iteration(workspace)
        _read_metadata(workspace)
    except (EcgDemoUnavailable, OSError):
        return None
    if not (workspace / "data" / "raw" / "dataset").is_dir():
        return None
    try:
        metrics = _read_json(iteration / "metrics_formal.json")
    except (OSError, json.JSONDecodeError):
        return None
    return {
        "key": _dataset_key(workspace),
        "name": workspace.name,
        "workspace": str(workspace),
        "iteration": iteration.name,
        "split": metrics.get("split", "unknown"),
        "sampleCount": int(metrics.get("n", 0)),
        "macroF1": metrics.get("macro_f1"),
        "current": workspace.resolve() == current_workspace.resolve(),
    }


def _dataset_key(workspace: Path) -> str:
    return workspace.resolve().name


def _dataset_name(dataset_key: str | None) -> str | None:
    for definition in DATASET_DEFINITIONS:
        if definition["key"] == dataset_key:
            return definition["name"]
    return None


def _read_metadata(workspace: Path) -> dict[int, dict[str, str]]:
    path = workspace / "data" / "processed" / "ptbxl_meta_labels.csv"
    if not path.is_file():
        raise EcgDemoUnavailable("PTB-XL metadata is unavailable in the current workspace.")
    with path.open(newline="", encoding="utf-8") as handle:
        return {int(row["ecg_id"]): row for row in csv.DictReader(handle)}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_npz_array(path: Path, name: str) -> tuple[list[int | float], tuple[int, ...]]:
    try:
        with zipfile.ZipFile(path) as archive:
            payload = archive.read(f"{name}.npy")
    except (KeyError, OSError, zipfile.BadZipFile) as exc:
        raise EcgDemoUnavailable(f"Unable to read {name} from {path.name}.") from exc
    if payload[:6] != b"\x93NUMPY":
        raise EcgDemoUnavailable(f"{name}.npy has an invalid NumPy header.")
    major = payload[6]
    header_size_width = 2 if major == 1 else 4
    header_size = int.from_bytes(payload[8 : 8 + header_size_width], "little")
    start = 8 + header_size_width
    header = ast.literal_eval(payload[start : start + header_size].decode("latin1").strip())
    shape = tuple(int(value) for value in header["shape"])
    if header.get("fortran_order"):
        raise EcgDemoUnavailable("Fortran-ordered NumPy arrays are not supported.")
    formats = {"<f4": "f", "<f8": "d", "<i8": "q", "<i4": "i", "|i8": "q", "|i4": "i"}
    code = formats.get(header.get("descr"))
    if not code:
        raise EcgDemoUnavailable(f"Unsupported NumPy dtype: {header.get('descr')}")
    data = payload[start + header_size :]
    size = struct.calcsize("<" + code)
    values = [value[0] for value in struct.iter_unpack("<" + code, data)]
    expected = 1
    for dimension in shape:
        expected *= dimension
    if len(data) % size or len(values) != expected:
        raise EcgDemoUnavailable(f"{name}.npy data length does not match its shape.")
    return values, shape


def _truth_value(row: dict[str, str], label: str) -> bool:
    return row.get(f"SUP_{label}", "0") in {"1", "1.0", "true", "True"}


def _subclasses(row: dict[str, str]) -> list[str]:
    return [key.removeprefix("SC_") for key, value in row.items() if key.startswith("SC_") and value in {"1", "1.0"}]


def _optional_number(value: str | None) -> int | float | None:
    if not value:
        return None
    number = float(value)
    return int(number) if number.is_integer() else number
