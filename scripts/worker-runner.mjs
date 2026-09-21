#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
performance,
} from 'node:perf_hooks';

import {
spawn,
spawnSync,
} from 'node:child_process';

const RUNNER_VERSION = '0.2.0';

const JOB_ID_RE =
/^[A-Za-z0-9._-]+$/;

const HEARTBEAT_INTERVAL_MS =
5000;

function parseArgs(argv) {
const options = {};

for (
let i = 0;
i < argv.length;
i += 1
) {
const token = argv[i];

if (
  !token.startsWith('--')
) {
  throw new Error(
    `unexpected argument: ${token}`,
  );
}

const key =
  token.slice(2);

const value =
  argv[i + 1];

if (
  value === undefined ||
  value.startsWith('--')
) {
  throw new Error(
    `missing value for --${key}`,
  );
}

options[key] = value;
i += 1;

}

return options;
}

function atomicWriteJson(
filePath,
value,
) {
fs.mkdirSync(
path.dirname(filePath),
{
recursive: true,
},
);

const tmp =
`${filePath}.tmp-` +
`${process.pid}-` +
`${Date.now()}`;

fs.writeFileSync(
tmp,
`${JSON.stringify(
      value,
      null,
      2,
    )}\n`,
'utf8',
);

fs.renameSync(
tmp,
filePath,
);
}

function atomicWriteText(
filePath,
text,
) {
fs.mkdirSync(
path.dirname(filePath),
{
recursive: true,
},
);

const tmp =
`${filePath}.tmp-` +
`${process.pid}-` +
`${Date.now()}`;

fs.writeFileSync(
tmp,
text,
'utf8',
);

fs.renameSync(
tmp,
filePath,
);
}

function readJson(filePath) {
return JSON.parse(
fs.readFileSync(
filePath,
'utf8',
),
);
}

function relativeToRepo(
repoRoot,
absolutePath,
) {
return path
.relative(
repoRoot,
absolutePath,
)
.split(path.sep)
.join('/');
}

function runSync(
command,
args,
options = {},
) {
const result = spawnSync(
command,
args,
{
cwd: options.cwd,
encoding: 'utf8',
windowsHide: true,
shell:
process.platform ===
'win32',
},
);

if (result.error) {
throw new Error(
`failed to execute ` +
`${command}: ` +
`${result.error.message}`,
);
}

return result;
}

function validateLayout(
repoRoot,
jobDir,
runId,
) {
const jobsRoot =
path.resolve(
repoRoot,
'.codex-dsh',
'jobs',
);

const resolvedJob =
path.resolve(jobDir);

const jobId =
path.basename(resolvedJob);

if (
!JOB_ID_RE.test(jobId)
) {
throw new Error(
`invalid job id: ${jobId}`,
);
}

if (
path.dirname(
resolvedJob,
) !== jobsRoot
) {
throw new Error(
'job must be directly ' +
'under ' +
'.codex-dsh/jobs/<job-id>',
);
}

if (
!/^\d+$/.test(runId)
) {
throw new Error(
`invalid run id: ${runId}`,
);
}

return {
jobId,

runDir:
  path.join(
    resolvedJob,
    'runs',
    runId,
  ),

};
}

function sha256File(filePath) {
const hash =
crypto.createHash(
'sha256',
);

hash.update(
fs.readFileSync(
filePath,
),
);

return hash.digest('hex');
}

function contractHashes(
jobDir,
) {
const result = {
taskSha256:
sha256File(
path.join(
jobDir,
'TASK.md',
),
),

acceptanceSha256:
  sha256File(
    path.join(
      jobDir,
      'ACCEPTANCE.md',
    ),
  ),

};

const rework =
path.join(
jobDir,
'REWORK.md',
);

if (
fs.existsSync(rework)
) {
result.reworkSha256 =
sha256File(rework);
}

return result;
}

