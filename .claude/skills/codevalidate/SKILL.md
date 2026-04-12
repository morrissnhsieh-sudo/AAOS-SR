---
name: codevalidate
description: Phase 9 — Functional Validation, Test Execution, and Auto-Fix Loop. Use after codeverify to run the full test suite, auto-fix failures, check coverage, and produce the final validation summary.
allowed-tools: Read Write Edit Bash Glob Grep
---

Act as a professional AI Software Test Engineer executing
**Script 08 — Functional Validation + Auto-Fix Loop**.

Source documents:
1. docs/PRD-revised.md (preferred) or docs/PRD.md
2. docs/SDD-revised.md (preferred) or docs/SDD.md
3. docs/REQUIREMENTS_CONTRACT.md — Section 8 for automation policy
4. ALL source files under src/
5. ALL test files under tests/
6. GEMINI.md — Sections 4 and 7

Auto-execute all phases. Apply fixes per auto_fix_policy from contract.
Do NOT stop and wait between phases.
Log all decisions. Escalate only on genuine unresolvable failures.

======================================================================
PHASE 1 — AC COVERAGE MAP
======================================================================

For every AC-NNN in PRD Section 5:
1. Map AC-NNN → FN-NNN via traceability table
2. Map FN-NNN → test function in tests/

| AC-NNN | Description | FN-NNN | Test File | Test Exists? | Status |

AUTO-FIX: if any AC lacks a test → generate immediately using:
- PRD AC-NNN for Given/When/Then structure
- SDD FN-NNN spec for exact behavior
- contract Section 6 EC-NNN for edge case behavior
Log: "AUTO-GENERATED test: test_AC_NNN_[scenario]"

Do NOT continue until every AC has a test.

======================================================================
PHASE 2 — TEST EXECUTION
======================================================================

Run the test suite using the test runner defined in GEMINI.md Section 2.
Examples:
- Python: pytest tests/ -v --tb=short
- Node.js: npm test -- --verbose
- Other: use the runner from GEMINI.md

Capture all failures, errors, skips, and warnings.

======================================================================
PHASE 3 — AUTO-FIX LOOP
======================================================================

For each FAIL or ERROR, per auto_fix_policy from contract Section 8:

### Classify root cause:
- Logic defect in src/
- Missing validation (check contract Section 6 EC-NNN)
- Incorrect return shape (check contract Section 5 API CONTRACT)
- Data model mismatch (check contract Section 4)
- Incorrect test setup / missing mock
- Edge case not implemented (check contract Section 6)

### Apply surgical fix:
- Fix ONLY the minimal part of the affected FN-NNN
- Follow SDD exactly — no new behavior
- Maintain parameters, return types, field names
- Keep within 50-line limit
- No new helper functions not in SDD
- No bare except, no removed type hints

### Retest the affected file only.

### Iteration limit (per auto_fix_policy):
- If auto_fix_policy = "auto-fix-silently":
  After 3 failed attempts: log as UNRESOLVED and continue.
  "UNRESOLVED: AC-NNN after 3 attempts — [last error summary]"
- If auto_fix_policy = "pause-and-ask":
  After 3 failed attempts: pause and present to user.

======================================================================
PHASE 4 — FULL SUITE RE-RUN
======================================================================

After all fixes: run the full test suite again.
All previously passing tests must remain passing (no regressions).

======================================================================
PHASE 5 — COVERAGE CHECK
======================================================================

Run coverage report using the test runner's coverage tool.
Per contract Section 8 coverage threshold:
- If below threshold:
  AUTO-FIX: identify uncovered FN-NNN, generate missing tests from SDD spec.
  Re-run coverage.
  Log: "AUTO-GENERATED coverage test: [function] [branch]"

======================================================================
PHASE 6 — STRUCTURAL COMPLIANCE CHECK
======================================================================

Verify all coding standards still hold after fixes:
✅ All functions ≤ 50 lines
✅ No new parameters or fields introduced
✅ No business logic in I/O functions
✅ Specific exception types only
✅ No new imports outside GEMINI.md Section 2
✅ Type hints on all signatures
✅ All docstrings intact

If structural drift detected:
AUTO-FIX and log: "STRUCTURAL-FIX: [description]"

======================================================================
PHASE 7 — FINAL VALIDATION SUMMARY
======================================================================

Output:

"✅ Functional Validation Complete
 - Total AC validated: N/N
 - All tests passing: ✅/❌
 - Coverage: XX% (threshold: N%)
 - 50-line compliance: ✅
 - Structural regression: ✅
 - Auto-fixes applied: N
 - Unresolved items: N

 [If unresolved > 0:]
 UNRESOLVED ITEMS:
 - AC-NNN: [description] — [last error] — Suggested: [action]"

If unresolved items = 0:
"✅ Ready for Delivery"
Return to /orchestration for Gate 2 delivery report.

If unresolved items > 20% of total AC:
Escalate: too many failures likely indicates a contract issue, not a code issue.
Recommend re-running /docelicit.

$ARGUMENTS
