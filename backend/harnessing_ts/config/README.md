# HarnessingTS Config

Patient prompts now prohibit repeated identity/legal boilerplate and optionally return `contextUpdates: [{quote, focusField}]`. Quote provenance is validated against real user messages (current question only in task mode); the server projects `focus` directly from the chosen actual answer field, never a separate model-authored claim about actions. This describes explanation emphasis, never a diagnosis, threshold or treatment update. No field should be filled just to populate the UI. Urgent guidance, medicine cautions, exact evidence gaps and the published-only boundary remain. Provider settings/credentials and expert prompts are unchanged.

Frontend presentation now restricts demo metrics to tuning/current-case results. This needs no prompt, provider or evaluation-configuration change. Holdout computation and stored audit records remain intact; the UI does not relabel or rewrite them.

The optional `/demo?scenario=positive` scene uses frontend-only synthetic rows and scripted text. It does not consume any model prompt, configuration or credential, and must never write synthetic evaluations to real records. Its permanent synthetic marker and SIM IDs distinguish presentation outcomes from real evaluations.

Patient answers now prioritize useful meaning and optional `symptoms/dailyCare/medication` general education. `limitation` is optional, not a mandatory disclaimer; `basis` is folded in the UI receipt. Report measurement sentences remain in model context rather than being deleted; output is plain-language unless technical detail was requested. Separate `generalEducation` definitions never become case evidence. The task adapter reuses the guide's health-education/safety contract and adds only actual-check planning/output. Named-drug purpose/cautions and low-risk rest habits are allowed, but not individualized medication selection/doses/changes or exercise clearance. Urgent symptoms retain priority. Records, model configuration, credentials and original report publication remain unchanged; prompts/lexical checks are not clinical validation.

Everyday questions omit measurement-heavy prose clauses/numeric attachment values from the model's reading projection and explicitly mark omission, not missingness; explicit technical questions/selections retain them. A narrow lexical guard rejects research comparisons, unrequested technical codes/numbers and the specific overclaim “没看波形/心电图”. Guide generation allows at most one wording correction using the same materials; the outer route rechecks versions afterwards. Investigation correction consumes an existing call within its original four-call budget and does not invent a successful check. These checks are not comprehensive factuality validation.

The revision prompt `expert-collaboration/revise-next.md` now consumes `caseEvidence`: application-computed tuning-only counterexamples, supporting changes and numeric boundary witnesses, with exact observed values and condition matches. It must use them to describe a limitation or refine a candidate, never infer clinical similarity/causality or invent missing cases. No new provider configuration, key or model is introduced. The read-only comparison endpoint and expert-only paragraph diff need no model call; only explicit revision/report requests invoke the existing provider.

This directory stores the harness text configuration that is read by the Agent.
Python code should treat these files as read-only inputs: it may parse, validate, and assemble them, but prompt text, node responsibilities, node guidance, and node native-tool lists should live here.

## Files

### `README.md`

This file. It explains the purpose and ownership boundary of the config directory.

### `__init__.py`

Marks this directory as a Python package so the backend can import config helpers.
It should not contain prompt or node content.

### `markdown.py`

Parser and loader for the Markdown configuration files.
It reads files under `prompts/` and `nodes/`, validates required fields, orders the node chain from `next` pointers, and exposes structured data to the backend.

This file should contain parsing logic only, not model-facing prompt content.

## `prompts/`

`prompts/expert-collaboration/patient-guide.md` supports the patient's understanding loop: everyday explanation, worry/uncertainty, conversation preparation, optional evidence explanation and teach-back. It explicitly avoids technical gatekeeping, unsupported reassurance, diagnosis/treatment and invented clinician replies. Only a published-material allowlist enters context, with UI language chosen at submission. Structured output is validated, referenced IDs must exist, and report/context versions are rechecked after await; prompt/schema checks still do not verify all prose. This is separate from writing/publishing the patient report and uses the same configured model service, without changing credentials or DSH sessions.

