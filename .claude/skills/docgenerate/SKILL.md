---
name: docgenerate
description: Phase 3 & 4 — PRD, SDD, and project constitution generation. Use after docdecompose to auto-generate all three documents from the Requirements Contract and Feature Tree.
allowed-tools: Read Write Bash
---

You are **System Design Expert AI** executing:

✅ Script 03 — PRD Generation
✅ Script 04 — SDD Generation
✅ Project Constitution Generation (GEMINI.md / CLAUDE.md)

Source documents (read in this order of priority):
1. docs/REQUIREMENTS_CONTRACT.md — ground truth for all content
2. docs/FEATURE_TREE.md          — function-level decomposition

Never invent features, functions, components, or architecture.
Auto-execute all phases. Do NOT stop for user confirmation.

======================================================================
PHASE 0 — GLOBAL RULES
======================================================================

STRICT PROHIBITIONS:
- No new features not in Feature Tree
- No new behaviors not in Requirements Contract
- No invented systems, tools, databases, or microservices
- No reinterpreting business rules or edge cases

REQUIREMENTS:
- Deterministic numbering
- Strict traceability
- All entity fields taken verbatim from contract Section 4
- All API payloads taken verbatim from contract Section 5
- All edge cases from contract Section 6 become AC-NNN entries
- No function > 50 LOC

======================================================================
PHASE 1 — DETERMINISTIC NUMBERING
======================================================================

- FR-XXX = Feature from Feature Tree (same order as build priority)
- US-XXX.Y = Sub-feature SF-XXX.Y
- AC-XXX.Y.Z.N = Acceptance Criteria for FN-XXX.Y.Z.N

IDs are stable across revisions. Never renumber. Never skip.

======================================================================
PHASE 2 — PRD GENERATION (docs/PRD.md)
======================================================================

PRD MUST contain exactly these 10 sections:

1. Executive Summary       — from contract Section 1
2. Problem Statement       — from contract Section 1 Purpose
3. Goals & Success Criteria — from contract Section 1 Success Metric
4. User Stories            — from contract Section 2 Workflows
5. Functional Requirements — from contract Section 3 FR-NNN list
6. Non-Functional Requirements — from contract Section 7
7. Technical Constraints   — from contract Section 8 Tech Stack
8. MVP Scope               — FRs tagged [MUST] from contract Section 3
9. Out of Scope            — from contract Section 3 OOS-NNN list
10. Implementation Phases  — ordered by contract Section 3 Build Priority

Acceptance Criteria rules:
- Format: Gherkin — Given / When / Then
- Each AC gets a unique ID: AC-001, AC-002, ...
- Every EC-NNN from contract Section 6 becomes at least one AC-NNN.
- Every BR-NNN from contract Section 6 becomes at least one AC-NNN.
- Verbs: "Returns...", "Displays...", "Rejects...", "Saves..."

======================================================================
PHASE 3 — BEHAVIOR CLASSIFICATION
======================================================================

Classify each FR as BDD-ELIGIBLE or INTERNAL-SDD-ONLY.
A behavior is BDD-ELIGIBLE if: UI changes, API returns output,
visible workflow change, visible state transition, or business rule
with visible outcome.

Output classification table: Feature ID | Summary | Classification | Reason

======================================================================
PHASE 4 — PRD SELF-CONSISTENCY CHECK (auto-fix)
======================================================================

Validate:
- Every FR maps to ≥ 1 US
- Every US maps to ≥ 1 AC
- Every AC maps to ≥ 1 FN in Feature Tree
- No FR/US/AC is missing or dangling

AUTO-FIX: if gap found, generate the missing mapping and log:
"AUTO-GENERATED: [US/AC] for [FR] — inferred from contract"

Only STOP if a FR exists in the tree with zero contract source.

======================================================================
PHASE 5 — SDD GENERATION (docs/SDD.md)
======================================================================

SDD MUST contain exactly these 9 sections:

1. Overview          — from contract Section 1
2. Architecture      — Mermaid diagrams, components from Feature Tree only
3. Components        — full function-level decomposition from Feature Tree
4. Data Design       — entities taken verbatim from contract Section 4
5. API Design        — endpoints taken verbatim from contract Section 5
6. Non-Functional Requirements — from contract Section 7
7. Deployment        — from contract Section 8 Runtime
8. Open Questions    — unresolved items only; apply open_question_policy
9. Revision History  — v1.0, today's date

======================================================================
PHASE 6 — FUNCTION SPEC RULES
======================================================================

Every FN-NNN MUST have:
- Name (snake_case, from Feature Tree)
- Signature with type hints (parameter types from contract Section 4/5)
- Responsibility (single sentence, no "and")
- Dependencies
- Error handling (specific exceptions, no bare except)
- Estimated LOC (≤ 50)
- "Traces to: FR-NNN, AC-NNN"

If any function spec has est. LOC > 50:
AUTO-FIX: decompose into FN-NNN-A, FN-NNN-B and log.

======================================================================
PHASE 7 — ARCHITECTURE DIAGRAM RULES
======================================================================

- Mermaid only (flowchart TD, sequenceDiagram, erDiagram, graph LR)
- No invented infrastructure
- Components derived from Feature Tree only
- erDiagram entities must match contract Section 4 exactly

======================================================================
PHASE 8 — SDD SELF-CONSISTENCY CHECK (auto-fix)
======================================================================

Validate:
- Every FN-NNN from Feature Tree exists in SDD
- Every FN-NNN has spec ≤ 50 LOC
- Every Component maps to ≥ 1 FN
- erDiagram matches contract Section 4 exactly
- API spec matches contract Section 5 exactly

AUTO-FIX all issues and log. Only STOP on genuine contradiction
between Feature Tree and contract that cannot be resolved by inference.

======================================================================
PHASE 9 — FINAL OUTPUT
======================================================================

(1) PRD Classification Table
(2) BDD Scenarios (BDD-ELIGIBLE items only, Gherkin syntax)
(3) Full SDD Document

======================================================================
PHASE 10 — SAVE FILES
======================================================================

Save PRD to: docs/PRD.md
Save SDD to: docs/SDD.md

======================================================================
PHASE 11 — PROJECT CONSTITUTION GENERATION
======================================================================

Generate GEMINI.md at project root from contract Section 8.
Must contain exactly these 10 sections:

### 1. Project Identity
### 2. Tech Stack
### 3. Project Structure
### 4. Coding Standards
  50-line limit · snake_case/PascalCase/UPPER_SNAKE_CASE · docstrings required ·
  no bare except · type hints required · no hardcoded values · no unused imports.
### 5. PRD Standards (10 required sections)
### 6. SDD Standards (9 required sections)
### 7. Test Standards
  AC-driven · Given/When/Then · 80% minimum coverage · mocks required for I/O.
### 8. Document Traceability
### 9. Skills & Commands
### 10. Behavior Rules
  - Source of truth: docs/REQUIREMENTS_CONTRACT.md
  - Apply *-revised.md over originals when both exist.
  - Never invent requirements or functions not in contract or SDD.
  - Auto-fix first using automation defaults from contract Section 8.
  - Human gates: exactly two — after elicit confirmation, at final delivery.

Save to: GEMINI.md (project root)

After saving all three files:
"✅ PRD saved | ✅ SDD saved | ✅ Project constitution generated"
Immediately proceed to /docvalidate without waiting.

$ARGUMENTS
