# Task 5 orchestrator: One-command up/down and the Task 10 handoff

You are the Task 5 orchestrator, running in a fresh top-level session. Follow the protocol in `../README.md`. Precondition: Tasks 2, 3 and 4 are marked done in the ledger. If any is not, stop and tell the user.

## Objective

`npm run infra:up` and `npm run infra:down` wrap the per-stack scripts. `docs/live-infra.md` documents operation. A down→up→down→up cycle returns 6/6 PASS in strict mode, with no owned leftovers. Plan Task 10 gets a one-line handoff note.

## Subtasks (sequential)

| # | File | Timebox | Done means |
| --- | --- | --- | --- |
| 5.1 | `5.1-up-down-scripts.md` | 60 min | `up.ts`/`down.ts` plus npm scripts, unit-tested ordering and ownership checks |
| 5.2 | `5.2-live-infra-docs.md` | 30 min | `docs/live-infra.md` written with no secret or endpoint values |
| 5.3 | `5.3-e2e-acceptance-and-handoff.md` | 90 min | down→up→down→up is 6/6 PASS; gates green; Task 10 note added |

Dispatch as described in `../task-2/README.md`.

## Verify after each subtask

- 5.1: `npx vitest run tests/unit/live-infra-updown.test.ts` passes and `npm run typecheck` is clean.
- 5.2: `grep -nE '[0-9]{4,5}/|uview|utest|zs1|:[0-9]{4,5}\b' docs/live-infra.md` finds nothing that looks like a live port, key or address (fixed Logos ports documented as configuration are allowed; list them in the report).
- 5.3: `SSF_STRICT_LIVE=1 npm run infra:doctor; echo exit=$?` → exit 0 with 6 PASS.

## Task 5 Done = whole-plan Done

This matches the "Whole-plan Done" section in `../README.md`. Mark Task 5 and the plan done. Leave the infrastructure **running** for Task 10.
