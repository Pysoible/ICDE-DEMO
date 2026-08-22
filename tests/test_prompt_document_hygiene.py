from __future__ import annotations

from pathlib import Path

from harnessing_ts.config.markdown import node_document


REPO_ROOT = Path(__file__).resolve().parents[1]
TEXT_ROOTS = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "AGENT.md",
    REPO_ROOT / "docs",
    REPO_ROOT / "backend" / "harnessing_ts" / "config",
]

FORBIDDEN_RUNTIME_RESIDUES = [
    "after cleanup",
    "re-enter the workspace",
    "restart the harness runner",
    "next `node_entered",
    "should be written to `logs/main.jsonl`",
    "should be written to logs/main.jsonl",
]


def _iter_text_files() -> list[Path]:
    files: list[Path] = []
    for root in TEXT_ROOTS:
        if root.is_file():
            files.append(root)
            continue
        files.extend(
            path
            for path in root.rglob("*")
            if path.is_file() and path.suffix in {".md", ".txt", ".yaml", ".yml"}
        )
    return sorted(files)


def test_docs_and_prompts_do_not_contain_runtime_residue() -> None:
    offenders: list[str] = []
    for path in _iter_text_files():
        text = path.read_text(encoding="utf-8").lower()
        for phrase in FORBIDDEN_RUNTIME_RESIDUES:
            if phrase in text:
                offenders.append(f"{path.relative_to(REPO_ROOT)}: {phrase}")

    assert offenders == []


def test_common_node_rules_allow_subagents_only_when_node_contract_exposes_them() -> None:
    common_rules = (
        REPO_ROOT
        / "backend"
        / "harnessing_ts"
        / "config"
        / "prompts"
        / "node"
        / "execution-rules.md"
    ).read_text(encoding="utf-8")

    assert "`Task`" not in common_rules
    assert "只有 native-tool 清单出现 `subagent` / `subagent_fork` 时才可委派" in common_rules


def test_common_node_rules_allow_only_native_and_injected_harness_tools() -> None:
    common_rules = (
        REPO_ROOT
        / "backend"
        / "harnessing_ts"
        / "config"
        / "prompts"
        / "node"
        / "execution-rules.md"
    ).read_text(encoding="utf-8")

    assert "只能使用本 node 的 native DSH tools，以及系统明确注入的 Harness MCP 工具" in common_rules


def test_shared_prompt_contains_universal_reliability_rules() -> None:
    role_kernel = (
        REPO_ROOT
        / "backend"
        / "harnessing_ts"
        / "config"
        / "prompts"
        / "shared"
        / "role-kernel.md"
    ).read_text(encoding="utf-8")

    for phrase in (
        "检查当前任务的输入文件、输出文件、Schema、可用工具和验证方式",
        "只能调用当前实际注入且明确可用的工具",
        "先用少量真实输入做 smoke test",
        "大型 JSON、日志和图片不得直接输出到对话",
        "validator 报错时必须修复具体错误",
        "候选筛选、模型选择、方案组合、阈值和停止判断必须与该目标一致",
        "必须用相同输入做对照验证，确认关键输出和评测结果与候选一致",
    ):
        assert phrase in role_kernel


def test_node_specs_match_mandatory_output_contracts() -> None:
    problem_outputs = node_document("problem-contract")["produces"]
    iterative_outputs = node_document("iterative-solving")["produces"]
    knowledge_outputs = node_document("knowledge-to-tools")["produces"]

    assert "knowledge_base/domain-brief.md" not in problem_outputs
    assert problem_outputs == ["user/problem-contract.md", "user/data-spec.md"]
    assert "reports/iterations/<iteration-id>-candidate-review.md" in iterative_outputs
    assert knowledge_outputs
    assert "tools/reference-feature-extractor/**" in knowledge_outputs
    assert "tools/reference-feature-extractor/evidence-map.json" in knowledge_outputs
    assert "tools/reference-feature-extractor/feature-plan.json" in knowledge_outputs
    assert "tools/reference-feature-extractor/evaluation-report.json" in knowledge_outputs
    assert "state/reference-feature-build.json" in knowledge_outputs


