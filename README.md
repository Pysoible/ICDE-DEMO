# RecursiveECG

### Patient interaction: less boilerplate, visible response

The patient view keeps one public-data/demo badge and removes repeated generic disclaimers. Relevant uncertainty, urgent-care actions and medicine cautions remain. **Add my situation** prepares an editable question; the next answer can show exact user quotes beside the Agent's explanation focus. Quotes are checked against actual user messages, not inferred from ECG labels. Completed report/attachment/version checks are visible above a task finding. These are material checks and explanation changes, not new diagnoses, treatment changes or automatic report updates. Existing reports/tasks retain their original text; send a new question to use the new response format.

### Patient explanation update

In `/demo`, **Understand together** separates a direct answer, what the published material records, a question-specific limitation, and a useful follow-up. “Ask the Agent about this” prepares an editable question; sending is still explicit. The check view separately displays what the Agent actually checked. Original reports and old checks remain unchanged; request a new explanation to use the updated wording. Legacy Demo question clients use the same published-report-only explanation service; the root workbench is unchanged. Explanations do not independently verify medical correctness or replace care.

RecursiveECG is a time-series tool-use harness built on the official Python DeepSeek Harness SDK.
It helps an agent work through a time-series task with references, data exploration, a problem contract, iterative tool building, evidence review, and a final summary.

It is not a leaderboard or model-comparison framework. The goal is a structured, auditable problem-solving workflow.

## Interactive ECG demonstration

The patient page defaults to **Check my question**. Ask in everyday words and explicitly choose **Ask Agent to check**. The Agent selects up to three read-only published-material checks and immediately returns findings and limitations, with actual application receipts available separately. **Help me understand this finding** prepares a follow-up with the Agent, without waiting for a doctor reply. This checks published materials, not diagnostic correctness or symptoms; no report/classification changes automatically.

Patients may optionally expand **keep an evidence gap**, edit the suggested check target and explicitly save it. This is a system evidence-check task, not doctor-to-patient chat. In expert tab **05 Report & feedback → Agent-discovered evidence-check tasks**, start it and carry the target into the existing expert-feedback or evidence-investigation workspace. Perform analysis or separately publish a reviewed report; return to 05, select actual work performed after start, confirm its association, and choose **Record review work**. No patient reply is written or published. Saving that work does not publish or change a report and does not certify resolution.

For every saved question, the patient sees a computed comparison against the current published report, including label/text/attachment changes or no change, even if no expert task was submitted. **Recheck my original question** becomes available after a new publication or recorded review work; the Agent checks current published material again, preserving the original check. Professional analysis can remain internal without changing the report, so the Agent may honestly report insufficient information. The comparison does not establish causal influence of the question or diagnostic improvement. This research demo does not provide authenticated clinical accounts, doctor chat, appointments or guaranteed response times. Legacy feedback/replies and existing reports remain intact.

The patient view shows **Report findings** directly below the published-report heading, with each code and localized name visible without expanding technical details. Select a label to prepare an editable explanation question; send explicitly. These are the published report's labels, not reported symptoms or confirmed diagnoses.

Use **中文 / English** at the top right of `/demo` to switch the expert and patient interface language. Your choice is saved in this browser; the first visit follows the browser language. Navigation, controls, hints and measurement display names switch immediately, including while a question is being processed. Unsent questions and review drafts are retained. Saved reports, existing conversations, model responses and original reference text retain their original language. The original `/` Agent workspace has its own interface.

Expert analysis distinguishes quota/credential errors, connection failures, timeouts, empty answers and incomplete output. Your question is retained on failure. The official DeepSeek connection uses non-thinking mode for its bounded JSON planning and analysis requests, with an 8192-token output budget. This prevents default reasoning from consuming the whole answer budget. The configured model and credential are shared with the existing service.

