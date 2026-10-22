# AGENT 维护规范

- `patient_context.py` is a bounded bilingual local-negation parser, NOT medical triage. The guide and task-investigation route must share `needs_urgent_guidance`; uncertain or mixed urgent mentions remain conservative. Never globally strip negative keywords. Symptom summaries retain exact user-only excerpts and turn provenance, never infer absence from silence. `patientContext.report` is computed from the actual published revision/labels, not user recollection/GT/scores. Model optional `followUpQuestion` is a question TO the patient, separate from `nextQuestion` and the system `reviewQuestion`; prepare-mode personal context requires one with a bounded rewrite. UI renders actual self-report and report facts separately, and the reply button only prepares editable input. Test mixed scopes, negated lists, double negation, English/Chinese, report conflicts, two-turn changes, legacy fields, task routes and unchanged storage. Lexical/prompt tests do not prove general medical correctness.

- 患者回答的 `contextUpdates` 可选且最多三项；quote 必须精确匹配当前问题或实际传给模型的 user 历史中的单条消息，不能引用 report/assistant，也不允许重复。focus 仅解释本次回答重点，不代表诊断/阈值/治疗变化；模型文字不等于因果证明。任务模式仅允许当前 question，旧字段缺失保持兼容。`patient_response.ts` 展示该反馈和真实已完成的材料检查，禁止假进度或虚构检查。仅删除生成文本中的独立模板身份声明，保留具体不确定性、急症行动和药物禁忌，不改已存报告/核查记录。测试两条回答入口、引文校验/注入转义、旧响应、版本隔离、双语及多视口。

本文面向维护本仓库的 coding agent。README.md 面向人类使用者，负责安装、启动、UI 使用和常见错误；AGENT.md 负责工程边界、实现约束、验证要求和文档同步规则。修改时不要把两者混成同一份文档。

## 文档职责

- README.md：人类用户文档。应说明 prerequisites、安装、启动命令、LLM 配置、变体选择、UI 使用、部署和排错。避免放入内部代码边界、commit 纪律、实现细节。
- AGENT.md：维护 agent 文档。应说明代码所有权边界、不可破坏的系统契约、变体硬约束、测试/验证要求、禁止提交内容。
- docs/：更长的架构设计说明。README 只链接或摘要用户需要知道的内容；AGENT 只记录维护时必须遵守的规则。

任何影响命令、环境变量、变体、节点协议、运行产物、API payload、UI 操作、MCP 工具、prompt 或维护流程的改动，都必须同时检查 README.md、AGENT.md、docs/ 和相关 `backend/harnessing_ts/config/` 文档。提交前运行：

```bash
git diff -- README.md AGENT.md docs/ backend/harnessing_ts/config/
```

## 当前系统事实

- Patient 的“报告提示”在已发布报告标题下直接可见，只读取 `publishedReport.labels`；代码及本地化名称不能混入 sample truth/prediction、草稿或待批准结果。点击标签仅准备可编辑问题，不自动调用模型；空标签明确显示未附标签。标签不是患者自述症状或确诊疾病，专业测量仍可折叠。

HarnessingTS 是基于官方 Python DeepSeek Harness SDK 的时间序列 tool-use harness。前端是 `frontend/` 的静态 UI，由 FastAPI 服务托管。Python SDK 通过 JSON-RPC 显式启动 `backend/dsh_runtime/` 中 package-locked 的 Node/Cordis 运行时；运行时状态和 DSH session persistence 位于用户指定的 `TS_HARNESS_WORKSPACE`，不是源码仓库。

标准启动入口：

```bash
uv run ts-harness setup-server
HOST=0.0.0.0 PORT=4327 TS_HARNESS_WORKSPACE=/srv/harnessingts/workspaces/nod-kgr-ktl-crv-sub-ada TS_HARNESS_VARIANT=NOD-KGR-KTL-CRV-SUB-ADA TS_HARNESS_CONTROL_MODE=auto uv run ts-harness-server
```

辅助命令：

```bash
uv run ts-harness variants
uv run ts-harness variants --json
uv run ts-harness llm-config
uv run ts-harness --dry-run init
uv run ts-harness --dry-run start-node problem-contract --input-summary "..."
uv run ts-harness --dry-run finish-node --summary "..." --goal-met true --output-path user/problem-contract.md --output-path user/data-spec.md
```

启动配置错误必须 fail fast，禁止静默回退：

- `PORT` 必须是 1-65535 的整数。
- `TS_HARNESS_CONTROL_MODE` 必须是 `auto` 或 `manual`。
- `TS_HARNESS_VARIANT` 必须是合法且已注册的功能码组合。
- 变体错误应提示 `uv run ts-harness variants` 或打印等价 catalog。