def test_node_chain_orders_problem_to_knowledge_to_tools_to_solving_to_summary() -> None:
    from harnessing_ts.config.markdown import node_documents

    chain = [(item["type"], item["next"]) for item in node_documents()]
    assert chain == [
        ("problem-contract", "knowledge-to-tools"),
        ("knowledge-to-tools", "iterative-solving"),
        ("iterative-solving", "final-summary"),
        ("final-summary", None),
    ]


def test_main_prompt_gates_knowledge_query_by_source_and_readiness() -> None:
    role = (
        REPO_ROOT
        / "backend"
        / "harnessing_ts"
        / "config"
        / "prompts"
        / "main"
        / "role.md"
    ).read_text(encoding="utf-8")

    assert "`knowledgeQueryReady` 为 true" in role
    assert "`knowledgeQuerySource` 为 `graph`" in role
    assert "`knowledgeQuerySource` 为 `references`" in role
    assert "`knowledgeQuerySource` 为 `extractor_source`" in role


def test_final_summary_prompt_does_not_request_impossible_failure_reroute() -> None:
    guidance = node_document("final-summary")["guidance"]

    assert "routing inconsistency" not in guidance
    assert "要求回到 `iterative-solving`" not in guidance


def test_knowledge_to_tools_requires_real_sample_validation() -> None:
    guidance = node_document("knowledge-to-tools")["guidance"]
    assert "真实样本" in guidance
    assert "合成样本只能作为补充" in guidance
    assert "evaluation-report.json" in guidance
    assert "evidence-map.json" in guidance
    assert "feature-plan.json" in guidance
    assert "test-cases.json" in guidance
    assert "source" in guidance
    assert "referencePath` **只能**是存在的 `references/**`" in guidance
    assert "{runTests: false}" in guidance
    assert "由后端校验工具写入" in guidance


def test_iterative_case_review_visualization_contract_is_explicit() -> None:
    guidance = node_document("iterative-solving")["guidance"]

    assert "先对完整的可评估样本集合做一次批量汇总" in guidance
    assert "不得对未入选样本逐一执行深度检查" in guidance
    assert "不得反复重试或阻塞整个 case review" in guidance
    assert "一次有界的降级尝试" in guidance
    assert "继续使用原始数值证据完成分析和报告" in guidance
    assert "runs/iterations/<iteration-id>/case-review/visualizations/" in guidance
    assert "所有选定 bad case 的逐样本分析和上述统计综合完成后执行" in guidance
    assert "撰写绘图代码" in guidance
    assert "按 `user/data-spec.md` 读取" in guidance
    assert "`summary_` 前缀" in guidance
    assert "保存为 PNG" in guidance
    assert guidance.count("120–150 DPI") >= 2
    assert "250 DPI" not in guidance
    assert "1600×900" in guidance
    assert "宽高比必须为 16:9" in guidance
    assert "蓝、橙、绿、红" in guidance


def test_node_prompts_restrict_cross_workspace_process_killing() -> None:
    execution_rules = (
        REPO_ROOT
        / "backend"
        / "harnessing_ts"
        / "config"
        / "prompts"
        / "node"
        / "execution-rules.md"
    ).read_text(encoding="utf-8")
    guidance = node_document("iterative-solving")["guidance"]

    for text in (execution_rules, guidance):
        assert "当前 workspace" in text
        assert "pkill" in text
        assert "killall" in text
        assert "kill -9" in text
        assert "PID" in text
    assert "归属不明确" in execution_rules
    assert "无法确认时不要 kill" in guidance


def test_chain_summary_prompts_are_markdown_backed() -> None:
    chain_summary_source = (
        REPO_ROOT / "backend" / "harnessing_ts" / "chain_summary.py"
    ).read_text(encoding="utf-8")
    prompt_root = (
        REPO_ROOT / "backend" / "harnessing_ts" / "config" / "prompts" / "chain-summary"
    )

    assert "CHAIN_SYSTEM_PROMPT" not in chain_summary_source
    assert "CHAIN_REPAIR_SYSTEM_PROMPT" not in chain_summary_source
    assert "请生成 HarnessingTS 当前 workspace 的思维链总结" not in chain_summary_source
    assert {
        "system.md",
        "schema.md",
        "generate.md",
        "repair-system.md",
        "repair.md",
    } <= {path.name for path in prompt_root.glob("*.md")}