Open `/demo?role=expert&case=49` for expert feedback. Submit an opinion, inspect the tested threshold/criterion and its effects, then refine or confirm. Explicitly using a confirmed result asks RecursiveECG to generate a patient report: the expert does not need to write it. In tab 05, request a simpler explanation or clearer uncertainty, inspect the rewritten text, or optionally edit it directly. Check the review approval box and choose **Approve & publish patient report** to publish. Generation and draft saving never publish; changed assessment/evidence requires regeneration and renewed approval. Expert validation details stay separate from patient-facing prose. `/demo?role=patient&case=62` opens the last published report. Existing reports remain unchanged until an explicit new publication. These public-data examples are not clinically validated reports.

See [Expert collaboration](docs/EXPERT_COLLABORATION.md) for the interaction, supported checks, configuration and limitations. The original Agent workspace remains at `/`.

In tab 05, click the **Assessment and evidence used for generation** heading to expand or collapse the label/evidence selector. Selecting or removing labels and evidence keeps it open and retains the report-panel scroll position. The current case also retains manual-edit/audit expansion while switching tabs or interface language; a different case/source context starts with its own defaults. Changing labels/evidence still invalidates report approval and requires regeneration.

On desktop windows (at least 980 × 600 CSS pixels), the demo fits the viewport: navigation stays visible, conversations and evidence scroll within their panels, and the expert composer and suggestion decisions remain on screen. Smaller windows retain normal page scrolling for readability. Suggested questions and scope details can be expanded when needed.

## Quick Start

### 1. Install Prerequisites

