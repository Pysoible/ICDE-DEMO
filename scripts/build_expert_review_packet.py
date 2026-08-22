#!/usr/bin/env python3
"""Build a Chinese, non-CS medical-expert review packet for PTBXL errors."""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


CLASSES = ["NORM", "MI", "STTC", "CD", "HYP"]
CLASS_ZH = {
    "NORM": "NORM（正常）",
    "MI": "MI（心肌梗死相关）",
    "STTC": "STTC（ST-T改变）",
    "CD": "CD（传导异常）",
    "HYP": "HYP（心肌肥厚相关）",
}
LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]
CASE_INFO = {
    218: {
        "title": "PR间期明显延长，但CD被漏掉",
        "summary": "数据集标签含 NORM+CD，模型只预测 NORM。审阅记录显示 PR 间期约260 ms；这是一个适合判断“传导异常是否确实存在”的病例。",
        "question": "请判断：PR延长是否足以支持CD标签？该标签是否可能代表一度房室传导阻滞或其他传导问题？",
    },
    162: {
        "title": "多标签病例中漏掉MI",
        "summary": "数据集标签含 MI+STTC+CD+HYP，模型预测了后三者但漏掉MI。该病例用于判断多个异常同时存在时，MI证据是否被其他异常掩盖。",
        "question": "请判断：波形中是否有支持MI的独立证据？MI标签是否可靠，还是应理解为其他ST-T/QRS改变？",
    },
    1785: {
        "title": "HYP标签与可测电压证据不一致",
        "summary": "数据集标签为HYP，模型预测NORM。既有审阅显示常用电压标准未达到，且没有明确的HYP线索；这是判断标签边界的重要病例。",
        "question": "请判断：从临床心电图角度，是否仍能支持肥厚或劳损？如果不能，是否更像标签不确定或存在超出当前记录的信息？",
    },
    1158: {
        "title": "标签为NORM，但波形呈MI样",
        "summary": "数据集标签为NORM，模型预测MI。既有审阅显示V1–V3存在病理性Q波样表现；这是判断“模型错了”还是“数据标签与波形不一致”的病例。",
        "question": "请判断：该波形是否确实具有MI相关意义？NORM标签是否可能是数据记录或标注口径造成的？",
    },
    172: {
        "title": "无明显Q波，却被预测为MI",
        "summary": "数据集标签为CD，模型预测CD+MI。既有审阅显示没有明显病理性Q波，但存在ST-T与QRS不一致；这是区分MI与传导异常继发改变的病例。",
        "question": "请判断：该MI预测是否有独立依据，还是更可能由传导异常引起继发性ST-T改变？",
    },
    1571: {
        "title": "后处理规则把低分病例推成NORM",
        "summary": "数据集标签为MI+CD，模型原始分数全部低于阈值，随后“全零救援”规则选择了NORM。该病例用于判断模型本身与后处理规则各自造成了什么影响。",
        "question": "请判断：波形是否存在MI或CD证据？如果存在，这类“模型不确定、规则选NORM”的病例应如何处理？",
    },
}


def choose_font() -> str:
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return ""


def label_text(row: pd.Series, prefix: str) -> str:
    values = [row[f"{prefix}_{c}"] for c in CLASSES]
    return "+".join(c for c, value in zip(CLASSES, values) if int(value)) or "无标签"


def plot_class_errors(full_scores: pd.DataFrame, labels: pd.DataFrame, out: Path) -> None:
    y_true = labels.loc[full_scores.ecg_id, CLASSES].to_numpy(int)
    y_pred = full_scores[[f"pred_{c}" for c in CLASSES]].to_numpy(int)
    fn = ((y_true == 1) & (y_pred == 0)).sum(axis=0)
    fp = ((y_true == 0) & (y_pred == 1)).sum(axis=0)
    names = [CLASS_ZH[c] for c in CLASSES]
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.6), dpi=180)
    for ax, values, title, color in zip(
        axes, [fn, fp], ["漏检：标签存在但模型未报出", "误报：模型报出但标签不存在"], ["#D55E00", "#0072B2"]
    ):
        order = np.argsort(values)
        ax.barh(np.array(names)[order], values[order], color=color, alpha=0.9)
        ax.set_title(title, fontsize=13, weight="bold")
        ax.set_xlabel("病例中的标签数量")
        ax.grid(axis="x", alpha=0.2)
        for y, value in enumerate(values[order]):
            ax.text(value + 2, y, str(value), va="center", fontsize=10)
    fig.suptitle("最终方案在测试集上的类别错误分布", fontsize=16, weight="bold")
    fig.tight_layout()
    fig.savefig(out / "01_class_error_counts.png", bbox_inches="tight")
    plt.close(fig)


