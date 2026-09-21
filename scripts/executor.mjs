#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const EXECUTOR_VERSION = '0.2.0';
const JOB_ID_RE = /^[A-Za-z0-9._-]+$/;

function die(message, code = 1) {
console.error(`DSH_EXECUTOR_ERROR: ${message}`);
process.exit(code);
}

function printJson(value) {
process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
const [command, ...rest] = argv;
const options = {};

for (let i = 0; i < rest.length; i += 1) {
const token = rest[i];

if (!token.startsWith('--')) {
  die(`unexpected argument: ${token}`);
}

const key = token.slice(2);
const value = rest[i + 1];

if (value === undefined || value.startsWith('--')) {
  die(`missing value for --${key}`);
}

options[key] = value;
i += 1;

}

return { command, options };
}

function runSync(command, args, options = {}) {
const result = spawnSync(command, args, {
cwd: options.cwd,
encoding: 'utf8',
windowsHide: true,
shell: process.platform === 'win32',
});

if (result.error) {
throw new Error(
`failed to execute ${command}: ${result.error.message}`,
);
}

return result;
}

function gitRoot(cwd = process.cwd()) {
const result = runSync(
'git',
['rev-parse', '--show-toplevel'],
{ cwd },
);

if (result.status !== 0) {
throw new Error(
(result.stderr || 'not inside a Git repository').trim(),
);
}

return fs.realpathSync(result.stdout.trim());
}

function relativeToRepo(repoRoot, absolutePath) {
return path
.relative(repoRoot, absolutePath)
.split(path.sep)
.join('/');
}

function resolveJob(repoRoot, jobArg) {
if (!jobArg) {
throw new Error('--job is required');
}

const jobsRoot = path.join(
repoRoot,
'.codex-dsh',
'jobs',
);

const resolved = path.resolve(repoRoot, jobArg);
const parent = path.dirname(resolved);
const jobId = path.basename(resolved);

if (!JOB_ID_RE.test(jobId)) {
throw new Error(`invalid job id: ${jobId}`);
}

if (
path.resolve(parent) !== path.resolve(jobsRoot)
) {
throw new Error(
'job must be directly under .codex-dsh/jobs/<job-id>',
);
}

return {
jobId,
jobDir: resolved,
jobsRoot,
};
}

function requireContract(jobDir) {
const task = path.join(jobDir, 'TASK.md');
const acceptance = path.join(
jobDir,
'ACCEPTANCE.md',
);

for (const file of [task, acceptance]) {
if (
!fs.existsSync(file) ||
!fs.statSync(file).isFile()
) {
throw new Error(
`missing required contract file: ${file}`,
);
}
}
}

function ensureInfoExclude(repoRoot) {
try {
const gitDirResult = runSync(
'git',
['rev-parse', '--git-dir'],
{ cwd: repoRoot },
);

if (gitDirResult.status !== 0) {
  return;
}

let gitDir = gitDirResult.stdout.trim();

if (!path.isAbsolute(gitDir)) {
  gitDir = path.resolve(repoRoot, gitDir);
}

const infoDir = path.join(gitDir, 'info');
const excludePath = path.join(
  infoDir,
  'exclude',
);

fs.mkdirSync(infoDir, {
  recursive: true,
});

const existing = fs.existsSync(excludePath)
  ? fs.readFileSync(excludePath, 'utf8')
  : '';

const lines = existing
  .split(/\r?\n/)
  .map((line) => line.trim());

if (!lines.includes('.codex-dsh/')) {
  const prefix =
    existing.length > 0 &&
    !existing.endsWith('\n')
      ? '\n'
      : '';

  fs.appendFileSync(
    excludePath,
    `${prefix}.codex-dsh/\n`,
  );
}

} catch {
// Best effort only.
// Failure to update .git/info/exclude
// must not block execution.
}
}

function nextRunId(jobDir) {
const runsDir = path.join(jobDir, 'runs');

fs.mkdirSync(runsDir, {
recursive: true,
});

let max = 0;

for (
const entry of fs.readdirSync(runsDir, {
withFileTypes: true,
})
) {
if (
!entry.isDirectory() ||
!/^\d+$/.test(entry.name)
) {
continue;
}

max = Math.max(
  max,
  Number.parseInt(entry.name, 10),
);

}

return String(max + 1).padStart(3, '0');
}

function atomicWriteJson(filePath, value) {
fs.mkdirSync(path.dirname(filePath), {
recursive: true,
});

const tmp =
`${filePath}.tmp-${process.pid}-${Date.now()}`;

fs.writeFileSync(
tmp,
`${JSON.stringify(value, null, 2)}\n`,
'utf8',
);

fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
return JSON.parse(
fs.readFileSync(filePath, 'utf8'),
);
}