## 代码边界

维护时优先保持现有模块边界：

- `backend/harnessing_ts/server.py`：FastAPI app factory、路由注册、后台任务、静态前端托管、启动配置校验。不要在这里新增业务规则。
- `backend/harnessing_ts/api/payloads.py`：`/api/bootstrap` 和 `/api/live` 聚合 payload。
- `backend/harnessing_ts/orchestrator.py`：应用 facade，协调 workspace store、main/node sessions、knowledge services、runner 生命周期和高层能力禁用。
- `backend/harnessing_ts/node_state.py`：node chain 路由、`finish_node` 结构校验、pipeline completion、variant-aware output path 约束。
- `backend/harnessing_ts/variants/profiles.py`：功能码、兼容别名、canonicalization、profile registry、capabilities、node overrides、variant help/catalog 的单一事实源。
- `backend/harnessing_ts/variants/prompts/`：非默认 profile 的 prompt overlay。完整 profile `NOD-KGR-KTL-CRV-SUB-ADA` 不依赖 overlay。
- `backend/harnessing_ts/tools/compose_tools.py`：main/node allowed tools 和 native tools 的 variant-aware 组装。
- `backend/harnessing_ts/agent/session_factory.py`：DeepSeek Harness runner 构造、prompt、MCP bridge、allowed tools、LLM invocation config。
- `backend/harnessing_ts/mcp/server.py`：DSH stdio MCP bridge 和 callback 绑定。Web-server 路径通过 loopback-only `/internal/dsh/mcp` 回调当前 orchestrator，只暴露已由当前 variant 允许的 callback。
- `backend/dsh_runtime/`：锁定 DSH JSON-RPC runtime、MCP、文件系统、Web 与子智能体插件；`setup-server` 会执行 `npm ci` 并校验入口文件。
- `backend/harnessing_ts/state/`：workspace 文件/JSON/JSONL repository 和布局。
- `backend/harnessing_ts/knowledge_graph.py` / `knowledge_prompts.py`：知识图谱构建、检索和 direct reference QA。
- `backend/harnessing_ts/reference_feature_extractor.py`：reference feature extractor 的强校验、执行和 inspection。
- `frontend/src/main.ts`：当前主要 UI 渲染和事件绑定入口。
- `frontend/src/types.ts`：frontend DTO 类型。
- `backend/harnessing_ts/expert_collaboration.py`：ICDE 专家协作的受限检查规划、结构化建议和真实文本差异。模型提示词位于 `config/prompts/expert-collaboration/`；`demo_interactions.py` 负责路由、工具执行及版本化保存。
- 专家 JSON 请求对官方 `api.deepseek.com` 显式使用 `thinking.type=disabled` 和 8192 输出 token，避免默认推理耗尽输出预算；不要将供应商专有参数发给其他兼容接口。必须检查 `finish_reason=length` 和空正文，返回安全、可区分、可本地化的失败提示；不得解析截断内容为成功回合。原凭据、报告、预测及节点会话保持独立。
- 专家建议、接受决定和发布报告是独立操作。不得自动选择诊断标签、覆盖预测、修改工具或将建议当成临床结论。跨模型调用须重检 context 和报告版本；协作历史单独计版本，保留既有报告/病人反馈。受 no-KTL/no-CRV/CXR 能力约束。

新增行为应落在已有边界内。不要把 node 路由规则重新写回 `orchestrator.py`，不要把 workspace layout 细节塞进 `WorkspaceStore` 主体，不要把 API 聚合 payload 散落在路由函数里。消融行为必须通过 capabilities、工具注入和后端契约强制实施，不能只靠 prompt 声明。

## 变体系统

`TS_HARNESS_VARIANT` 只在进程启动时解析。运行时不得新增 variant switch API。旧 `V0`-`V6` 仅作为兼容别名，状态、timeline、API 和 UI 应显示 canonical ID。

功能码：

- `NOD`：HarnessingTS node chain。
- `KGR`：文件型 reference knowledge graph 和 graph-backed `query_knowledge`。
- `RQA`：direct reference QA agent，直接基于 `references/**` 回答；与 `KGR` 互斥。
- `FQA`：基于生成的 `tools/reference-feature-extractor/**` 源码和规则的 QA；与 `KGR`、`RQA` 互斥。
- `KTL`：`knowledge-to-tools` node 和 validated reference feature extractor。
- `CRV`：case review、bad/good-case attribution、case visualization。
- `CXR`：保留 case review，但禁止执行 reference feature extractor；需要 `KTL`，且与 `CRV` 互斥。
- `SUB`：通过 DSH `subagent` / `subagent_fork` 执行独立候选测试与审查。
- `ADA`：adaptive iterative solving 和停止决策。
- `DIR`：普通单 agent baseline；不能与其他 code 组合。

