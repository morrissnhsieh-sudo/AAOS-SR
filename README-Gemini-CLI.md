# Gemini CLI Pipeline Template

Converted from Claude Code CLI template.
Place this folder at your project root and run commands via Gemini CLI.

## Structure
```
project-root/
  GEMINI.md                  ← project constitution (read before every session)
  .gemini/
    commands/
      docelicit.toml         ← /docelicit
      docdecompose.toml      ← /docdecompose
      docgenerate.toml       ← /docgenerate
      docvalidate.toml       ← /docvalidate
      docblueprint.toml      ← /docblueprint
      docprototype.toml      ← /docprototype
      codeprecheck.toml      ← /codeprecheck
      codegenerate.toml      ← /codegenerate
      codeverify.toml        ← /codeverify
      codevalidate.toml      ← /codevalidate
      orchestration.toml     ← /orchestration
  docs/
    PRD.md                   ← template PRD
```

## Pipeline
1. `/docelicit`    — Requirements Contract (HUMAN GATE 1)
2. `/docdecompose` — Feature Tree (auto)
3. `/docgenerate`  — PRD + SDD + GEMINI.md (auto)
4. `/docvalidate`  — Cross-validate (auto)
5. `/docblueprint` — Architecture Blueprint (auto)
6. `/docprototype` — UI skeletons + flows (auto)
7. `/codeprecheck` — Environment check (auto)
8. `/codegenerate` — Source + tests (auto)
9. `/codeverify`   — Structural verification (auto)
10. `/codevalidate` — Test execution (auto) → DELIVERY REPORT (HUMAN GATE 2)

Run the full pipeline autonomously: `/orchestration`
