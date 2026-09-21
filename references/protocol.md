# DSH Executor Protocol

This document defines the detailed execution protocol for `dsh-executor`.

Normal successful runs should not require reading this file. It is primarily a reference for implementation, failure diagnosis, and maintenance.

## 1. Architecture

The workflow is:

```text
User
  ↓
Codex
  ↓
TASK.md + ACCEPTANCE.md
  ↓
executor.mjs start
  ↓
worker-runner.mjs detached
  ↓
DSH
  ↓
implementation / build / test / debug
  ↓
RESULT.md
  ↓
User invokes $dsh-executor continue
  ↓
executor.mjs status
  ↓
Codex independent review
  ↓
PASS or REWORK
```

Responsibilities:

```text
Codex
= Architect + Planner + Reviewer

DSH
= Implementation Worker

executor.mjs
= Control and status interface

worker-runner.mjs
= Detached execution lifecycle
```

## 2. User-Facing Lifecycle

### Start

The user invokes:

`$dsh-executor <task>`

Codex creates the job contract and calls:

`node <skill-directory>/scripts/executor.mjs start --job .codex-dsh/jobs/<job-id>`

Expected result:

`WORKER_STARTED`

Codex then ends the turn.

### Continue

The user later invokes:

`$dsh-executor continue`

Codex calls:

`node <skill-directory>/scripts/executor.mjs status --job .codex-dsh/jobs/<job-id>`

Exactly one status query should be made per user invocation.

If the worker is still running, Codex reports that fact and ends the turn.

If the worker has finished, Codex reviews the result.

## 3. Job Layout

A job is stored under:

`.codex-dsh/jobs/<job-id>/`

Typical layout:

```text
.codex-dsh/jobs/<job-id>/
├── TASK.md
├── ACCEPTANCE.md
├── REWORK.md
├── WORKER.md
├── RESULT.md
├── LATEST
└── runs/
    ├── 001/
    │   ├── metadata.json
    │   ├── WORKER.md
    │   ├── final.txt
    │   ├── reasoning.log
    │   ├── worker.pid
    │   ├── HEARTBEAT
    │   ├── DONE
    │   ├── git-status-before.txt
    │   ├── git-status-after.txt
    │   ├── git-diff-before.patch
    │   ├── git-diff-after.patch
    │   ├── git-diff-cached-before.patch
    │   └── git-diff-cached-after.patch
    └── 002/
        └── ...
```

Not every file is required in every run.

`LATEST` identifies the most recent run number.

## 4. Contract Files

### TASK.md

Owned by Codex.

It should describe:

* objective
* relevant repository context
* implementation strategy
* permitted changes
* forbidden changes
* invariants
* expected behavior
* useful build/test commands
* deliverables

It must be self-contained.

DSH does not have access to the Codex conversation.

### ACCEPTANCE.md

Owned by Codex.

It defines the conditions required for final acceptance.

Prefer machine-verifiable checks such as:

* exact output
* build exit code
* tests passing
* required API usage
* numerical bounds
* preserved behavior
* allowed-file constraints
* dependency constraints

DSH must not modify this file.

### REWORK.md

Created by Codex only after failed independent review.

It should contain:

* failed acceptance criterion
* observed behavior
* expected behavior
* required correction
* constraints that must remain unchanged

A rework uses the same job but creates a new numbered run.

## 5. executor.mjs

Supported commands:

```text
doctor
start
status
```

### doctor

Checks core dependencies such as:

* Node.js
* Git
* DSH headless mode

It does not execute a job.

### start

Responsibilities:

1. locate the Git repository
2. validate the job path
3. confirm `TASK.md` and `ACCEPTANCE.md`
4. allocate the next run number
5. create initial metadata
6. spawn `worker-runner.mjs` detached
7. return immediately

Expected output:

```json
{
  "status": "WORKER_STARTED",
  "job": ".codex-dsh/jobs/example",
  "run": "001",
  "runnerPid": 12345
}
```

`start` must not wait for DSH.

### status

Responsibilities:

1. identify the latest run
2. read metadata once
3. optionally verify whether the recorded runner PID is still alive
4. return the effective status

`status` must not:

* sleep
* poll
* wait for process completion
* tail logs

## 6. worker-runner.mjs

The detached runner performs the long-running work.

Responsibilities:

1. capture pre-run Git state

2. hash contract files

3. generate `WORKER.md`

4. launch:

   `dsh --profile headless "<short prompt>"`

5. redirect:

   * DSH stdout → `final.txt`
   * DSH stderr → `reasoning.log`

6. maintain `HEARTBEAT`

7. wait for DSH completion

8. provide `RESULT.md` fallback if needed

9. capture post-run Git state

10. re-hash contract files