已注册 profile：

- `NOD-KGR-KTL-CRV-SUB-ADA`（旧 `V0`）：完整版本。
- `NOD-RQA-KTL-CRV-SUB-ADA`（旧 `V1`）：无 knowledge graph，保留 direct reference QA、KTL、CRV、SUB、ADA。
- `NOD-RQA-KTL-SUB-ADA`（旧 `V2`）：在 direct reference QA 基础上禁用 CRV。
- `NOD-RQA-CRV-SUB-ADA`（旧 `V3`）：在 direct reference QA 基础上禁用 KTL。
- `NOD-RQA-SUB-ADA`（旧 `V4`）：在 direct reference QA 基础上同时禁用 CRV 和 KTL。
- `DIR`（旧 `V5`）：普通单 agent tool-use baseline。
- `NOD-FQA-KTL-CXR-SUB-ADA`（旧 `V6`）：构建 extractor，但下游仅将其源码/规则作为 QA 材料，禁止执行 extractor。

硬约束：

- “消融”表示禁止使用，不是“不要求使用”。
- 无 `NOD` 的 `DIR` 不得创建/进入 node session，不得暴露 node-control MCP。
- 无 `KGR` 不得构建/读取 knowledge graph；图谱 API payload 应为空或拒绝。
- `RQA` profiles 的 `query_knowledge` 必须走 direct reference QA，不得读取 graph tables。
- 无 `KTL` 不得进入 `knowledge-to-tools`，不得注入 validate/extract/inspect reference feature MCP，不得返回 extractor tool metadata，不得运行 extractor。
- 无 `CRV` 时，`finish_node` 必须拒绝 case-review output path；prompt overlay 也要禁止 case-review、bad/good-case attribution 和 visualization。
- `CXR` 仍保留 case review，但不得暴露或执行 reference feature extractor。
- 无 `SUB` 时，iterative-solving native tools 中不得包含 DSH 子智能体工具。

## Node Chain 契约

完整 profile 的 baseline chain：

```text
problem-contract
→ knowledge-to-tools
→ iterative-solving
→ final-summary
```

主要契约：

- 所有 node 流转必须走 MCP `mcp__ts_harness__enter_node` / `mcp__ts_harness__finish_node`，不得用 JSON 文本块或 `harnessControl.action` 替代。
- `knowledge-to-tools` 由当前 node/main SDK session 生成 `tools/reference-feature-extractor/**`，后端只做强校验、deterministic executor 和 evidence 检查。
- `iterative-solving` 成功完成必须包含 candidate review、case review（除非无 `CRV`）、iteration summary 和 `user/iteration-state.md`。
- `loopDecision=continue` 必须路由到 `iterative-solving`；`loopDecision=exit` 必须路由到 `final-summary`。
- `user/iteration-state.md` 的 `recommend_exit` 不是控制源，但不得与 structured MCP `loopDecision` 矛盾。
- `final-summary` 只在迭代结束后进入。

Node prompt 和 native tools 约束：

- 每个 node 只能调用其 native-tool 清单中列出的 DSH 工具和明确注入的 Harness MCP 工具；`SUB` 才可使用 DSH 子智能体工具。
- `native-tools.md` 是声明性候选清单；`web_fetch` / `web_search` 还必须由部署环境显式启用，`SUB` 工具还受 variant 过滤。不得假设清单中的工具一定在本次 DSH session 的 schema 中。
- 节点应把 `data/raw/**` 视为只读；派生数据写入 `data/processed/**`。
- 节点不应读取 `backend/**`、`frontend/**`、`state/**`、`_reference_project/**`；`final-summary` 可读取 `logs/timeline.jsonl`。
- domain knowledge 应通过 `mcp__ts_harness__query_knowledge` 获取，不应直接读 `knowledge_base/tables/*.csv`、`knowledge_base/indexes/**`、`knowledge_base/cache/**`。
- 长时间 Bash 命令应使用 `timeout` 或当前 run 目录 PID/日志；禁止按名称或全局范围使用 `pkill`、`killall`、`pgrep | kill`、批量杀 Python/uv/训练进程或全局 `kill -9`。

## DSH Session And MCP Boundary