function latestRunId(jobDir) {
const latestPath = path.join(
jobDir,
'LATEST',
);

if (fs.existsSync(latestPath)) {
const value = fs
.readFileSync(latestPath, 'utf8')
.trim();

if (/^\d+$/.test(value)) {
  return value.padStart(3, '0');
}

}

const runsDir = path.join(jobDir, 'runs');

if (!fs.existsSync(runsDir)) {
return null;
}

const ids = fs
.readdirSync(runsDir, {
withFileTypes: true,
})
.filter(
(entry) =>
entry.isDirectory() &&
/^\d+$/.test(entry.name),
)
.map((entry) =>
Number.parseInt(entry.name, 10),
);

if (ids.length === 0) {
return null;
}

return String(
Math.max(...ids),
).padStart(3, '0');
}

function doctor() {
const git = {
ok: false,
version: null,
error: null,
};

const dsh = {
ok: false,
headless: false,
error: null,
};

try {
const result = runSync(
'git',
['--version'],
);

git.ok = result.status === 0;
git.version =
  (
    result.stdout ||
    result.stderr ||
    ''
  ).trim() || null;

if (!git.ok) {
  git.error =
    `exit code ${result.status}`;
}

} catch (error) {
git.error = error.message;
}

try {
const result = runSync(
'dsh',
[
'--profile',
'headless',
'--help',
],
);

dsh.ok = result.status === 0;

const text =
  `${result.stdout || ''}\n` +
  `${result.stderr || ''}`;

dsh.headless =
  /headless/i.test(text) ||
  dsh.ok;

if (!dsh.ok) {
  dsh.error =
    `exit code ${result.status}`;
}

} catch (error) {
dsh.error = error.message;
}

printJson({
executorVersion:
EXECUTOR_VERSION,
platform: process.platform,
arch: process.arch,
node: process.version,
git,
dsh,
});

process.exitCode =
git.ok && dsh.ok ? 0 : 1;
}

async function start(jobArg) {
const repoRoot = gitRoot();

const {
jobId,
jobDir,
} = resolveJob(
repoRoot,
jobArg,
);

requireContract(jobDir);
ensureInfoExclude(repoRoot);

const runId =
nextRunId(jobDir);

const runDir = path.join(
jobDir,
'runs',
runId,
);

fs.mkdirSync(runDir, {
recursive: false,
});

fs.writeFileSync(
path.join(jobDir, 'LATEST'),
`${runId}\n`,
'utf8',
);

const startedAt =
new Date().toISOString();

const metadataPath =
path.join(
runDir,
'metadata.json',
);

const initialMetadata = {
executorVersion:
EXECUTOR_VERSION,

status: 'STARTING',

job:
  relativeToRepo(
    repoRoot,
    jobDir,
  ),

jobId,
run: runId,
repoRoot,
startedAt,

runnerPid: null,
dshPid: null,

dshExitCode: null,
dshSignal: null,

finishedAt: null,
elapsedMs: null,

contractUnchanged: null,

files: {
  result:
    relativeToRepo(
      repoRoot,
      path.join(
        jobDir,
        'RESULT.md',
      ),
    ),

  metadata:
    relativeToRepo(
      repoRoot,
      metadataPath,
    ),

  reasoningLog:
    relativeToRepo(
      repoRoot,
      path.join(
        runDir,
        'reasoning.log',
      ),
    ),

  final:
    relativeToRepo(
      repoRoot,
      path.join(
        runDir,
        'final.txt',
      ),
    ),

  heartbeat:
    relativeToRepo(
      repoRoot,
      path.join(
        runDir,
        'HEARTBEAT',
      ),
    ),

  done:
    relativeToRepo(
      repoRoot,
      path.join(
        runDir,
        'DONE',
      ),
    ),
},

};

atomicWriteJson(
metadataPath,
initialMetadata,
);

const here = path.dirname(
fileURLToPath(import.meta.url),
);

const runnerPath = path.join(
here,
'worker-runner.mjs',
);

if (
!fs.existsSync(runnerPath)
) {
throw new Error(
`worker runner not found: ${runnerPath}`,
);
}

const runnerLogFd = fs.openSync(path.join(runDir, 'runner.log'), 'a');
const child = spawn(
process.execPath,
[
runnerPath,
'--repo',
repoRoot,
'--job',
jobDir,
'--run',
runId,
],
{
cwd: repoRoot,
detached: true,
stdio: ['ignore', runnerLogFd, runnerLogFd],
windowsHide: true,
},
);

fs.closeSync(runnerLogFd);
let startupError;
child.once('error', (error) => { startupError = error; });
child.once('exit', (code, signal) => {
  startupError = new Error(`worker runner exited: code=${code}, signal=${signal}`);
});

try {
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(path.join(runDir, 'READY'))) {
    if (fs.existsSync(path.join(runDir, 'DONE'))) {
      throw new Error('worker failed before readiness; see metadata.json and runner.log');
    }
    if (startupError) throw startupError;
    if (performance.now() >= deadline) {
      throw new Error('worker readiness timed out; see runner.log');
    }
    await delay(20);
  }
} catch (error) {
  // Do not kill a runner that may already be executing DSH on timeout.
  // Preserve runner-owned metadata and expose the launch failure separately.
  fs.writeFileSync(path.join(runDir, 'START_FAILED'), `${error.stack || error}\n`);
  throw error;
} finally {
  child.unref();
}

