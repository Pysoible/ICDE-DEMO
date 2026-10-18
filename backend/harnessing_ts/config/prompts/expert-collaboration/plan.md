Select ONE available action.
review_evidence: inspect supplied measurements and rules.
rerun_measurements: actually re-execute the existing full-record tool (same algorithm, no new lead or segment capability).
audit_sources: inspect attached source excerpts and check local source availability (not a new literature search).
Return {action, focus, reason}; focus must be empty or one of availableFeatures.
For unavailable tasks, choose review_evidence and explain the limitation. Do not silently substitute a different medical task.