def plot_label_counts(full_scores: pd.DataFrame, labels: pd.DataFrame, out: Path) -> None:
    y_true = labels.loc[full_scores.ecg_id, CLASSES].to_numpy(int).sum(axis=1)
    y_pred = full_scores[[f"pred_{c}" for c in CLASSES]].to_numpy(int).sum(axis=1)
    bins = np.arange(6)
    true_counts = [(y_true == k).sum() for k in bins]
    pred_counts = [(y_pred == k).sum() for k in bins]
    width = 0.36
    fig, ax = plt.subplots(figsize=(10, 5.5), dpi=180)
    ax.bar(bins - width / 2, true_counts, width, label="数据集标签", color="#009E73")
    ax.bar(bins + width / 2, pred_counts, width, label="模型预测", color="#CC79A7")
    ax.set_xticks(bins, [f"{k}个" for k in bins])
    ax.set_ylabel("病例数")
    ax.set_xlabel("每条心电图包含的异常标签数")
    ax.set_title("模型对“单一异常/多种异常同时存在”的判断", fontsize=15, weight="bold")
    ax.legend(frameon=False)
    ax.grid(axis="y", alpha=0.2)
    fig.tight_layout()
    fig.savefig(out / "02_label_count_distribution.png", bbox_inches="tight")
    plt.close(fig)


def plot_transitions(error_df: pd.DataFrame, out: Path) -> None:
    counts = error_df.error_transition.value_counts().head(12).sort_values()
    fig, ax = plt.subplots(figsize=(10, 6.5), dpi=180)
    ax.barh(counts.index, counts.values, color="#56B4E9")
    ax.set_xlabel("病例数")
    ax.set_title("最常见的错误方向（简化表示）", fontsize=15, weight="bold")
    ax.grid(axis="x", alpha=0.2)
    for y, value in enumerate(counts.values):
        ax.text(value + 1, y, str(value), va="center")
    fig.tight_layout()
    fig.savefig(out / "03_common_error_transitions.png", bbox_inches="tight")
    plt.close(fig)


def plot_rescue(error_df: pd.DataFrame, out: Path) -> None:
    misfire = int(error_df.tags.str.contains("rescue_misfire", regex=False).sum())
    correct = 45
    values = [correct, misfire]
    fig, ax = plt.subplots(figsize=(8, 5), dpi=180)
    bars = ax.bar(["救援后正确", "救援后错误"], values, color=["#009E73", "#D55E00"], width=0.58)
    ax.set_ylabel("病例数")
    ax.set_title("全零救援规则：正确与错误结果", fontsize=14, weight="bold")
    ax.grid(axis="y", alpha=0.2)
    for bar, value in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, value + 1, str(value), ha="center", weight="bold")
    fig.tight_layout()
    fig.savefig(out / "04_rescue_rule_outcome.png", bbox_inches="tight")
    plt.close(fig)


def plot_case(case_id: int, error_df: pd.DataFrame, raw: np.lib.npyio.NpzFile, out: Path) -> None:
    row = error_df.loc[error_df.ecg_id == case_id].iloc[0]
    signal = raw["signals_mv"][int(row.npz_row)]
    fig, axes = plt.subplots(12, 1, figsize=(12, 15), sharex=True, dpi=180)
    time = np.arange(signal.shape[0]) / 100
    for lead, axis in zip(LEADS, axes):
        axis.plot(time, signal[:, LEADS.index(lead)], color="#22577A", lw=0.65)
        axis.axhline(0, color="#999999", lw=0.35, alpha=0.5)
        axis.set_ylabel(lead, rotation=0, labelpad=22, fontsize=9, weight="bold")
        axis.grid(alpha=0.15)
        axis.tick_params(axis="y", labelsize=7)
    axes[-1].set_xlabel("时间（秒）")
    axes[-1].set_xlim(0, 10)
    info = CASE_INFO[case_id]
    fig.suptitle(
        f"病例 {case_id}：{info['title']}\n"
        f"数据集标签：{label_text(row, 'gt')}    模型预测：{label_text(row, 'pred')}",
        fontsize=15,
        weight="bold",
    )
    fig.text(0.5, 0.012, "原始12导联信号；100 Hz采样，10秒；此图用于专家复核，不构成单独诊断。", ha="center", fontsize=9, color="#555555")
    fig.tight_layout(rect=[0.04, 0.025, 1, 0.93])
    fig.savefig(out / f"case_{case_id}_waveform.png", bbox_inches="tight")
    plt.close(fig)