- `_reference_only/deepseek-harness/` 是官方 DeepSeek Harness 源码的“供参考”副本；对 DSH 实现细节有疑问时可在此查阅。它不是本项目的构建或运行依赖，不得替代已安装的 DSH SDK 或 `backend/dsh_runtime/`。
- main/node 每个逻辑 actor 必须持有稳定 DSH session ID；每个 turn 使用新 runtime 进程并通过 `ctx.agents.resume()` 恢复，禁止用同 ID 调用 `agents.create()` 伪装恢复。
- 正常暂停顺序固定为 `cancel → whenIdle → drainContinuableDescendants → sessions.flush → paused → shutdown`，不得用 HTTP MCP 响应完成代替 DSH checkpoint；DSH 确认的 checkpoint sequence 必须同步写入 execution state 和暂停 timeline。恢复 node 时必须清除活动 `pausedAt`，历史暂停时间只保留在 timeline。
- 同一 runner 的正常 checkpoint、pause 和 force-stop recovery 必须具有唯一 settlement owner；关闭 runtime 时必须校验 expected runtime，禁止旧 turn 清理关闭后继 runtime。force-stop 必须等待旧 pause task 退休后才能创建恢复 runtime。
- 正常暂停没有自动超时；强制停止只能由用户在 `pausing` 状态二次确认。后续必须恢复同一 session，让 DSH 修复未知工具结果，不得自动重放工具副作用。
- actor session ID 只能在 DSH 接受 `session/open` 后提交。进程在 identity reservation 与日志创建之间崩溃时，只能先 resume，并且仅在 DSH 明确返回 session not found 时创建同一 identity；不得吞掉损坏或 I/O 错误。
- DSH MCP bridge 的 capability 必须按 workspace、role、node session、epoch、lease 和 allowed tools 绑定，并在 checkpoint 后撤销。
- 对 node 绑定的 MCP 调用，开始时必须校验 capability、active-node lock 和 `running` 状态；任何跨 `await` 的结果在发布前必须再次校验，避免暂停后的迟到结果写入状态或送入下一轮。
- `DSH_MCP_CONTROL_URL`、`DSH_MCP_CAPABILITY` 只能由 orchestrator 生成并通过 Cordis 显式传给 MCP 子进程。不得改为 `TS_HARNESS_*` 或非敏感名称，不能写入 prompt、API payload、工作区文件或日志。

## 前端契约

- Demo 指标呈现限定为当前病例与 tuning：主结果卡/候选尝试/变化列表/病例 badge/专家报告摘要/预设场景均不展示 holdout 或混合全量汇总；不把 holdout 改称 tuning，不改历史数值或后台划分。变化计数取 `subsets.tuning.changed`，列表只显示 `set==='tuning'`；调整集负面结果仍显示。保持“仅展示调整集结果，不代表独立泛化验证”范围说明。维护用含冲突 tuning/holdout 数值的 fixture 验证来源和历史不变性。

- `/demo?scenario=positive` 是独立预设交互演示，入口在 `icde_demo.ts`、界面在 `positive_demo.ts/.css`、模拟计算在 `positive_demo_data.ts`。始终显示模拟标记，全部使用 SIM 编号；不调用模型/真实数据 API、不写真实历史、不生成/发布真实报告、不覆盖实测指标。调整/留出仅为模拟分组，必须从完整模拟记录逐条计算计数与 F1，不伪装成 PTB-XL 实验。任意预设均不可导入真实报告。维护覆盖计数计算、组间 ID 不重叠、空值与输入不变性，检查双语及桌面/窄屏；真实 /demo 路径和轮询仍用原逻辑。

- 患者回答可包含可选 `symptoms/dailyCare/medication` 一般健康教育，不是病例证据；只从已发布类别提供独立的 generalEducation 定义，不把一般症状写成患者已有症状。保留过滤科研比较后的报告全文和测量供模型理解，不能再按技术关键词删除整句；通俗化在输出层完成。`limitation` 可为空，不强迫模型填免责段落，`basis` 在回执内折叠。禁止基于标签开药、停药、改量、给运动许可；具体药物可讲用途/常见注意事项。剂量词法检查只是窄防护，不保证临床正确。急症分支优先，仅明确独立的术语解释问题豁免关键词急症分支。覆盖两条回答入口、兼容接口、历史字段缺失、双语/移动端及真实模型的休息/药物/症状/处方请求；不重写线上报告或任务。

