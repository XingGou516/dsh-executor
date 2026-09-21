# dsh-executor

Version: **0.2.0**

A Codex Skill that delegates implementation-heavy work to DeepSeek Harness (DSH).

The intended division of labor is simple:

* **Codex**: architecture, planning, reasoning, acceptance criteria, and final review
* **DSH**: coding, compilation, debugging, testing, and execution

The goal is to keep repetitive implementation loops out of the Codex conversation while keeping Codex responsible for design and verification.

## Requirements

* Codex CLI
* DeepSeek Harness (`dsh`) with the `headless` profile available
* Git
* Node.js, reusing the runtime already required by the standard DSH installation

## Installation

Clone the skill into your Codex skills directory:

```bash
mkdir -p ~/.codex/skills

git clone \
  https://github.com/XingGou516/dsh-executor.git \
  ~/.codex/skills/dsh-executor
```

Restart Codex after installation.

## Usage

Enter any Git repository and start Codex:

```bash
cd your-project
codex
```

Then invoke the skill with a task:

```text
$dsh-executor <task>
```

Codex plans the work and starts DSH as a detached background worker. The turn ends as soon as the worker starts. Later, the user resumes Codex with:

```text
$dsh-executor continue
```

Codex then checks the job status once and either reports that DSH is still running or reviews a completed candidate.

## Job Layout

Each task lives in its own job directory:

```text
.codex-dsh/jobs/<job-id>/
  TASK.md          # self-contained implementation specification
  ACCEPTANCE.md    # independently verifiable acceptance criteria
  REWORK.md        # written by Codex only when review fails
  RESULT.md        # implementation and verification report from DSH
  LATEST           # id of the most recent run
  runs/<run-id>/   # per-run metadata, logs, heartbeats, and Git snapshots
```

`TASK.md` and `ACCEPTANCE.md` are the contract. `TASK.md` must be self-contained because DSH does not see the Codex conversation, and `ACCEPTANCE.md` must be checkable without further context. The worker must not modify either file (or `REWORK.md`).

## Detached Start and Turn End

The worker is launched detached, so it keeps running after the Codex command exits. Detached survival may require explicit approval when the normal sandbox would terminate detached descendants.

Starting a job is asynchronous. When `start` prints:

```text
WORKER_STARTED
```

Codex must immediately end the current turn. It must not wait, sleep, poll, call `status`, re-inspect the worker, tail `reasoning.log`, or continue implementation work. There is no synchronous mode.

## Continue and Review

`$dsh-executor continue` is the only way execution resumes in the Codex conversation; there is no automatic resume.

Codex identifies the relevant job and calls `status` exactly once:

* `RUNNING` means DSH is still working. Report that and end the turn immediately. Do not poll again.
* `CANDIDATE_FOR_REVIEW` means a result exists but is **not** a PASS. Codex reads `RESULT.md`, inspects the metadata and relevant Git diff, rereads `ACCEPTANCE.md`, and independently reruns the important verification before declaring PASS.

Only Codex may declare final PASS, and only after independent verification. DSH completion by itself is never success.

## Rework

If independent verification fails:

1. Codex diagnoses the discrepancy.
2. Codex writes or replaces `REWORK.md`.
3. `TASK.md` and `ACCEPTANCE.md` stay unchanged unless the original specification itself was wrong.
4. Codex starts the same job again with `start`. This creates a new detached run that reads `REWORK.md`; the turn ends immediately after `WORKER_STARTED`.

## Commands

All commands are run with Node.js from anywhere inside the target Git repository, including subdirectories. The executor discovers the root with `git rev-parse --show-toplevel`. Relative `--job` paths resolve from that root, and job contract files must also be created there.

```bash
node <skill-directory>/scripts/executor.mjs doctor
node <skill-directory>/scripts/executor.mjs start  --job .codex-dsh/jobs/<job-id>
node <skill-directory>/scripts/executor.mjs status --job .codex-dsh/jobs/<job-id>
```

For example, if `git rev-parse --show-toplevel` returns `~/go2_fastlio_ws` while your shell is in `~/go2_fastlio_ws/src/foo/bar`, `.codex-dsh/jobs/<job-id>` refers to the directory under `~/go2_fastlio_ws`. You do not need to change directories before calling the executor. If a subdirectory is itself a separate Git repository, Git discovers that repository's root instead.

Running the script with no command, or with `help`, `--help`, or `-h`, prints usage.

### doctor

Checks the local prerequisites (`git` and `dsh --profile headless --help`) and prints a JSON report containing `executorVersion`, `platform`, `arch`, `node`, `git`, and `dsh`. It exits `0` only when both checks succeed, and exits nonzero otherwise.

### start

Validates that the job directory is directly under `.codex-dsh/jobs/<job-id>` and that `TASK.md` and `ACCEPTANCE.md` exist, creates a new run, and launches the detached worker. On success it prints JSON beginning with `"status": "WORKER_STARTED"` plus the job path, run id, runner pid, and metadata path.

### status

Reads the latest run's `metadata.json` and prints a JSON status report. The reported statuses are:

* `STARTING` — the run was created and the worker has not taken over yet.
* `RUNNING` — DSH is executing.
* `CANDIDATE_FOR_REVIEW` — DSH finished and wrote a result for Codex to review.
* `CONTRACT_VIOLATION` — `TASK.md`, `ACCEPTANCE.md`, or `REWORK.md` changed during the run.
* `DSH_FAILED` — DSH or the worker runner failed. If the runner process disappeared while the recorded status was `RUNNING`, the report shows `DSH_FAILED` with `"recordedStatus": "RUNNING"` and `"runnerLost": true`.
* `NO_ACTIVE_JOB` — the job has no runs yet.

## Worker Restrictions

DSH must not:

* modify `TASK.md`, `ACCEPTANCE.md`, or `REWORK.md`
* weaken acceptance criteria
* discard unrelated user changes
* push, rebase, or rewrite Git history
* switch branches unless explicitly required

## Context Efficiency

Codex normally inspects only `TASK.md`, `ACCEPTANCE.md`, `REWORK.md` when present, `RESULT.md`, run metadata, the relevant diff, and verification results. The full `reasoning.log` is loaded only when targeted failure diagnosis requires it.

## License

MIT. See [LICENSE](LICENSE).