def build_markdown(packet: Path, error_df: pd.DataFrame, metrics: dict, labels: pd.DataFrame) -> None:
    fn = {c: int(error_df[f"gt_{c}"].sub(error_df[f"pred_{c}"]).gt(0).sum()) for c in CLASSES}
    fp = {c: int(error_df[f"pred_{c}"].sub(error_df[f"gt_{c}"]).gt(0).sum()) for c in CLASSES}
    family = error_df.primary_family.value_counts().to_dict()
    case_rows = []
    for case_id, info in CASE_INFO.items():
        row = error_df.loc[error_df.ecg_id == case_id].iloc[0]
        score_text = ", ".join(f"{c} {row[f'score_{c}']:.3f}" for c in CLASSES)
        case_rows.append(
            f"### 病例 {case_id}：{info['title']}\n\n"
            f"![病例 {case_id} 心电图](assets/case_{case_id}_waveform.png)\n\n"
            f"- **数据集标签**：`{label_text(row, 'gt')}`；**模型预测**：`{label_text(row, 'pred')}`。\n"
            f"- **模型分数**：{score_text}（0到1之间，仅表示模型内部信心，不等于诊断概率）。\n"
            f"- **为什么选它**：{info['summary']}\n"
            f"- **请专家重点判断**：{info['question']}\n\n"
        )

    md = f"""# RecursiveECG 心电图错误样本专家复核包

> **给医学专家的阅读说明**：这份材料不要求编程知识。请把“数据集标签”理解为原始数据库提供的参考标注，把“模型预测”理解为系统对同一条心电图给出的类别判断。两者不一致，并不自动意味着模型或标签一定错误，尤其需要区分：真正漏看了波形证据、标签本身存在边界、以及多个异常同时出现时的取舍。

## 一页结论

本次复核对象是 PTB-XL 测试集的 **2203** 条 10 秒、12 导联心电图。最终方案的整体指标为：Hamming准确率 **0.88679**，宏平均AUC **0.92615**。共有 **816 条**心电图至少有一个类别判断不一致，合计 **1247 个**类别级错误。

最值得医学复核的不是“所有错误都逐条看”，而是以下四类问题：

1. **传导异常（CD）漏检最多**：174 个漏检，尤其是只有PR间期延长、或存在轴偏移但模型偏向NORM的病例。
2. **心肌肥厚相关标签（HYP）存在边界问题**：138 个漏检；部分标签缺少常用电压或形态学支持，可能需要判断标注口径或临床资料是否超出这条10秒记录。
3. **多种异常共存时容易漏掉其中一种**：例如MI+STTC+CD+HYP同时存在时，模型可能只报出其中三种。
4. **标签与波形可能不完全一致**：例如标签是NORM，但波形呈MI样；也有标签为CD但MI预测可能由传导异常继发ST-T改变引起。

## 1. 总体错误图景

![各类别漏检和误报](assets/01_class_error_counts.png)

图1显示：CD、MI、HYP是主要漏检类别；NORM是主要误报类别。这里的“误报”只是模型与数据库标签不一致，不等价于临床上一定误诊。

![标签数量分布](assets/02_label_count_distribution.png)

图2显示模型对“同一病例同时存在多种异常”的判断偏少：真实数据中2个标签的病例有400条，模型预测为2个标签的只有340条。这支持“多标签漏检”是系统性问题，而不是少数偶然病例。

![常见错误方向](assets/03_common_error_transitions.png)

图3是错误方向的简化统计，例如 `CD→NORM` 表示数据库标签含CD、模型预测为NORM；`missed_CD` 表示只漏掉CD而没有相应误报。

![救援规则结果](assets/04_rescue_rule_outcome.png)

图4说明最后增加的“全零救援”规则：当模型没有任何类别超过阈值时，强行选择一个分数最高的类别。它能挽回一部分全零结果，但也会把一些真实的MI/CD/STTC病例推成NORM，因此需要专家判断是否保留这种规则。

## 2. 关键病例

以下病例不是随机展示，而是覆盖了最重要的失败机制。每张图均为原始12导联信号，纵轴为电压，横轴为10秒时间；请结合临床经验判断，而不要仅根据模型分数下结论。

{''.join(case_rows)}

## 3. 建议专家重点回答的问题

请对每个关键病例尽量回答以下问题：

1. **标签可信度**：数据库标签是否与这条12导联心电图一致？是否存在标签过宽、漏标、或临床诊断依据不在这条记录中的可能？
2. **波形证据**：如果模型漏检，波形上是否存在明确、可重复识别的证据？如果模型误报，是否有可能是另一种异常造成的相似表现？
3. **共存异常**：多个标签同时出现时，是否能明确支持每一个标签，还是某些标签只是伴随/推测性标注？
4. **临床优先级**：若只能优先修复一类错误，哪一类对医学使用最重要：CD漏检、HYP边界、MI误报，还是NORM偏向？
5. **数据质量**：是否有心律、基线漂移、导联质量、测量频率（100 Hz）等因素影响判断？

## 4. 重要限制

- 这些标签来自PTB-XL数据集，不是本次请专家重新判读后的金标准。
- 模型分数是内部排序分数，不是经过临床校准的疾病概率。
- 单张图不能替代完整病史、既往心电图、超声、实验室检查或正式心电图报告。
- “低电压HYP”“标签-波形不一致”“救援误触发”等是复核用的工作分类，不是对病例原因的最终诊断。
- 这份材料先用于发现数据标注和模型行为的问题，不直接用于临床决策。

## 5. 文件说明

- `assets/01_class_error_counts.png` 至 `04_rescue_rule_outcome.png`：总体统计图。
- `assets/case_*_waveform.png`：6个关键病例的12导联原始波形图。
- `data/key_cases.csv`：关键病例的标签、预测、分数和专家问题。
- `data/full_error_samples.csv`：全部816条错误样本的索引、标签、分数与分类标签。
- `data/tag_dictionary.md`：错误标签的定义。

如需查看某一病例的原始数值信号，可根据 `data/full_error_samples.csv` 中的 `raw_data_path` 回到原始PTB-XL文件；本包中的图已足够完成第一轮医学复核。
"""
    (packet / "RecursiveECG_medical_expert_review.md").write_text(md, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", type=Path, required=True)
    ap.add_argument("--audit-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--zip-out", type=Path, required=True)
    args = ap.parse_args()

    ws = args.workspace
    audit = args.audit_dir
    packet = args.out_dir
    if packet.exists():
        shutil.rmtree(packet)
    (packet / "assets").mkdir(parents=True)
    (packet / "data").mkdir(parents=True)
    font = choose_font()
    if font:
        matplotlib.rcParams["font.family"] = "sans-serif"
        matplotlib.rcParams["font.sans-serif"] = ["Noto Sans CJK SC"]
        matplotlib.rcParams["axes.unicode_minus"] = False

    run = "audit_final_20260821"
    error_df = pd.read_csv(audit / f"{run}_error_samples.csv")
    full_scores = pd.read_csv(ws / "data/processed/predictions" / f"{run}_test_scores.csv")
    full_preds = pd.read_csv(ws / "data/processed/predictions" / f"{run}_test_predictions.csv")
    full_scores = full_scores.merge(full_preds, on="ecg_id")
    labels = pd.read_csv(ws / "data/processed/exploration/superclass_labels.csv").set_index("ecg_id")
    metrics = json.loads((audit / f"{run}_metrics.json").read_text(encoding="utf-8"))
    raw = np.load(audit / f"{run}_error_samples_raw.npz")

    plot_class_errors(full_scores, labels, packet / "assets")
    plot_label_counts(full_scores, labels, packet / "assets")
    plot_transitions(error_df, packet / "assets")
    plot_rescue(error_df, packet / "assets")
    for case_id in CASE_INFO:
        plot_case(case_id, error_df, raw, packet / "assets")

    key_rows = []
    for case_id, info in CASE_INFO.items():
        row = error_df.loc[error_df.ecg_id == case_id].iloc[0]
        key_rows.append({
            "ecg_id": case_id,
            "title": info["title"],
            "dataset_labels": label_text(row, "gt"),
            "model_prediction": label_text(row, "pred"),
            "scores": ", ".join(f"{c}={row[f'score_{c}']:.3f}" for c in CLASSES),
            "summary": info["summary"],
            "expert_question": info["question"],
            "waveform": f"assets/case_{case_id}_waveform.png",
            "raw_data_path": row["raw_data_path"],
        })
    pd.DataFrame(key_rows).to_csv(packet / "data/key_cases.csv", index=False)
    shutil.copy2(audit / f"{run}_error_samples.csv", packet / "data/full_error_samples.csv")
    shutil.copy2(audit / f"{run}_tag_dictionary.md", packet / "data/tag_dictionary.md")
    build_markdown(packet, error_df, metrics, labels)

    if args.zip_out.exists():
        args.zip_out.unlink()
    with zipfile.ZipFile(args.zip_out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(packet.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(packet.parent))
    print(f"[expert-packet] wrote {args.zip_out} ({args.zip_out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