fs.writeFileSync(
path.join(
runDir,
'worker.pid',
),
`${child.pid}\n`,
'utf8',
);

printJson({
status: 'WORKER_STARTED',

job:
  relativeToRepo(
    repoRoot,
    jobDir,
  ),

run: runId,
runnerPid: child.pid,

metadata:
  relativeToRepo(
    repoRoot,
    metadataPath,
  ),

});
}

function isProcessAlive(pid) {
if (
!Number.isInteger(pid) ||
pid <= 0
) {
return false;
}

try {
process.kill(pid, 0);
return true;
} catch (error) {
return (
error &&
error.code === 'EPERM'
);
}
}

function status(jobArg) {
const repoRoot = gitRoot();

const { jobDir } =
resolveJob(
repoRoot,
jobArg,
);

const runId =
latestRunId(jobDir);

if (!runId) {
printJson({
status:
'NO_ACTIVE_JOB',

  job:
    relativeToRepo(
      repoRoot,
      jobDir,
    ),
});

return;

}

const runDir = path.join(
jobDir,
'runs',
runId,
);

const metadataPath =
path.join(
runDir,
'metadata.json',
);

if (
!fs.existsSync(metadataPath)
) {
throw new Error(
`latest run has no metadata: ${metadataPath}`,
);
}

const metadata =
readJson(metadataPath);

const heartbeatPath =
path.join(
runDir,
'HEARTBEAT',
);

let heartbeatAgeMs = null;

if (
fs.existsSync(
heartbeatPath,
)
) {
heartbeatAgeMs =
Math.max(
0,
Date.now() -
fs.statSync(
heartbeatPath,
).mtimeMs,
);
}

const runnerLost =
metadata.status ===
'RUNNING' &&
metadata.runnerPid &&
!isProcessAlive(
metadata.runnerPid,
);

const effectiveStatus =
runnerLost
? 'DSH_FAILED'
: metadata.status;

printJson({
status:
effectiveStatus,

recordedStatus:
  runnerLost
    ? metadata.status
    : undefined,

runnerLost:
  Boolean(runnerLost),

job:
  relativeToRepo(
    repoRoot,
    jobDir,
  ),

run: runId,

runnerPid:
  metadata.runnerPid ??
  null,

dshPid:
  metadata.dshPid ??
  null,

startedAt:
  metadata.startedAt ??
  null,

finishedAt:
  metadata.finishedAt ??
  null,

elapsedMs:
  metadata.elapsedMs ??
  null,

heartbeatAgeMs,

dshExitCode:
  metadata.dshExitCode ??
  null,

dshSignal:
  metadata.dshSignal ??
  null,

contractUnchanged:
  metadata
    .contractUnchanged ??
  null,

result:
  metadata.files?.result ??
  relativeToRepo(
    repoRoot,
    path.join(
      jobDir,
      'RESULT.md',
    ),
  ),

metadata:
  relativeToRepo(
    repoRoot,
    metadataPath,
  ),

reasoningLog:
  metadata.files
    ?.reasoningLog ??
  relativeToRepo(
    repoRoot,
    path.join(
      runDir,
      'reasoning.log',
    ),
  ),

});
}

function usage() {
process.stdout.write(
`dsh-executor ${EXECUTOR_VERSION}\n\n`,
);

process.stdout.write(
'Usage:\n',
);

process.stdout.write(
'  node executor.mjs doctor\n',
);

process.stdout.write(
'  node executor.mjs start  --job .codex-dsh/jobs/<job-id>\n',
);

process.stdout.write(
'  node executor.mjs status --job .codex-dsh/jobs/<job-id>\n',
);
}

try {
const {
command,
options,
} = parseArgs(
process.argv.slice(2),
);

if (
!command ||
command === 'help' ||
command === '--help' ||
command === '-h'
) {
usage();
} else if (
command === 'doctor'
) {
doctor();
} else if (
command === 'start'
) {
await start(options.job);
} else if (
command === 'status'
) {
status(options.job);
} else {
die(
`unknown command: ${command}`,
);
}
} catch (error) {
die(
error instanceof Error
? error.message
: String(error),
);
}