`prompts/expert-collaboration/patient-report.md` instructs the system patient-report writer: selected assessment and attached measurements only, English/Chinese language at invocation, plain-language findings/meaning/uncertainty, no unsupported diagnosis, invented measurements, scores or cohort metrics. Editing requests and previous text are untrusted data. Generation is an unpublished draft, never an automatic expert decision. The application validates schema, excludes numeric narrative additions/unselected class codes, appends a deterministic safety footer and requires explicit demo review/publication. This reuses the existing effective LLM configuration without changing credentials.

Prompt fragments shared by sessions or specific to a runner type.
These files are assembled by `backend/harnessing_ts/prompts/compose.py`.

### `prompts/shared/role-kernel.md`

Common identity and behavioral principles for both the main orchestrator and node runners.
This is model-facing text.

### `prompts/shared/workspace-static.md`

Common workspace rules and static runtime assumptions.
Supports template variables such as `{workspace_path}` and `{locale}`.
This is model-facing text.

### `prompts/main/role.md`

Main orchestrator role definition.
It tells the main session to talk with the user and start node sessions rather than doing node work itself.
This is model-facing text.

### `prompts/main/control-protocol.md`

Main-session MCP governance protocol for requesting `enter_node`.
This is model-facing text.

### `prompts/main/attachment.md`

Per-turn main-session attachment template.
It describes expected workspace layout and embeds the backend-generated structured progress snapshot. It supports `{workspace_path}` and `{progress_json}`.
This is model-facing text.

### `prompts/node/execution-rules.md`

Rules shared by all node runners.
This is model-facing text.

### `prompts/node/finish-protocol.md`

Node-session MCP governance protocol for reporting `finish_node`.
This is model-facing text.

### `prompts/node/attachment.md`

Node startup attachment template.
Supports `{node_type}` and `{input_summary_block}`.
This is model-facing text.

### `prompts/chain-summary/`

Chain builder prompt fragments assembled by `backend/harnessing_ts/prompts/compose.py`:

- `system.md`: builder role, evidence rules, Chinese output requirement, and draft-write protocol.
- `schema.md`: the required chain-summary JSON structure.
- `generate.md`: generation task template with `{manifest_json}` and `{draft_path}`.
- `repair-system.md`: constrained local-repair agent rules.
- `repair.md`: validation-repair template with attempt, path, and error variables.

Generation and repair prompts must be changed in these Markdown files rather than embedded in `chain_summary.py`.

### Expert collaboration prompts

`prompts/expert-collaboration/` is loaded directly by `expert_collaboration.py` for the separate ICDE review UI, not by a DSH node:

- `system.md`: evidence boundaries, user feedback handling, language and clinical-demo limitations.
- `plan.md`: the allowlisted check selection JSON contract.
- `proposal.md`: response, editable note, unresolved questions and evidence-name JSON contract.

The model can propose only existing checks; backend capability gates and version checks remain authoritative. Prompt changes must not imply unimplemented measurement, source-search, retraining or publication capabilities.

## `nodes/<node-type>/`

Each node has its own directory. A node directory must contain exactly these content files:

```text
spec.md
guidance.md
native-tools.md
```

Current node directories:

```text
nodes/problem-contract/
nodes/knowledge-to-tools/
nodes/iterative-solving/
nodes/final-summary/
```

### `nodes/<node-type>/spec.md`

Structured node contract.
It defines:

- `phase`
- `next`
- `purpose`
- `requires`
- `produces`

This file controls node order and the node contract shown to the model and UI.

### `nodes/<node-type>/guidance.md`

Node-specific execution guidance.
It describes how this node should satisfy its contract.
This is model-facing text.

### `nodes/<node-type>/native-tools.md`

Native DeepSeek Harness tools declared as candidates for this node before HarnessingTS MCP/text-control tools are added. The final DSH tool schema is further filtered by the active variant and deployment settings: `web_fetch` / `web_search` require their explicit environment opt-ins, and subagent tools require the `SUB` capability.
One tool per Markdown list item.

Example:

```text
- bash
```

This file is used by `backend/harnessing_ts/tools/compose_tools.py`.

## Maintenance Rules

