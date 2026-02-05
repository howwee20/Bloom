---
name: bloom-semantics
description: Enforce Bloom user-language vocabulary in UI and website copy. Use to prevent crypto terminology in UX and keep approved terms consistent across copy and UI strings.
---

# Bloom Semantics

## Scope
- UI strings, landing pages, docs, and marketing copy that user-facing teams touch.
- Prevent crypto jargon from slipping into the user vocabulary.

## Vocabulary map
See references/term-map.md for approved terms and banned words.

## Workflow (always follow)
1) When editing UI or website copy, run the semantics linter.
2) Replace banned words with approved terms.
3) If a new term is needed, update references/term-map.md and rerun the linter.

## How to run the linter
Run:
- python skills/bloom-semantics/scripts/semantics_lint.py

Optional:
- python skills/bloom-semantics/scripts/semantics_lint.py <path> [<path> ...]