function sameContract(
before,
after,
) {
return (
before.taskSha256 ===
after.taskSha256 &&

before.acceptanceSha256 ===
  after.acceptanceSha256 &&

(
  before.reworkSha256 ??
  null
) ===
(
  after.reworkSha256 ??
  null
)

);
}

function writeGitSnapshot(
repoRoot,
runDir,
suffix,
) {
const status = runSync(
'git',
[
'status',
'--short',
'--untracked-files=all',
],
{
cwd: repoRoot,
},
);

fs.writeFileSync(
path.join(
runDir,
`git-status-${suffix}.txt`,
),

`${status.stdout || ''}` +
  `${status.stderr || ''}`,

'utf8',

);

const diff = runSync(
'git',
[
'diff',
'--no-ext-diff',
'--binary',
],
{
cwd: repoRoot,
},
);

fs.writeFileSync(
path.join(
runDir,
`git-diff-${suffix}.patch`,
),

`${diff.stdout || ''}` +
  `${diff.stderr || ''}`,

'utf8',

);

const cached = runSync(
'git',
[
'diff',
'--cached',
'--no-ext-diff',
'--binary',
],
{
cwd: repoRoot,
},
);

fs.writeFileSync(
path.join(
runDir,
`git-diff-cached-${suffix}.patch`,
),

`${cached.stdout || ''}` +
  `${cached.stderr || ''}`,

'utf8',

);
}

function buildWorkerInstructions(
repoRoot,
jobDir,
runId,
) {
const taskRel =
relativeToRepo(
repoRoot,
path.join(
jobDir,
'TASK.md',
),
);

const acceptanceRel =
relativeToRepo(
repoRoot,
path.join(
jobDir,
'ACCEPTANCE.md',
),
);

const resultRel =
relativeToRepo(
repoRoot,
path.join(
jobDir,
'RESULT.md',
),
);

const reworkPath =
path.join(
jobDir,
'REWORK.md',
);

const reworkRel =
relativeToRepo(
repoRoot,
reworkPath,
);

const lines = [
'# DSH Worker Instructions',

'',

`Run: ${runId}`,

`Repository: ${repoRoot}`,

'',

(
  'You are the implementation ' +
  'worker. Codex owns ' +
  'architecture, acceptance ' +
  'criteria, and final review.'
),

'',

'Read and follow these files:',

`- ${taskRel}`,

`- ${acceptanceRel}`,

];

if (
fs.existsSync(
reworkPath,
)
) {
lines.push(
`- ${reworkRel}`,
);
}

lines.push(
'',

'Requirements:',

(
  '- Perform the requested ' +
  'implementation in the ' +
  'repository; do not stop ' +
  'at analysis.'
),

(
  '- Preserve unrelated ' +
  'existing user changes.'
),

(
  '- Do not modify TASK.md, ' +
  'ACCEPTANCE.md, or ' +
  'REWORK.md.'
),

(
  '- Do not weaken tests or ' +
  'acceptance criteria.'
),

(
  '- Do not switch branches, ' +
  'push, rebase, or rewrite ' +
  'Git history unless TASK.md ' +
  'explicitly requires it.'
),

(
  '- Run the relevant build, ' +
  'tests, and verification ' +
  'described by the task when ' +
  'practical.'
),

(
  '- Write a concise ' +
  'implementation and ' +
  'verification report to ' +
  `${resultRel}.`
),

(
  '- If something blocks ' +
  'completion, report the ' +
  'blocker accurately in ' +
  'RESULT.md.'
),

'',

);

return (
`${lines.join('\n')}\n`
);
}

function prepareResultForRun(
jobDir,
runDir,
) {
const resultPath =
path.join(
jobDir,
'RESULT.md',
);

if (
!fs.existsSync(
resultPath,
)
) {
return;
}

fs.copyFileSync(
resultPath,

path.join(
  runDir,
  'RESULT-before.md',
),

);

fs.rmSync(resultPath);
}