11. determine final status

12. write final metadata

13. write `DONE`

The runner contains no model intelligence beyond invoking DSH.

## 7. Status Model

### WORKER_STARTED

Returned only by `start`.

Meaning:

* detached runner was launched
* Codex must stop waiting

This is not an execution result.

### RUNNING

Meaning:

* latest run has not reached a terminal state
* runner still appears active

Codex should report the state and end the turn.

### CANDIDATE_FOR_REVIEW

Meaning:

* DSH exited successfully
* contract files remained unchanged
* execution artifacts are available

This does not mean PASS.

Codex must independently verify the result.

### DSH_FAILED

Meaning may include:

* DSH exited non-zero
* worker runner encountered an exception
* detached worker disappeared before completing
* execution infrastructure failed

Inspect targeted diagnostic evidence.

### CONTRACT_VIOLATION

Meaning:

* one or more protected contract files changed during DSH execution

Protected files include:

* `TASK.md`
* `ACCEPTANCE.md`
* `REWORK.md` when present

The run must not be accepted.

### NO_ACTIVE_JOB

Meaning:

* no usable run exists for the selected job

Do not infer a result that is not recorded.

## 8. Detached Execution Requirement

A detached Node child surviving its parent is not sufficient by itself.

The surrounding Codex execution environment may terminate descendant processes when the tool command exits.

Observed behavior may therefore differ between:

```text
ordinary shell
```

and:

```text
Codex sandbox
```

If the normal sandbox kills detached workers, `start` must be executed through an explicitly approved path that permits background process survival.

Do not silently revert to synchronous execution.

The intended property is:

```text
executor exits
↓
Codex turn can end
↓
worker-runner remains alive
↓
DSH continues independently
```

## 9. Heartbeat

`worker-runner.mjs` periodically updates:

`HEARTBEAT`

The heartbeat exists for diagnostics.

Codex should not poll it during normal operation.

A human may inspect it manually if desired.

## 10. Timing

Elapsed duration and timeout logic must use a monotonic clock.

Suitable examples:

```text
performance.now()
process.hrtime.bigint()
```

Wall-clock timestamps such as ISO dates are suitable for:

* `startedAt`
* `finishedAt`
* human-readable logs

They should not be used as authoritative elapsed-time measurements because system clock adjustments can occur.

## 11. RESULT.md

DSH is instructed to write:

`RESULT.md`

It should summarize:

* implementation changes
* verification performed
* known blockers or limitations

If DSH does not create it, the runner may use DSH's final stdout as a fallback.

`RESULT.md` is an implementation report, not proof of correctness.

## 12. reasoning.log

DSH stderr is stored as:

`reasoning.log`

It may contain a large amount of execution detail.

Do not load it by default.

Use it only for targeted diagnosis when:

* DSH fails
* the worker appears stalled
* RESULT.md is insufficient
* a specific execution error needs investigation

This preserves Codex context and token efficiency.

## 13. Independent Review

For `CANDIDATE_FOR_REVIEW`, Codex should normally inspect:

```text
ACCEPTANCE.md
RESULT.md
metadata.json
git status
git diff --stat
relevant git diff
```

Then independently execute the most important acceptance checks.

Examples:

* rerun tests
* rerun the program
* verify exact stdout/stderr
* inspect required implementation details
* confirm preserved behavior
* confirm no unwanted dependencies
* confirm unrelated changes were not introduced

Only Codex may declare PASS.

## 14. Rework State Machine

If Codex review fails:

```text
CANDIDATE_FOR_REVIEW
        ↓
Codex finds acceptance failure
        ↓
REWORK.md
        ↓
executor start
        ↓
WORKER_STARTED
        ↓
Codex ends turn
        ↓
DSH rework
        ↓
user invokes continue
        ↓
Codex reviews again
```

Do not let Codex bypass DSH by directly implementing the substantial fix.

If repeated runs fail for the same underlying reason, reconsider:

* architecture
* task specification
* acceptance criteria
* environment assumptions

rather than retrying indefinitely.

## 15. Git Safety

DSH should not:

* push
* rebase
* rewrite history
* switch branches unless explicitly required
* discard unrelated working-tree changes
* weaken tests merely to satisfy acceptance

The executor records before/after repository state for review.

`.codex-dsh/` should normally be excluded locally through:

`.git/info/exclude`

rather than modifying the repository's shared `.gitignore`.

## 16. Core Invariants

The protocol should preserve these invariants:

```text
Explicit activation only.

Codex designs.

DSH implements.

Codex does not wait while DSH runs.

User explicitly resumes Codex.

DSH cannot redefine acceptance.

DSH completion is not PASS.

Codex independently verifies.

Only Codex declares PASS.
```