- 所有 Demo 患者回答使用 `patient_guide.patient_prose` 统一过滤旧报告、附件警告、旧助手历史与 clarification 中的科研比较句；仅模型投影过滤，绝不改存储原文。`/question` 兼容层转同一 guide，继承报告/context 的跨 await 校验，不再向患者模型提供 sample.predicted。根工作台的 QA 不在本次修改范围。新增可选 `basis` 分开直接回答和材料依据，历史响应无此字段仍可渲染；核查 follow-up 只接收真实已记录 checks，不虚构波形/规则/测量验证。明显科研比较输出须拒绝，提示词/词匹配不保证所有自然语言正确。下一问按钮只准备可编辑草稿，不自动调用。维护时覆盖普通入口、任务入口、旧聊天历史污染、兼容入口、空附件与不可评估，实测真实模型不同问题及双语布局；测试写入必须隔离。

- 患者主线是 Agent 核查、即时发现、局限与版本变化，不是医生问诊转接。初始核查无需提交或专家答复即可解释；可选保留的是系统证据核查目标。专家 UI 不渲染起草/编辑/发布患者答复，改为关联真实分析工作；`complete-review` 在锁内核验接手时基线 ID、时间、context、实际 work ID/类型和当前出版版本，不修改报告，状态仅为 reviewed，unresolved 恒 true，不声称临床解决。工作关联是专家声明，不是因果证明。旧 answer-draft/resolve 接口仅兼容旧客户端/历史，不作为新主线。
- `public_tasks` 只读投影当前已发布与原始快照的标签/正文/附件变化，不依赖专家回复，不增加版本。`recheck` 保留原始疑问和核查，最多十次，每个 publishedRevision/reviewOutcomeId 只执行一次；每次 await 重检 context/任务/出版版本。新 Agent 任务的 understand 可直接使用当前核查与出版对比；旧解释不应用于新版本，不读取未发布专业工作，不把 unchanged、新报告或 recorded work 当作已解决。语言重绘/轮询无模型调用。维护需包含无专家参与、附件单独变化、无变化、旧工作拒绝、过期/失败不落盘的测试。

- 新患者闭环在 `patient_tasks.py`、`patient_tasks.ts/.css/_zh.ts`，提示词 `patient-task-next.md`。`patientTasks` 独立 revision，prepared/submitted/in_review/answered 必须由真实操作触发，不可用计时动画模拟。Agent 最多三项不同的只读 published snapshot 检查、四次模型调用、总 150 秒；每次 await 后重检 context、已发布版本和任务版本，失败不存成功任务。附件清单不证明标签正确性，数值存在不等于可临床解释，不将 GT/概率/未发布专家信息交给患者模型。任务/原报告/旧反馈均保留，最多 30 项，不自动删除。旧 feedback 队列仍仅存请求，新任务使用显式确认/接手/草稿/审核发布接口。
- 兼容的历史任务答复仅依据当前已发布报告生成；草稿不进入患者 context，生成与发布分开，服务端核验 task revision、draft ID、已发布报告版本和 approved，发布答复不修改报告。旧答复起草与专家编辑如实记录为演示审核，不称临床验证；只有与当前报告版本一致的旧答复可进入后续问答。新 Agent 任务不需要这类答复，走上文即时发现与重新核查路径。前端任务草稿按 context/任务/实际工作选项/报告版本隔离，切换语言不调用模型，正文与输入独立滚动，实际状态由只读刷新同步。测试使用隔离 workspace 的真实 state 路径，新增 save_patient_task 也必须隔离；运行 test_patient_tasks.py、patient_tasks.test.ts、既有回归和双语多视口检查。

- 患者理解伙伴位于 `patient_companion.ts/.css`，后端 `patient_guide.py`，提示词 `expert-collaboration/patient-guide.md`；`POST .../understand` 支持 explain/evidence/uncertainty/prepare/teachback，沿用旧 question API 不破坏兼容。主界面围绕普通用户的困惑、理解核对与沟通准备，原始术语/测量默认折叠，不要求患者解释 QRS。理解一致仅指与已发布报告表述一致，不是诊断、医学正确性或能力评分。模型引用只能是当前已发布 report/measurement/change ID，且明确不等于逐句核实的引用；未发布意见、候选、弱真值/概率/队列不得进入理解模型。模型 await 后重检 context 与已发布版本，迟到解释不能覆盖新报告；客户端也核验版本。清单/标记属单报告的临时会话状态，PatientViewState 同步保留折叠和独立滚动，语言切换不调用模型。清单最多六项、每项不超过 140 字符，整理后仍须编辑并显式发出澄清请求；队列没有回复服务。测试跑 test_patient_guide.py、patient_companion.test.ts、现有专家/患者回归、类型检查与双语四视口。真实写入测试必须隔离五个 storage 函数和 feedback 路由直接写入的 state/icde-demo 路径，不得只 monkeypatch save_* 后向线上发送测试请求。解释不等于临床建议，模型提示词/结构校验不保证所有自然语言事实正确。