`expert-collaboration/revise-next.md` handles the primary expert-feedback workbench. `previousFeedback` includes prior opinions/candidates and tuning-only observations; `evidenceContext` carries actual measurements and prior checks. Follow-up feedback refines the selected parent, but each candidate is evaluated against the immutable original baseline, not silently composed with older rules. The reviewed patient is excluded from the holdout cohort. Repeated expert feedback is not independent clinical validation. Supported changes remain a single-class threshold or 1–3 numeric conditions adding/removing one label; no retraining, generated code or automatic publication. Explicit adoption and report publication can attach a server-built immutable feedback-impact snapshot, which is the only revision-derived data allowed in patient context. No new credentials or configuration settings are introduced.

The expert-collaboration proposal prompt includes explicit response/draft/list size bounds to help the model finish a valid JSON object. Its official DeepSeek transport uses non-thinking mode and an 8192-token output budget; these are request parameters, not model-facing instructions. Keep prompt content here and provider-specific transport handling in `expert_collaboration.py`.

- Put model-facing text in Markdown files, not Python files.
- Keep shared behavior in `prompts/shared/`.
- Keep main-only behavior in `prompts/main/`.
- Keep node-runner common behavior in `prompts/node/`.
- Keep chain builder generation, schema, and repair behavior in `prompts/chain-summary/`.
- Keep node-specific responsibility, guidance, and tool access in that node's own directory.
- When adding a node, create a new `nodes/<node-type>/` directory and connect it through the `next` field in `spec.md`.
- Avoid putting multiple unrelated configuration domains into one Markdown file.
# Expert candidate review overlay (2026-10-19)

`prompts/expert-collaboration/patient-task-next.md` selects read-only published-material checks from actual observations, then returns a patient-facing finding, honest limit and optional impersonal evidence-check target, not a letter to a doctor. Initial and repeat checks use the three-distinct-check/four-call/150-second bound and version guards. It cannot execute ECG tools, access GT/other patients, validate diagnoses, change criteria or send/publish. `patient-guide.md` can explain an Agent check and application-computed current publication comparison immediately, without a doctor reply. Stale Agent interpretations and unpublished professional work do not enter that context. Legacy explicitly published replies remain readable separately. Prompt/schema checks are not clinical validation. No new provider setting, credential or environment variable is introduced.

`expert-collaboration/investigate-next.md` chooses each next read-only check from executed observations, with finish/ask-expert exits. `assess-replay.md` reassesses the original proposal against actual selected-case replay, preserving null results and uncertainty. Prompts cannot grant tools, exceed the three-check/150-second backend budget, change predictions, adopt a condition or publish. The visible trace contains action receipts and brief justifications, never hidden chain-of-thought. Initial proposal/draft and post-replay recommendation are distinct. Existing `plan.md` remains for non-autonomous API clients.

QRS audits can return bounded actual source lines for internal-p75/output-field mapping. Both proposal and replay-assessment prompts distinguish qrs_ms from max_ms and review the initial numerical claims against authoritative current-record data; they must not invent a missing statistic when source mapping resolves it. These are grounded review instructions, not a guarantee that model prose is infallible.

`prompts/expert-collaboration/proposal.md` now requests optional `candidate` in addition to the five existing analysis fields. Return null when the evidence does not support an executable scalar condition; never manufacture a rule edit to satisfy an objection. The only supported action is `needs_review` on supplied QRS/PR/Q-wave-count values with bounded finite range predicates. Backend validation/adoption, not model prose, determines execution and saved policy versions. Source gaps are potential review issues, not proven medical errors. No new secret, model, environment variable, global extractor modification or training workflow is introduced. See `docs/EXPERT_COLLABORATION.md`.

# Patient context and focused follow-up

The shared patient prompt now receives application-built `patientContext` (explicit user-only reported/denied/uncertain symptom excerpts and the current published report labels/revision). Treat it as a bounded lexical aid, not clinical triage. Respect negations, verify the selected report rather than accepting a patient's recollection, ask one missing detail in optional `followUpQuestion`, and provide useful guidance without waiting for a reply. That field is Agent-to-patient, not patient-to-Agent `nextQuestion` or a system `reviewQuestion`. New context may revise an explanation, not diagnosis or treatment. Provider configuration and credentials are unchanged.

