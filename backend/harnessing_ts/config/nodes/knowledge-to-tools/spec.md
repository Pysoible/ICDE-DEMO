phase: setup
next: iterative-solving
purpose: 根据问题契约、数据规范、参考资料目录以及已就绪的知识查询能力，生成并通过后端校验的确定性参考特征提取器。校验通过后，`tools/reference-feature-extractor/**` 才能被迭代求解节点的案例复盘视为可用数值证据来源。

requires:
- user/problem-contract.md
- user/data-spec.md
- references/**

produces:
- tools/reference-feature-extractor/**
- tools/reference-feature-extractor/evidence-map.json
- tools/reference-feature-extractor/feature-plan.json
- tools/reference-feature-extractor/evaluation-report.json
- state/reference-feature-build.json