You need Python 3.11+, Git, [uv](https://docs.astral.sh/uv/), Node.js 20+ with npm, [Bun](https://bun.sh/) for the frontend, and a DeepSeek-compatible API credential. `uv sync` installs the official DeepSeek Harness Python SDK. Runtime execution uses the project-local, package-locked Node composition in `backend/dsh_runtime/`, which contains the JSON-RPC server, Cordis composition, MCP client, filesystem/shell tools, Web plugins, and subagent plugins.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv --version
```

### 2. Prepare The Project

```bash
git clone https://github.com/neumyor/RecursiveECG.git
cd RecursiveECG

uv sync
uv run ts-harness setup-server
```

`setup-server` installs and verifies the project-local DeepSeek Harness Node runtime, builds the production frontend, and prepares a shared runtime base for task workspaces. The Python SDK is configured to launch this local runtime explicitly, rather than relying on a bundled runtime. To refresh it independently, run `npm ci --prefix backend/dsh_runtime`. Do not update the Python SDK or `backend/dsh_runtime` packages independently; run the full test suite after a coordinated runtime upgrade.

### 3. Configure The LLM

Choose one authentication mode.

Use DeepSeek Harness environment credentials:

```bash
export TS_HARNESS_LLM_AUTH_MODE=sdk-default
export DEEPSEEK_API_KEY=YOUR_API_KEY
```

Or save an explicit DeepSeek-compatible endpoint configuration:

```bash
export TS_HARNESS_LLM_AUTH_MODE=manual
export TS_HARNESS_LLM_PROTOCOL=deepseek
export TS_HARNESS_LLM_MODEL=deepseek-v4-flash
export TS_HARNESS_LLM_BASE_URL=https://api.deepseek.com
export TS_HARNESS_LLM_API_KEY=YOUR_API_KEY
```

Check the effective configuration without printing the full API key:

```bash
uv run ts-harness llm-config
```

### Optional Web Tools

Filesystem, shell, and `SUB` subagent tools are supplied by the local DSH runtime and filtered by the active node/variant. Web tools are disabled unless the deployment opts in:

```bash
# Only enable where the server is not able to reach sensitive internal hosts.
export TS_HARNESS_ENABLE_WEB_FETCH=true

# Reuses DEEPSEEK_API_KEY for search.
export TS_HARNESS_ENABLE_WEB_SEARCH=true
```

The current upstream HTTP fetch provider does not provide private-network/SSRF protection, so do not enable `TS_HARNESS_ENABLE_WEB_FETCH` on a host that can access trusted internal services.

### 4. Start Locally

Use a separate workspace per experiment or ablation variant.

```bash
export TS_HARNESS_WORKSPACE="$HOME/.RecursiveECG/workspaces/default"
export TS_HARNESS_VARIANT=NOD-KGR-KTL-CRV-SUB-ADA
export TS_HARNESS_CONTROL_MODE=auto
export HOST=127.0.0.1
export PORT=4327

uv run ts-harness-server
```

Open [http://127.0.0.1:4327](http://127.0.0.1:4327).

Useful launch options:

```bash
# Show registered ablation profiles and legacy aliases.
uv run ts-harness variants

# Run the UI without calling DeepSeek Harness.
TS_HARNESS_DRY_RUN=true uv run ts-harness-server

# Enable debug/reset controls. Do not use this on shared/public servers.
TS_HARNESS_DEBUG=true uv run ts-harness-server
```

## Using The UI

Typical flow:

1. Open **Settings** and confirm the Main LLM configuration.
2. Upload domain documents through **Reference Files**.
3. Upload task data through **Raw Data Zip**.
4. Send the task definition in the main chat.
5. Build the **Knowledge Graph** when using a `KGR` profile.
6. Let the node chain run through `problem-contract`, optional `knowledge-to-tools`, `iterative-solving`, and `final-summary`.
7. Inspect node logs, workspace files, run outputs, case-review artifacts, chain summary, and final summary.

Control modes:

- `TS_HARNESS_CONTROL_MODE=auto`: node transitions are accepted automatically.
- `TS_HARNESS_CONTROL_MODE=manual`: each node entry and completion waits for browser approval.

### Session Recovery

DSH's append-only session log under `.dsh-sessions/` is the conversation and tool-history source of truth. Each logical main/node actor owns one stable DSH session ID. Every turn opens a fresh runtime process, explicitly creates or resumes that identity, runs one prompt, flushes a durable checkpoint, and closes the process.

Pause uses DSH's native boundary: cancel the root agent, wait until it is idle, drain continuable descendants, flush the session, then acknowledge `paused`. The acknowledged DSH checkpoint sequence is persisted in `state/execution.json` and in the `execution_paused` timeline event. It has no automatic client or server timeout. A separately confirmed force-stop is available only while `pausing`; recovery first resumes the same session so DSH can repair an incomplete tool boundary. If a process died after reserving an identity but before DSH created its log, recovery may create that exact identity only after DSH explicitly reports it absent. Continuing a paused actor requires a non-empty user message; it clears the node's active `pausedAt` marker while retaining the historical pause event in the timeline. `running`, `pausing`, `recovering`, and `failed` executions reject new messages.

## Ablation Variants

`TS_HARNESS_VARIANT` is read once at process startup. Restart the server to switch variants, and use a different `TS_HARNESS_WORKSPACE` for each experiment.

Feature codes are order-insensitive. For example, `RQA-NOD-SUB-ADA` is accepted and canonicalized to `NOD-RQA-SUB-ADA`.

```bash
uv run ts-harness variants
```

Feature codes:

| Code | Meaning |
|---|---|
| `NOD` | RecursiveECG node chain. |
| `KGR` | File-backed reference knowledge graph and graph-backed `query_knowledge`. |
| `RQA` | Direct reference QA agent over `references/**`; mutually exclusive with `KGR`. |
| `FQA` | QA over generated `tools/reference-feature-extractor/**` source/rules as replacement reference material; mutually exclusive with `KGR` and `RQA`. |
| `KTL` | `knowledge-to-tools` node and validated reference feature extractor. |
| `CRV` | Structured case review and case-level attribution. |
| `CXR` | Structured case review with reference feature extractor execution disabled. |
| `SUB` | Independent candidate testing/review through DSH subagents. |
| `ADA` | Adaptive iterative solving and stop decisions. |
| `DIR` | Direct single-agent baseline; cannot be combined with other codes. |

Registered profiles:

| Canonical ID | Legacy alias | Description |
|---|---|---|
| `NOD-KGR-KTL-CRV-SUB-ADA` | `V0` | Full RecursiveECG. |
| `NOD-RQA-KTL-CRV-SUB-ADA` | `V1` | Full node workflow without the knowledge graph; `query_knowledge` answers directly from references. |
| `NOD-RQA-KTL-SUB-ADA` | `V2` | Direct reference QA with case review removed. |
| `NOD-RQA-CRV-SUB-ADA` | `V3` | Direct reference QA with `knowledge-to-tools` and reference feature extractor removed. |
| `NOD-RQA-SUB-ADA` | `V4` | Direct reference QA with both case review and knowledge tools removed. |
| `DIR` | `V5` | Ordinary single-agent tool-use baseline with no node chain or harness MCP tools. |
| `NOD-FQA-KTL-CXR-SUB-ADA` | `V6` | Builds the reference feature extractor, then uses its source/rules as downstream QA material; case review remains but extractor execution is disabled. |

A removed feature is not merely optional. It is blocked by tool availability and backend checks where applicable. For example, no-`KTL` profiles cannot enter `knowledge-to-tools`, cannot validate or run the reference feature extractor, and do not expose extractor metadata through the API.

## Startup Errors

The server validates startup-only configuration before binding the port.

| Error text | What to do |
|---|---|
| `Invalid PORT` | Set an integer from 1 to 65535, for example `PORT=4327`. |
| `Invalid TS_HARNESS_CONTROL_MODE` | Use `auto` or `manual`. |
| `unknown feature code` | Run `uv run ts-harness variants` and choose a listed code. |
| `DIR cannot be combined` | Use `DIR` alone. |
| `KGR, RQA, and FQA are mutually exclusive` | Choose graph-backed knowledge, direct reference QA, or extractor-source QA. |
| `syntactically valid but not a registered ablation profile` | Use one of the registered canonical profiles. |

## Server Deployment

For LAN or server use, bind to a non-loopback address and keep all startup-only values in the same service environment.

```bash
export HOST=0.0.0.0
export PORT=4327
export TS_HARNESS_WORKSPACE=/srv/RecursiveECG/workspaces/nod-kgr-ktl-crv-sub-ada
export TS_HARNESS_VARIANT=NOD-KGR-KTL-CRV-SUB-ADA
export TS_HARNESS_CONTROL_MODE=auto

uv run ts-harness-server
```

One-line launch example:

```bash
HOST=0.0.0.0 \
PORT=4327 \
TS_HARNESS_WORKSPACE=/srv/RecursiveECG/workspaces/nod-rqa-sub-ada \
TS_HARNESS_VARIANT=NOD-RQA-SUB-ADA \
TS_HARNESS_CONTROL_MODE=auto \
uv run ts-harness-server
```

The server prints a LAN URL when it can detect one. Open the port in your firewall if needed.

For long-running deployments, use a process manager such as `systemd`, `supervisord`, Docker, or tmux. Example `systemd` fragment:

```ini
[Service]
User=harness
WorkingDirectory=/path/to/RecursiveECG
Environment=BUN_INSTALL=/home/harness/.bun
Environment=PATH=/home/harness/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOST=0.0.0.0
Environment=PORT=4327
Environment=TS_HARNESS_WORKSPACE=/srv/RecursiveECG/workspaces/nod-kgr-ktl-crv-sub-ada
Environment=TS_HARNESS_VARIANT=NOD-KGR-KTL-CRV-SUB-ADA
EnvironmentFile=/etc/RecursiveECG.env
ExecStart=/usr/bin/env uv run ts-harness-server
Restart=on-failure
```

Keep API keys in an environment file with restricted permissions. Put public deployments behind authentication, HTTPS, and network allowlisting.

### Internal MCP Bridge

The DSH MCP bridge is an implementation detail, not a public integration endpoint. For each runner, the server creates a short-lived capability bound to the workspace, session role, node ID, and allowed MCP tools. The bridge calls the loopback-only `/internal/dsh/mcp` endpoint; it is rejected for non-loopback clients.

`DSH_MCP_CONTROL_URL` and `DSH_MCP_CAPABILITY` are reserved internal variables. Cordis forwards them only to the stdio MCP child process, while DSH removes `DSH_*` values from model-executed shell children. Do not expose these values, set them in prompts, or route the internal endpoint through a reverse proxy.

## Workspaces And Runtime Files

Runtime workspaces are separate from the source repository. By default they live under:

```text
~/.RecursiveECG/workspaces/default
```

Important workspace directories:

```text
references/                 uploaded reference files
data/raw/                   uploaded raw task data
data/processed/             derived task data
user/                       problem contracts, data specs, final solution
tools/                      generated tools and reference feature extractor
runs/                       iteration run outputs
reports/                    candidate/case/final reports
knowledge_base/             knowledge graph tables and cache
state/                      JSON state
logs/                       JSONL logs
.dsh-sessions/              durable DSH JSON-RPC session events/checkpoints
```

SDK sessions run with `cwd` set to the runtime workspace. Task dependencies should be installed into that workspace, not into the RecursiveECG source repository:

```bash
uv run python script.py
uv add package-name
uv run --with package-name python script.py
```

## Development Checks

For local code changes:

```bash
uv run python -m compileall -q backend/harnessing_ts
uv run pytest -q

cd frontend
bun install --frozen-lockfile
bun run build
```

The Vite development UI is available at `http://127.0.0.1:5173`:

```bash
cd frontend
bun run dev
```

## Optional Training Scaffold

Training support is optional and not needed for normal use.

```bash
uv sync --extra training
uv run ts-harness training-template
```
# ICDE 专家交互更新（2026-10-19）

**演示指标范围**：专家反馈主卡、候选尝试、变化病例列表、报告页专家摘要与预设场景仅显示调整集和当前病例。页面标注调整集范围；不展示留出集及包含留出样本的全量汇总。既有后台评估与历史记录保留，调整集结果不能解释为独立泛化验证。

### 预设正向交互演示（模拟数据）

打开 `/demo?scenario=positive`。该独立页面以 SIM 编号和固定水印展示预设意见、条件与报告表达，不调用模型或读写真实报告。点击意见 1 / 2 对比条件范围；两组模拟记录的计数和 NORM F1 均从可展开的逐条记录计算。意见 2 在模拟调整组和模拟留出组均有正向变化。此处分组只服务交互展示，不能作为 PTB-XL 研究结果或泛化验证；原始工作台保留真实结果。页面提供返回真实数据工作台的链接。

## 患者理解伙伴（2026-10-20）

患者端新增“症状观察 / 怎么休息 / 用药问题”入口，点击仅准备问题，发送后才调用模型。回答可包含相关症状的一般知识、具体睡眠与休息习惯、药物用途和常见注意事项；不会由报告标签推断患者已有症状或开具个人处方/剂量。普通解释不再强制附免责段落，材料依据放在可展开回执中；必要急症提醒仍直接显示。原报告和旧回答不重写，刷新并重新提问使用新逻辑。

打开 `/demo?role=patient&case=26`，默认使用“核实我的疑问”。患者用自己的话提问，明确发送后 Agent 选择只读核查动作，立即返回发现、局限与实际核查回执，不需要先理解 QRS，也不用等待医生回复。“帮我读懂这次发现”准备与 Agent 的后续解释；若要进一步核查，可展开并编辑“保留一个待核查点”，保存的是系统任务而不是医生聊天消息。专家在 05 页接手后，可使用原反馈分析／证据核查工具，随后关联接手之后实际产生的分析或单独审核发布的新报告，记录核查工作，无需撰写患者答复。患者始终能看到原问题以来的真实已发布版本变化；有新材料或核查工作时可针对原问题重新核查。没有变化、证据仍不足也是有效结果，不证明临床问题已解决，不能宣称反馈导致诊断变正确。原始报告、旧反馈和旧答复全部保留，阈值/模型/报告不自动修改。“一起读懂报告”中保留通俗解释、理解核对和六项临时问题清单；清单可带入 Agent 核查，语言切换不调用模型。公开数据演示不提供问诊、预约或经临床验证的服务。

**2026-10-20：从统计到可追问的病例证据。** 01 页中栏逐项展示当前病例是否命中候选条件；“不符合我的本意，纠正理解”可写入下一轮意见。右栏展示真实调整集的反例、支持例和边界例，点击可在同页切换，不离开当前病例；“请 Agent 结合此病例继续修订”将该病例的真实观察填入输入框，仍由专家明确提交。Agent 每次检验后也会得到调整集例证，下一轮可针对代价或边界继续检验；不保证一定找到更好的条件。反例不是临床相似病例，弱标签一致也不是诊断正确。无推荐时保留最后一次检验的证据，但不能采纳。05 页“报告文字变化”对比当前系统草稿与上次已发布正文，没有旧报告时不编造对照。原预测、已发布报告和旧 `/` 工作台保持不变；切换语言不触发模型。更完整的功能与边界见 [专家协作说明](docs/EXPERT_COLLABORATION.md)。

专家协作页默认采用 **Agent 主动核查**：输入核查目标，Agent 根据实测值与每次检查结果选择下一步，最多三次检查；需要缺失信息时提出具体追问。有候选条件时自动在当前及所选病例上回放，再明确保留候选、暂不推荐或请求补充信息。界面展示真实行动记录、停止原因和回放后再评估；不是展示虚构的“思考过程”。病例选择仍由用户控制，不能把小样本回放当成准确率或临床验证。编辑条件后，之前的 Agent 评估不再适用，须重新验证。专家仍单独决定采纳、编辑草稿与发布；原工作台和已有报告不变。

打开 `http://10.132.80.118:4328/demo?role=expert&case=49`，默认展示“专家意见报告—Agent 调整—反馈前后对比”。输入意见并点击“根据意见调整并重新分析”；点击历史意见卡查看对应条件与影响。确认后将结果用于报告，由系统自动生成患者解释。05 页的“对报告的修改要求（可选）”仅重写表达，不调整判断条件；“将此报告送回判断复核”才会把文字带回 01 页，且仍需明确提交。原有测量、规则、来源检查与最多 8 病例的复核标记回放保留在独立“证据核查”页。长内容在栏内滚动，审核发布操作保持可达；窄屏使用页面滚动。

证据核查建议采纳后，明确选择报告类别，再由系统生成通俗报告。专家可要求 Agent 重写、可选直接编辑，审核后显式发布。患者只读取已发布报告及精简的本病例判断变化；跨病例统计、原始专家假设及阈值推导留在专家端。生成时按当前界面语言撰写，切换语言本身不重新调用模型。边界测试数值不是患者实测值，回放变化不代表诊断或准确率提升；原 `/` 工作台不变。详见 [专家协作说明](docs/EXPERT_COLLABORATION.md)。

**专家意见修订（2026-10-19）**：Agent 在封闭候选空间内（单类阈值，或 1–3 个测量/概率条件增删一个标签）提出标准，确定性计算本病例及验证集的前后变化。原始概率、标签和模型参数永不覆盖；确认记录本病例的新版演示评估，不自动发布或全局部署。每轮相对原始基线评估，不暗中叠加旧条件。验证折按患者分组；当前展示给 Agent 的病例所属患者从留出队列中排除，后续反馈只带入调整集数字。反复查看留出结果后的反馈不等于独立临床验证，不保证任意意见带来改善。显式发布会保存不可变的反馈影响快照，患者只见已发布快照，后续反馈不改旧报告。特征表加载在缓存命中前核验提取器和表/概率/指标/元数据的内容指纹，过期时拒绝使用；首次使用或提示过期时离线重建：`python -m harnessing_ts.revision_loop build --workspace <工作区>`。详见 [专家协作说明](docs/EXPERT_COLLABORATION.md)。

# Patient context-aware explanations

In **Add my situation**, describe symptoms, timing, sleep or medicines. New answers distinguish explicitly reported versus denied symptoms, show the current published report version/findings, and ask one useful missing question. **Add my answer** prepares editable text; it never sends automatically. The Agent may revise its explanation after new context, not a diagnosis or the published report. A mismatch between your description and the selected report is shown explicitly. Old answers remain historical; send a new question to use the updated behavior. Explicit symptom negations no longer trigger an emergency reply by keyword alone; positive/uncertain urgent mentions still take priority. This bounded language check is not clinical triage.