- 专家反馈的真实条件明细和对照证据在 `revision_evidence.py` / `revision_story.ts`。对照只用调整集且排除当前患者；完整计数不能依赖截断 flips；按编号选择变化证据、按归一化数值距离选未变化边界例，不得称临床相似检索。模型每次执行观察及后续同输入历史可含这些调整集例证，禁止转交留出病例。无推荐时可展示最后检验项但明确不能采纳。只读 evidence API 核验 context/报告/revision/输入指纹；不得改历史。缓存按 context/item 隔离，epoch 拒绝迟到响应；失败单独重试，不误报已保存意见失败。`feedback_view_state.ts` 保留同一病例/历史项的栏滚动与折叠，跨项重置。报告文字 diff 只在专家端逐段比较真实已发布正文和草稿，不编造因果。维护需跑 `test_revision_evidence.py`、`revision_story.test.ts`、`feedback_view_state.test.ts` 和原闭环测试，并实测双语四视口。

- 报告页重绘前由 `report_view_state.ts` 同步捕获当前 DOM 的稳定折叠键和 `.report-scroll` / `.review-side` 滚动位置，重绘后先恢复折叠再恢复滚动；不得用标签数量覆盖已手动选择的展开状态，也不得用旧 DOM 的异步 toggle 回写状态。快照仅属当前 context 的临时视图状态，跨病例/来源 context 重置；不得改变审核失效、报告生成或发布契约。维护时运行 `frontend/tests/report_view_state.test.ts` 并实测连续多选/取消、手动收起/展开和双语切换。

- 患者报告由 `patient_report.py` 根据显式选定类别和实测附件生成，提示词位于 `config/prompts/expert-collaboration/patient-report.md`。不要把旧专家笔记改称系统生成；历史报告保留原文与来源。`POST .../patient-report` 只保存独立 `patientReportDrafts`，不得增加报告版本或发布。模型输入不含弱真值、概率、跨病例指标、原始专家推理；正文禁止引入数字测量与未选类别，数值仅由证据卡显示。所有解释仍须人工审核，提示词不是临床正确性的保证。
- 生成/重写后、正文/类别/附件/修改要求变化后，审核状态失效。发布须显式 `patientReportId` 和 `reportApproved`（旧手写报告 API 保持兼容）；服务端在记录锁内核验生成来源与当前报告输入并记录系统生成/专家编辑/演示审核来源。模型 await 后重检 context、报告、生成、revision 与 collaboration 版本及关联 revision 数据指纹；任何冲突不覆盖原稿。患者 UI/Q&A 仅用已发布正文、附件及精简的本病例前后类别，不发送完整专家意见/候选/评估统计；这些仍保留在专家快照。新报告页桌面滚动正文与侧栏、固定审核栏，窄屏正常滚动。须跑 `test_patient_report.py`、既有闭环测试、前端 `patient_report_view.test.ts`、类型检查及双语多视口验证。真实模型测试必须同时隔离 `save_patient_report` 与所有已有记录读写入口。

- 默认专家反馈页必须只渲染一个工作台，禁止把 revisionHtml 与另一个 100% 高度网格上下堆叠。桌面栏体 min-height:0 并独立滚动，输入/确认操作固定在栏内；窄屏/矮屏保留文档滚动。历史卡片必须选择对应结果，不能只高亮而继续显示最新结果。切换语言保留意见草稿、选中报告、所有栏体滚动和进行中的请求。
- 修订历史通过 parentId 连续反馈，只把调整集数字传回 Agent，不转交留出指标；每轮相对原始基线，不隐式叠加。所有 revision 保存路径、真实模型/UI 测试必须隔离 save_revision 以及 read_record/save_review/save_collaboration。缓存命中前检查内容指纹（提取器/特征表/概率/指标/元数据），加载后重检；跨模型调用、采纳、报告关联时重新验证指纹。来源过期返回冲突并保留输入，不得静默使用旧表。报告快照在存储锁内从服务端已采纳项构建，禁止客户端伪造影响数据。测试 stage 必须 -c /dev/null 以免父项目 pytest pythonpath 指向线上源码；确认 import 的 __file__ 后再报告验证通过。