function startHeartbeat(
runDir,
) {
const heartbeatPath =
path.join(
runDir,
'HEARTBEAT',
);

const write = () => {
try {
fs.writeFileSync(
heartbeatPath,

    `${new Date()
      .toISOString()}\n`,

    'utf8',
  );
} catch {
  // Diagnostic only.
  // Final metadata remains
  // authoritative.
}

};

write();

const timer =
setInterval(
write,
HEARTBEAT_INTERVAL_MS,
);

timer.unref();

return () =>
clearInterval(timer);
}

async function main() {
const options =
parseArgs(
process.argv.slice(2),
);

const repoRoot =
fs.realpathSync(
options.repo ||
process.cwd(),
);

const jobDir =
fs.realpathSync(
options.job,
);

const runId =
String(
options.run ||
'',
);

const {
jobId,
runDir,
} = validateLayout(
repoRoot,
jobDir,
runId,
);

if (
!fs.existsSync(runDir)
) {
throw new Error(
`run directory does not exist: ${runDir}`,
);
}

const metadataPath =
path.join(
runDir,
'metadata.json',
);

const finalPath =
path.join(
runDir,
'final.txt',
);

const reasoningPath =
path.join(
runDir,
'reasoning.log',
);

const donePath =
path.join(
runDir,
'DONE',
);

const resultPath =
path.join(
jobDir,
'RESULT.md',
);

const workerPath =
path.join(
jobDir,
'WORKER.md',
);

const runWorkerPath =
path.join(
runDir,
'WORKER.md',
);

const startPerf =
performance.now();

const startWall =
Date.now();

const startedAt =
new Date(
startWall,
).toISOString();

let metadata =
fs.existsSync(
metadataPath,
)
? readJson(
metadataPath,
)
: {};

const updateMetadata =
(patch) => {
metadata = {
...metadata,
...patch,
};

  atomicWriteJson(
    metadataPath,
    metadata,
  );
};

let stopHeartbeat =
() => {};

let stdoutFd = null;
let stderrFd = null;

try {
for (
const required of [
'TASK.md',
'ACCEPTANCE.md',
]
) {
if (
!fs.existsSync(
path.join(
jobDir,
required,
),
)
) {
throw new Error(
`missing required ` +
`contract file: ` +
`${required}`,
);
}
}

prepareResultForRun(
  jobDir,
  runDir,
);

const contractBefore =
  contractHashes(
    jobDir,
  );

writeGitSnapshot(
  repoRoot,
  runDir,
  'before',
);

const workerText =
  buildWorkerInstructions(
    repoRoot,
    jobDir,
    runId,
  );

atomicWriteText(
  workerPath,
  workerText,
);

atomicWriteText(
  runWorkerPath,
  workerText,
);

updateMetadata({
  runnerVersion:
    RUNNER_VERSION,

  status:
    'RUNNING',

  jobId,

  runnerPid:
    process.pid,

  startedAt:
    metadata.startedAt ||
    startedAt,

  contractBefore,
});

stopHeartbeat =
  startHeartbeat(
    runDir,
  );

stdoutFd =
  fs.openSync(
    finalPath,
    'w',
  );

stderrFd =
  fs.openSync(
    reasoningPath,
    'w',
  );

const workerRel =
  relativeToRepo(
    repoRoot,
    workerPath,
  );

const prompt =
  `Read ${workerRel} ` +
  'and follow it exactly.';

const dshPromise =
  new Promise(
    (
      resolve,
      reject,
    ) => {
      const child =
        spawn(
          'dsh',

          [
            '--profile',
            'headless',
            prompt,
          ],

          {
            cwd: repoRoot,

            stdio: [
              'ignore',
              stdoutFd,
              stderrFd,
            ],

            windowsHide:
              true,

            shell:
              process.platform ===
              'win32',
          },
        );

      child.once('error', reject);
      child.once('spawn', () => {
        try {
          updateMetadata({ dshPid: child.pid });
          atomicWriteText(path.join(runDir, 'READY'), `${new Date().toISOString()}\n`);
        } catch (error) {
          child.kill();
          reject(error);
        }
      });

      child.once(
        'close',
        (
          code,
          signal,
        ) => {
          resolve({
            code,
            signal,
          });
        },
      );
    },
  );

const {
  code,
  signal,
} = await dshPromise;

if (
  stdoutFd !== null
) {
  fs.closeSync(stdoutFd);
  stdoutFd = null;
}

if (
  stderrFd !== null
) {
  fs.closeSync(stderrFd);
  stderrFd = null;
}

if (
  !fs.existsSync(
    resultPath,
  )
) {
  const finalText =
    fs.existsSync(
      finalPath,
    )
      ? fs.readFileSync(
          finalPath,
          'utf8',
        )
      : '';

  const fallback =
    finalText.trim().length >
    0
      ? finalText
      : (
          'DSH completed ' +
          'without writing ' +
          'RESULT.md. ' +
          `Exit code: ${code}; ` +
          `signal: ` +
          `${signal ?? 'none'}.\n`
        );

  atomicWriteText(
    resultPath,

    fallback.endsWith('\n')
      ? fallback
      : `${fallback}\n`,
  );
}

writeGitSnapshot(
  repoRoot,
  runDir,
  'after',
);

const contractAfter =
  contractHashes(
    jobDir,
  );

const contractUnchanged =
  sameContract(
    contractBefore,
    contractAfter,
  );

let status =
  'CANDIDATE_FOR_REVIEW';

if (
  !contractUnchanged
) {
  status =
    'CONTRACT_VIOLATION';
} else if (
  code !== 0
) {
  status =
    'DSH_FAILED';
}

const finishedAt =
  new Date()
    .toISOString();

const elapsedMs =
  performance.now() -
  startPerf;

updateMetadata({
  status,

  dshExitCode:
    code,

  dshSignal:
    signal ?? null,

  finishedAt,

  elapsedMs,

  wallElapsedMs:
    Date.now() -
    startWall,

  contractAfter,

  contractUnchanged,
});

atomicWriteJson(
  donePath,
  {
    status,

    job:
      relativeToRepo(
        repoRoot,
        jobDir,
      ),

    run:
      runId,

    finishedAt,

    elapsedMs,

    dshExitCode:
      code,

    dshSignal:
      signal ?? null,

    contractUnchanged,
  },
);

} catch (error) {
const finishedAt =
new Date()
.toISOString();

const elapsedMs =
  performance.now() -
  startPerf;

try {
  writeGitSnapshot(
    repoRoot,
    runDir,
    'after',
  );
} catch {
  // Preserve the original
  // worker failure.
}

updateMetadata({
  status:
    'DSH_FAILED',

  finishedAt,

  elapsedMs,

  wallElapsedMs:
    Date.now() -
    startWall,

  runnerError:
    error instanceof Error
      ? (
          error.stack ||
          error.message
        )
      : String(error),
});

atomicWriteJson(
  donePath,
  {
    status:
      'DSH_FAILED',

    job:
      relativeToRepo(
        repoRoot,
        jobDir,
      ),

    run:
      runId,

    finishedAt,

    elapsedMs,

    runnerError:
      error instanceof Error
        ? error.message
        : String(error),
  },
);

} finally {
stopHeartbeat();

if (
  stdoutFd !== null
) {
  try {
    fs.closeSync(
      stdoutFd,
    );
  } catch {}
}

if (
  stderrFd !== null
) {
  try {
    fs.closeSync(
      stderrFd,
    );
  } catch {}
}

}
}

main().catch(
(error) => {
process.stderr.write(
'DSH_WORKER_RUNNER_ERROR: ' +
(
error instanceof Error
? (
error.stack ||
error.message
)
: String(error)
) +
'\n',
);

process.exitCode = 1;

},
);
