---
name: docvalidate
description: Phase 5 — Cross-Validation of PRD and SDD Traceability. Use after docgenerate to auto-validate and auto-fix all traceability gaps, structural issues, and compliance violations. Produces revised documents.
allowed-tools: Read Write Bash
---

Act as a Principal QA Architect executing **Script 05 — Cross-Validation**.

Read:
1. docs/PRD.md and docs/SDD.md
2. docs/REQUIREMENTS_CONTRACT.md (ground truth for all auto-fix decisions)

Auto-execute all checks. Apply all fixes automatically.
Do NOT ask "apply fixes?". Do NOT wait for user confirmation.
Log every decision made. Escalate only on genuine contradictions.

======================================================================
AUTO-FIX POLICY
======================================================================

For every issue found, apply the fix immediately using the policy
from docs/REQUIREMENTS_CONTRACT.md Section 8:

- Traceability gap     → apply traceability_gap_policy
- 50-line violation    → auto-split per decomposition rules
- Missing section      → auto-generate from contract context
- FR conflict          → apply fr_conflict_policy
- Missing AC           → auto-generate from contract Section 6 EC-NNN

Log every fix:
"AUTO-FIX [HIGH/MED/LOW]: [description] — [action taken]"

ESCALATE ONLY IF:
- Two MUST FRs directly contradict each other AND fr_conflict_policy is "pause-and-ask"
- A required section cannot be generated from available context

======================================================================
MANDATORY CHECKS
======================================================================

### 1. Traceability Matrix
For every FR in PRD, verify covered by a component and function in SDD.
| FR-NNN | Description | SDD Component | Function(s) | Status |

### 2. AC Coverage
For every AC in PRD, ensure at least one FN-NNN in SDD traces back to it.
| AC-NNN | Parent FR | Traced FN-NNN | Status |

Verify every EC-NNN from contract Section 6 has a corresponding AC-NNN.
Verify every BR-NNN from contract Section 6 has a corresponding AC-NNN.

### 3. 50-Line Compliance
Scan every function spec in SDD Section 3.
AUTO-FIX all violations. Log each split.

### 4. PRD Structural Completeness
Verify all 10 required sections exist.
Verify: no "and" in FRs, Gherkin ACs, tagged FRs, User Story format,
measurable checkpoints in Section 10.
AUTO-FIX all issues.

### 5. SDD Structural Completeness
Verify all 9 required sections exist.
Verify: Mermaid in Section 2, full function specs in Section 3,
all entity fields match contract Section 4,
all API specs match contract Section 5.
AUTO-FIX all issues.

### 6. Coding Standards Compliance
All function names snake_case, no "and" in descriptions,
validate_<n>() and io_<n>() extraction rules followed.
AUTO-FIX all violations.

======================================================================
GAP REPORT (generated before applying fixes)
======================================================================

🔴 HIGH: Traceability gaps · 50-line violations · Missing required sections
🟡 MED:  Missing Mermaid · Untagged FRs · Compound descriptions
🟢 LOW:  Grammar · Minor structure · Incomplete rationale

======================================================================
SAVE & PROCEED
======================================================================

After all auto-fixes:
1. Save revised PRD to docs/PRD-revised.md
2. Save revised SDD to docs/SDD-revised.md
3. Output:

"✅ Validation Complete (auto-fix log below)
 - FR count: N | AC count: N | FN count: N
 - PRD sections: 10/10 | SDD sections: 9/9
 - Fixes applied: N (see log)
 - Escalations: N"

If N escalations = 0: immediately proceed to /docprototype.
If N escalations > 0: present each escalation for human decision,
then continue after response.

$ARGUMENTS