- QRS 来源核查可读取有大小/行数上限的实际 extractor 字段映射代码，保留文件/行号，禁止为别的 extractor 硬编码假映射。回放再评估须携带权威当前病例行；仍须专家判断，不保证模型措辞完全无误。数值 input 事件必须立刻隐藏旧再评估，不可等 blur 或完整重绘后才失效。

- 专家主动核查位于 `agent_investigation.py`，模型提示词 `investigate-next.md` / `assess-replay.md`。仅用户委托的只读工具核查：最多三次，禁止相同 action/focus 重复，总超时 150 秒。后续决策必须消费真实观察；真实行动记录不是私有思维链。模型/工具 await 后核验 context、报告和协作版本。候选自动回放仍使用用户所选病例；回放后的评估不可偷偷改变阈值、采纳或发布。修改条件或重新回放后，旧模型评估必须隐藏或明确过期。兼容旧客户端 `autonomous=false`，UI 的 auto 默认显式 opt in。新增 `test_agent_investigation.py`、`agent_trace.test.ts`；维护时跑既有专家/复核层/患者测试及双语视口 QA，真实模型写入隔离 storage。不要对未跟踪的既有 demo 源码做整体 git add/commit，也不要提交服务备份、隔离工作区或构建产物。

- ICDE 默认反馈三栏位于 `revision_panel.ts` / `feedback_workspace.css`；原证据核查三栏位于独立 investigation 页的 `revision_workspace.ts/.css`，决策/状态仍由 `icde_demo.ts` 统一管理。候选复核层的后端范围验证、数值匹配和合成边界测试在 `review_policy.py`；禁止 eval、改写原 extractor、把复核标记当成模型预测或临床诊断。所有 validate/decision/带 policy 的 report 路径均执行 KTL+CRV 能力约束。
- 候选条件只能针对已有 QRS、PR、Q-wave count 数值，缺失/不可评估不能变正常。真实病例回放与合成边界值分开展示；计数相对原 no-overlay baseline，不宣称准确率改善。编辑候选/病例后前端旧验证失效；采纳时后端校验最新 validationId、协作版本、报告版本和所有回放 context。采纳生成 case-local immutable policy，不全局生效；发布通过显式 policyRoundId 关联快照，患者只看已发布版本。保留 validationHistory、拒绝记录和已有报告/反馈。
- 修改此闭环须跑 `test_review_policy.py`、既有 expert/demo/patient 测试、前端新增 `revision_workspace.test.ts`、双语 1280×720/1366×768/窄屏检查。真实模型/UI 测试必须隔离 review storage，不写线上临床演示报告。

- 专家意见修订闭环位于 `revision_loop.py`（提示词 `revise-next.md`，接口在 `demo_interactions.py` 的 `/revision`、`/revision/decision`，存储键 `revisions`，前端 `revision_panel.ts`）。它显示“专家参与的候选判断”与原始预测并排，这放宽了此前“复核标记不是模型预测”的约束，边界是：永不覆盖原始预测、不自动发布、不写临床结论。用户可显式将已采纳结果用于报告草稿并发布，服务端保存不可变 feedbackImpact；患者只读已发布快照，不能读取 revisions 集合。候选只能来自封闭空间（单类阈值，或 1–3 个数值条件增删一个标签），必须按 schema 和真实列名/类别校验，禁止 eval 或执行生成的代码。基线必须与 `metrics_formal.json` 对账才允许评估，特征表须与当前 iteration 和提取器指纹一致，否则拒绝并提示重建。验证折按患者切为调整集与留出集；若当前病例来自留出集，将整位患者排除出留出队列（reviewN），避免向 Agent 展示病例后仍当作未见样本。反复查看留出结果的专家反馈不构成独立临床验证。Agent 的输入只能含调整集数字，留出集只由应用报告给专家；第 10 折测试集不得使用。判定必须同时看改对/改错计数与目标类 F1，两者方向不一致标为“混合”；所有数字由确定性代码计算，模型文字须标注为模型文字，并禁止出现“准确率提升”“诊断改变”“临床验证”。表达不了的意见返回 `cannot_express` 并写明缺失测量，不得勉强近似。
- 修改此闭环须跑 `tests/test_revision_loop.py`、`tests/test_revision_agent.py`、既有 expert/demo/patient/review 测试、前端 `revision_panel.test.ts` 及类型检查/构建；特征表须按 `python -m harnessing_ts.revision_loop build` 离线重建，真实模型验证用隔离的工作区副本。`review_lab_zh.ts` 只能新增词条，`demo_i18n.ts` 合并顺序以基础词典为准，禁止改写既有界面文案。

