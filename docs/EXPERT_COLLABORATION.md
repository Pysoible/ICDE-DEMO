# Expert collaboration in the ICDE demo

Open `/demo?role=expert&case=26`. The default **Collaborate** tab treats the expert as a user who receives help, rather than someone who must write a report from scratch.

## Interaction

1. Choose **Prepare an initial analysis** or ask a question in Chinese or English.
2. Read the response and **What the system actually checked**. In automatic mode the model selects one allowlisted action: inspect evidence, re-run the existing full-record tool, or inspect attached sources and local source availability.
3. Challenge a particular measurement from **Evidence → Question this evidence**, or ask a follow-up. Each round retains the prior proposal, decision, executed checks and actual text diff.
4. Inspect **Still unresolved** and the proposed note. Reject a suggestion, continue questioning, or **Accept into editable draft**. Accepting does not publish, select diagnosis labels or overwrite a saved report.
5. Edit the draft, explicitly choose review labels, then save or publish. Published reports retain an optional `analysisRoundId` linking the accepted suggestion. Patient explanations use the published report, not pending suggestions.

Changing a preview condition only produces review flags. The collaboration does not automatically change the classifier, source code, tools, patient care or training data. Re-running uses the same complete-record extractor. Source inspection checks attached excerpts and file availability; it is not a new literature search or verbatim quotation validation. Model-generated prose still requires expert review.

## API and storage

- `GET /api/demo/{dataset}/cases/{id}/collaboration`: current context and collaboration history.
- `POST` to the same path: `contextId`, independent collaboration `expectedRevision`, `message`, optional `focus`, and `action` (`auto`, `review_evidence`, `rerun_measurements`, `audit_sources`).
- `POST .../collaboration/decision`: `contextId`, `expectedRevision`, `roundId`, `decision` (`accepted` or `rejected`). Only the latest pending suggestion can be decided. Report revision changes invalidate a pending decision.
- Existing review payload accepts `analysisRoundId` only for an accepted suggestion. Reports retain their own revision counter, separate from collaboration history.

History is appended under `collaboration` in the existing context-bound `state/icde-demo/*.json` record. Existing reviews and patient feedback are preserved. Context and report revision are checked again after model work. Revision checks and record writes are protected by the existing process-local lock, intended for the current single-worker deployment, not multi-process transactional storage. A 40-round per-context bound prevents unbounded demo histories; no old rounds are silently deleted. The latest four rounds are supplied to the model, with their accept/reject status, while the full history remains visible.

## Configuration and failure behavior

Uses the existing effective LLM configuration, with the same environment credential fallback as patient Q&A. No new secret is required. Each model request has a 55-second timeout. Automatic checking can require a planning call followed by an answer call. Model requests use JSON output, allowlisted actions and measurement-name validation. Provider failure or invalid output returns 503, retains the question in the browser and adds no fabricated successful round. Errors do not expose raw provider responses or credentials.

The route requires reference-feature execution and case-review reference-feature capabilities. DIR, no-KTL, no-CRV and CXR variants must not execute it. It does not enter or mutate DSH training/node sessions. Prompts live under `backend/harnessing_ts/config/prompts/expert-collaboration/`.

## Verification

Backend coverage is in `tests/test_expert_collaboration.py`: multi-round tool re-execution, actual diffs, invalid references, accepted/rejected decisions, concurrent revisions, report preservation, late results and variant gates. Existing demo and patient Q&A tests must continue to pass. Run frontend type checks and production build, and inspect desktop/narrow layouts. A live provider smoke check must distinguish real tool results from generated analysis and must not publish fabricated clinical reports.
