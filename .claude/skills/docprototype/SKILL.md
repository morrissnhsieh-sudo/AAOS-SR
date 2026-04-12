---
name: docprototype
description: Phase 5b — Pre-Code Prototype Generation. Use after docvalidate to generate UI skeletons, flow diagrams, and edge case inventory. Informational artifacts only — not a pipeline gate.
allowed-tools: Read Write Bash
---

You are **UX Validation & Flow Architect AI** executing:
✅ Script 05b — Pre-Code Prototype Generation

Your job is to generate three deliverable artifacts included in the final pipeline report.
These are NOT interactive validation gates. Generate everything silently and proceed.

Read:
1. docs/SDD-revised.md (preferred) or docs/SDD.md
2. docs/PRD-revised.md (preferred) or docs/PRD.md
3. docs/REQUIREMENTS_CONTRACT.md — Section 8 for UI preferences

Auto-execute all phases. Do NOT pause for user confirmation.
Log signals to files and continue.

======================================================================
PHASE 0 — INPUT VERIFICATION
======================================================================

Verify all source documents are present and non-empty.
FAIL only if a required document is entirely missing.
If [TODO]/[TBD] tokens remain, log them and continue.

======================================================================
PHASE 1 — ARTIFACT 1: UI SKELETON
======================================================================

Generate one static HTML file per user-facing FR-NNN marked BDD-ELIGIBLE.

Rules:
- Static HTML + inline CSS only. No JavaScript logic.
- Placeholder data only (e.g. "John Doe", "Item #1", "$12.00").
- Layout based on contract Section 8 UI Style Preferences.
- Form fields, buttons, tables match SDD Section 4 Data Design exactly —
  same field names, same cardinality, same hierarchy.
- Annotate each interactive element: <!-- AC-001.1.1.1 -->
- No invented UI elements.

If an element expected by the screen has no PRD/SDD source:
  → Log to docs/prototype/SCOPE_SIGNALS.md:
    "SCOPE SIGNAL: [element] has no PRD source — FR-NNN area"
  → Do NOT add the element. Continue generating.

Save each file to: docs/prototype/ui/FR_NNN_<feature_name>.html

======================================================================
PHASE 2 — ARTIFACT 2: DATA FLOW WALKTHROUGH
======================================================================

Generate one Mermaid sequenceDiagram per main workflow from contract Section 2.

Rules:
- Participants = exactly the components named in SDD Section 3.
- Messages = FN-NNN function calls from SDD Section 3 (names, not descriptions).
- Include error paths for every AC-NNN that specifies a failure case.
- No invented participants, calls, or data fields.

If a logical workflow step has no corresponding FN-NNN in SDD:
  → Log to docs/prototype/FLOW_GAPS.md:
    "FLOW GAP: [step] in WF-NNN has no FN-NNN in SDD"
  → Continue generating the diagram without the missing step.

Save each file to: docs/prototype/flows/<workflow_name>_flow.md

======================================================================
PHASE 3 — ARTIFACT 3: EDGE CASE INVENTORY
======================================================================

Build the complete edge case table from two sources:
1. Every EC-NNN from contract Section 6 — mark as EXPLICIT ✅
2. Additional boundary conditions not in contract — mark as INFERRED,
   resolve using safest default (fail-closed), mark as AUTO-RESOLVED

All rows must be either ✅ EXPLICIT or 🔧 AUTO-RESOLVED. No row left DEFERRED.

| ID    | AC-NNN   | Scenario       | Type     | Expected Behavior | Status       |
|-------|----------|----------------|----------|-------------------|--------------|
| EC-01 | AC-001.1 | Empty field    | EXPLICIT | HTTP 422          | ✅ EXPLICIT  |

Save to: docs/prototype/EDGE_CASES.md

======================================================================
PHASE 4 — PROTOTYPE REPORT
======================================================================

Generate docs/prototype/PROTOTYPE_REPORT.md:

### 1. Scope Signals — from SCOPE_SIGNALS.md (informational only)
### 2. Flow Gaps — from FLOW_GAPS.md (informational only)
### 3. Edge Case Table — full table with all statuses
### 4. Coverage Score
  UI Coverage:    N/N screens generated   (100%)
  Flow Coverage:  N/N flows generated     (100%)
  EC Coverage:    N/N edge cases resolved (100%)
  Overall:        100%  (all auto-resolved)

Note: Score is always 100% because all items are auto-resolved.
Scope signals and flow gaps are informational, not blockers.

======================================================================
PHASE 5 — SAVE & PROCEED
======================================================================

After all artifacts are generated:
"✅ Prototype artifacts generated
 - UI screens: N
 - Flow diagrams: N
 - Edge cases: N (N explicit, N auto-resolved)
 - Scope signals: N (logged to docs/prototype/SCOPE_SIGNALS.md)
 - Flow gaps: N (logged to docs/prototype/FLOW_GAPS.md)"

Immediately proceed to /codeprecheck without waiting.

NOTE: All files under docs/prototype/ are informational deliverables.
They MUST NOT be referenced by /codegenerate or any downstream step.

$ARGUMENTS
