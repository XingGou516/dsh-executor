---
name: dsh-executor
description: Explicit Codex-to-DSH delegation workflow. Use only when the user invokes $dsh-executor. Codex plans and reviews; DSH implements in a detached worker.
---

# DSH Executor

Use this skill only when the user explicitly invokes:

`$dsh-executor`

Do not activate it implicitly.

## Roles

Codex owns:

* task understanding
* architecture and implementation strategy
* repository inspection needed for planning
* `TASK.md`
* `ACCEPTANCE.md`
* diagnosis
* independent verification
* final PASS / FAIL decision

DSH owns:

* source-code implementation
* editing
* compilation
* routine debugging
* testing
* experiment execution
* implementation iteration

Codex must not directly implement the requested change before delegation.

## Start Workflow

For a new `$dsh-executor` task:

1. Find the repository root with `git rev-parse --show-toplevel` from the current working directory, then inspect enough of the repository to plan the work. Invocation from any repository subdirectory is supported; do not require the shell to be at the root.

2. Create:

   `.codex-dsh/jobs/<job-id>/TASK.md`

   `.codex-dsh/jobs/<job-id>/ACCEPTANCE.md`

   Create these files relative to the discovered repository root, not the current shell directory. Relative `--job` paths are also resolved from that root by the executor.

3. Make `TASK.md` self-contained because DSH does not know the Codex conversation.

4. Make `ACCEPTANCE.md` independently verifiable.

5. Start DSH with:

   `node <skill-directory>/scripts/executor.mjs start --job .codex-dsh/jobs/<job-id>`

The detached worker must be launched through an execution path that allows it to survive after the Codex command exits. Request explicit approval when the normal sandbox would terminate detached descendants.

Do not fall back to synchronous waiting.

## Critical No-Polling Rule

If `start` returns:

`WORKER_STARTED`

Codex must immediately end the current turn.

Do not:

* wait
* sleep
* poll
* call `status`
* inspect the worker repeatedly
* read or tail `reasoning.log`
* continue implementation work

The user will explicitly invoke `$dsh-executor continue` when they want Codex to resume.

## Continue Workflow

When the user invokes:

`$dsh-executor continue`

Locate jobs under the root returned by `git rev-parse --show-toplevel`, even when the current working directory is a subdirectory. Identify the relevant job and call exactly once:

`node <skill-directory>/scripts/executor.mjs status --job .codex-dsh/jobs/<job-id>`

If status is `RUNNING`:

* report that DSH is still running
* immediately end the turn
* do not poll again

If status is `CANDIDATE_FOR_REVIEW`:

* read `RESULT.md`
* inspect metadata and relevant Git diff
* read `ACCEPTANCE.md`
* independently rerun important verification
* declare PASS only if all acceptance criteria are satisfied

If verification fails:

1. diagnose the discrepancy
2. write or replace `REWORK.md`
3. keep `TASK.md` and `ACCEPTANCE.md` unchanged unless the original specification itself was wrong
4. call `start` again on the same job
5. after `WORKER_STARTED`, immediately end the turn

## Worker Restrictions

DSH must not:

* modify `TASK.md`
* modify `ACCEPTANCE.md`
* modify `REWORK.md`
* weaken acceptance criteria
* discard unrelated user changes
* push, rebase, or rewrite Git history
* switch branches unless explicitly required

## Context Efficiency

Normally inspect only:

* `TASK.md`
* `ACCEPTANCE.md`
* `REWORK.md` when present
* `RESULT.md`
* metadata
* relevant diff
* verification results

Do not load the full `reasoning.log` unless targeted failure diagnosis requires it.

Do not read references/protocol.md during normal successful start or continue flows.
Read it only when failure handling or protocol clarification is needed.

## Final Authority

DSH completion means only:

`CANDIDATE_FOR_REVIEW`

Only Codex may declare final PASS after independent verification.

For detailed status semantics, job layout, and execution protocol, see `references/protocol.md`.