- ICDE Demo 的界面语言由 `frontend/src/demo_i18n.ts` 和 `demo_zh.ts` 管理，语言偏好保存在浏览器 `recursiveecg.demo.language`。仅翻译显示文案，不改 feature ID、诊断代码、API payload 或报告/模型/用户/来源原文。切换语言必须保留输入草稿、选项、当前病例、滚动位置和进行中的请求；不得因切换再次调用模型。运行 `node --experimental-strip-types --test tests/demo_i18n.test.ts tests/demo_view.test.ts`（在 frontend 中，使用 Node 22+）及生产构建，并检查双语桌面与窄屏布局。

- ICDE Demo 的桌面视口规则集中在 `frontend/src/demo_viewport.css`。导航、输入框和建议操作不得随长对话离开视口；正文允许面板内滚动。窄屏或矮窗口保留文档滚动，不可简单裁切内容。修改后验证 1366×768、1280×720、窄屏及有历史记录的状态。

- 前端不应假设 variant ID 形如 `V\d`。variant 是任意 canonical feature-code string。
- 前端应基于 `variant.capabilities` 禁用或标记功能，不应只解析 ID 字符串。
- Bootstrap/live payload 的稳定聚合位置是 `backend/harnessing_ts/api/payloads.py`。
- `/api/events` SSE 是主同步路径；`/api/live` 保留用于兼容和诊断。
- 变体 pill 中完整 profile 和 ablation profile 的样式由显式 class 控制，不得恢复 `.variant-v0` 之类旧假设。

## 运行记录

运行记录写在 workspace 中：

```text
state/workspace.json
state/nodes/<node-session-id>.json
state/runtime-settings.json
state/knowledge-graph-build.json
state/reference-feature-build.json
state/chain-summary-build.json
.dsh-sessions/
logs/main.jsonl
logs/nodes/<node-session-id>.jsonl
logs/timeline.jsonl
logs/knowledge-graph-builder.jsonl
logs/knowledge-reasoning.jsonl
logs/chain-builder.jsonl
runs/registry.jsonl
artifacts/chain-summary.json
```

`knowledge-to-tools` 没有独立 builder 日志；它的 SDK 行为记录在对应 main/node log 中，后端强校验结果记录在 `state/reference-feature-build.json`。

## 验证要求

常规验证：

```bash
uv run python -m compileall -q backend/harnessing_ts
uv run pytest -q

cd frontend
bun install --frozen-lockfile
bun run build
```

当前环境注意事项：

- 项目要求 Python `>=3.11`。
- 如果 `uv run pytest` 调到系统 Python 3.10，应改用正确的 3.11 环境；不要把 `datetime.UTC` 等 3.11 API 报错误判为业务失败。
- `tests/conftest.py` 会设置 `TS_HARNESS_SKIP_WORKSPACE_UV=true`，普通单元测试不得为每个 `tmp_path` 构建完整 workspace `.venv`。
- runtime-base 行为必须用 mock/fake subprocess 做单元测试。

变体相关改动至少验证：

- `uv run ts-harness variants` 和 `uv run ts-harness variants --json`。
- default variant resolves to `NOD-KGR-KTL-CRV-SUB-ADA`。
- legacy aliases `V0`-`V6` resolve to canonical IDs。
- unordered IDs canonicalize, e.g. `RQA-NOD-SUB-ADA` -> `NOD-RQA-SUB-ADA`。
- invalid/unknown/valid-but-unregistered combinations fail with actionable messages。
- no-`KTL` profiles do not expose knowledge-to-tools node, extractor tools, extractor metadata, or extractor execution.
- no-`CRV` profiles reject case-review output paths.
- `DIR` exposes direct tools and no node specs.

## Git 和提交

专家协作变更须运行 `tests/test_expert_collaboration.py`、既有 demo/patient 测试及前端类型检查/构建；真实模型验证使用隔离 review storage，禁止发布伪造临床报告。详见 `docs/EXPERT_COLLABORATION.md`。

- 每次完成一个逻辑完整改动后提交，不要积攒大量无关改动。
- 提交前检查 `git status`，不要覆盖用户或其他 agent 的未提交改动。
- 不要 revert 未经请求的用户改动。
- commit message 使用 Conventional Commits。
- 行为、命令、配置、节点协议、运行产物、UI 操作或维护流程变化时，README.md、AGENT.md、docs/ 和相关配置文档必须同步。

禁止提交：

```text
node_modules/
dist/
.venv/
state/
logs/
user/
data/raw/
data/processed/
references/
artifacts/
plots/
tools/
runs/
reports/
.env*
.secrets/
config.llm.json
config.yaml
```
