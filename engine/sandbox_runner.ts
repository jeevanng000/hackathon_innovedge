import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SandboxIsolationInfo } from '../src/types/autopatch.ts';

export interface SandboxConfig {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  memoryMb: number;
  nodeOldSpaceMb: number;
  cpuSeconds: number;
  compileCpuSeconds: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxOpenFiles: number;
  maxProcesses: number;
  maxConcurrentExecutions: number;
  allowUntrustedExec: boolean;
}

function parsePositiveNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function loadSandboxConfig(): SandboxConfig {
  const allowRaw = (process.env.SANDBOX_ALLOW_UNTRUSTED_EXEC ?? 'true').trim().toLowerCase();
  return {
    defaultTimeoutSeconds: parsePositiveNumber(process.env.SANDBOX_TIMEOUT_SECONDS, 5.0, 0.5, 30.0),
    maxTimeoutSeconds: parsePositiveNumber(process.env.SANDBOX_MAX_TIMEOUT_SECONDS, 30.0, 1.0, 60.0),
    memoryMb: Math.round(parsePositiveNumber(process.env.SANDBOX_MEMORY_MB, 512, 64, 2048)),
    nodeOldSpaceMb: Math.round(parsePositiveNumber(process.env.SANDBOX_NODE_HEAP_MB, 512, 64, 2048)),
    cpuSeconds: Math.round(parsePositiveNumber(process.env.SANDBOX_CPU_SECONDS, 10, 1, 60)),
    compileCpuSeconds: Math.round(parsePositiveNumber(process.env.SANDBOX_COMPILE_CPU_SECONDS, 15, 2, 60)),
    maxOutputBytes: Math.round(parsePositiveNumber(process.env.SANDBOX_MAX_OUTPUT_BYTES, 1048576, 4096, 10485760)),
    maxFileBytes: Math.round(parsePositiveNumber(process.env.SANDBOX_MAX_FILE_BYTES, 25 * 1024 * 1024, 1024 * 1024, 100 * 1024 * 1024)),
    maxOpenFiles: Math.round(parsePositiveNumber(process.env.SANDBOX_MAX_OPEN_FILES, 128, 32, 1024)),
    maxProcesses: Math.round(parsePositiveNumber(process.env.SANDBOX_MAX_PROCESSES, 64, 8, 256)),
    maxConcurrentExecutions: Math.round(parsePositiveNumber(process.env.MAX_CONCURRENT_EXECUTIONS, 16, 1, 64)),
    allowUntrustedExec: allowRaw !== 'false' && allowRaw !== '0' && allowRaw !== 'no',
  };
}

export interface SandboxExecOptions {
  cwd: string;
  timeoutMs: number;
  mode?: 'run' | 'compile' | 'node';
  stdinData?: string;
  maxOutputBytes?: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  executionUnavailable?: boolean;
  unavailableReason?: string;
}

interface ProbeState {
  probed: boolean;
  canDropToNobody: boolean;
  hasNamespaceIsolation: boolean;
  hasPrlimit: boolean;
  nobodyUid: number;
  nobodyGid: number;
}

const NOBODY_UID = 65534;
const NOBODY_GID = 65534;

let probeCache: ProbeState | null = null;

function probeHostIsolation(): ProbeState {
  if (probeCache) return probeCache;

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  let canDropToNobody = false;
  let hasNamespaceIsolation = false;
  let hasPrlimit = false;

  const prlimitCheck = spawnSync('prlimit', ['--cpu=1', '--', 'true'], {
    encoding: 'utf-8',
    timeout: 2000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  hasPrlimit = prlimitCheck.status === 0;

  if (isRoot) {
    const nobodyNsCheck = spawnSync(
      'unshare',
      ['--user', '--net', '--pid', '--fork', '--mount-proc', 'true'],
      {
        uid: NOBODY_UID,
        gid: NOBODY_GID,
        encoding: 'utf-8',
        timeout: 2000,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      }
    );
    if (nobodyNsCheck.status === 0) {
      canDropToNobody = true;
      hasNamespaceIsolation = true;
    }
  }

  if (!hasNamespaceIsolation) {
    const selfNsCheck = spawnSync(
      'unshare',
      ['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', 'true'],
      {
        encoding: 'utf-8',
        timeout: 2000,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      }
    );
    hasNamespaceIsolation = selfNsCheck.status === 0;
  }

  probeCache = {
    probed: true,
    canDropToNobody,
    hasNamespaceIsolation,
    hasPrlimit,
    nobodyUid: NOBODY_UID,
    nobodyGid: NOBODY_GID,
  };
  return probeCache;
}

export function getSandboxIsolationInfo(): SandboxIsolationInfo {
  const cfg = loadSandboxConfig();
  const probe = probeHostIsolation();

  if (!cfg.allowUntrustedExec) {
    return {
      level: 'unavailable',
      isolatedUser: false,
      networkIsolated: false,
      pidIsolated: false,
      limitsApplied: [],
      limitations: [
        'Untrusted code execution is explicitly disabled by SANDBOX_ALLOW_UNTRUSTED_EXEC=false.',
        'Static analysis remains active; dynamic sandbox tests are blocked.',
      ],
    };
  }

  if (probe.hasNamespaceIsolation) {
    const limits: string[] = [
      `wall-clock timeout (${cfg.defaultTimeoutSeconds}s default / ${cfg.maxTimeoutSeconds}s max)`,
      `process-group SIGKILL tree termination`,
      `stdout/stderr cap (${Math.round(cfg.maxOutputBytes / 1024)} KB)`,
      `stripped environment (zero host secrets / no GEMINI_API_KEY)`,
      `concurrency cap (${cfg.maxConcurrentExecutions} active executions)`,
    ];
    if (probe.hasPrlimit) {
      limits.push(
        `RLIMIT_CPU=${cfg.cpuSeconds}s`,
        `RLIMIT_AS=${cfg.memoryMb}MB (native/Python/Bash) / V8 --max-old-space-size=${cfg.nodeOldSpaceMb}MB`,
        `RLIMIT_FSIZE=${Math.round(cfg.maxFileBytes / (1024 * 1024))}MB`,
        `RLIMIT_NOFILE=${cfg.maxOpenFiles}`,
        `RLIMIT_NPROC=${cfg.maxProcesses}`
      );
    }
    const limitations: string[] = [
      'Docker/Podman/Firecracker per-job containers are not installed in this cloud workspace.',
      'Host root filesystem is not mounted read-only or chroot-jailed; world-readable system files remain readable by UID nobody.',
      'Production deployment requires rootless Docker/Podman/gVisor per-job containers with --read-only, --cap-drop=ALL, --security-opt=no-new-privileges, and seccomp.',
    ];
    if (!probe.canDropToNobody) {
      limitations.unshift('Running inside unprivileged user namespace without root-to-nobody UID transition.');
    }
    return {
      level: 'linux-namespace-unprivileged',
      isolatedUser: probe.canDropToNobody,
      networkIsolated: true,
      pidIsolated: true,
      limitsApplied: limits,
      limitations,
    };
  }

  return {
    level: 'unavailable',
    isolatedUser: false,
    networkIsolated: false,
    pidIsolated: false,
    limitsApplied: [],
    limitations: [
      'Neither Docker/Podman nor Linux network/PID namespaces (unshare) are available in this host environment.',
      'Fail-closed policy active: untrusted user code execution is blocked rather than running with unrestricted host permissions.',
      'Provision rootless Docker/Podman, nsjail, bubblewrap, or an isolated remote sandbox worker for dynamic verification.',
    ],
  };
}

export function isSandboxExecutionAvailable(): boolean {
  const info = getSandboxIsolationInfo();
  return info.level === 'linux-namespace-unprivileged';
}

class ConcurrencySemaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  getActiveCount(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  async acquire(maxConcurrent: number, maxWaitMs = 4000): Promise<boolean> {
    if (this.active < maxConcurrent) {
      this.active++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.queue.indexOf(grant);
        if (idx >= 0) this.queue.splice(idx, 1);
        resolve(false);
      }, maxWaitMs);

      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active++;
        resolve(true);
      };
      this.queue.push(grant);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export const executionSemaphore = new ConcurrencySemaphore();

/**
 * Creates a dedicated isolated temporary directory accessible by the sandbox user (`nobody`).
 */
export async function createSandboxTempDir(prefix: string): Promise<string> {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '_') || 'autopatch_sbx_';
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), safePrefix));
  const probe = probeHostIsolation();
  if (probe.canDropToNobody) {
    await fs.chown(tmpdir, probe.nobodyUid, probe.nobodyGid);
    await fs.chmod(tmpdir, 0o700);
  } else {
    await fs.chmod(tmpdir, 0o755);
  }
  return tmpdir;
}

/**
 * Writes a file inside a sandbox temp directory and adjusts ownership to `nobody` when applicable.
 */
export async function writeSandboxFile(
  tmpdir: string,
  relFilename: string,
  content: string
): Promise<string> {
  const safeBase = path.basename(relFilename);
  if (!safeBase || safeBase === '.' || safeBase === '..' || safeBase.includes('\0')) {
    throw new Error('Disallowed sandbox filename.');
  }
  const fullPath = path.join(tmpdir, safeBase);
  const probe = probeHostIsolation();
  await fs.writeFile(fullPath, content, {
    encoding: 'utf-8',
    mode: probe.canDropToNobody ? 0o600 : 0o644,
  });
  if (probe.canDropToNobody) {
    await fs.chown(fullPath, probe.nobodyUid, probe.nobodyGid).catch(() => {});
  }
  return fullPath;
}

/**
 * Executes a command inside an isolated Linux namespace (network + PID + user)
 * with UID nobody (65534), prlimit kernel limits, stripped environment (zero secrets),
 * bounded stdout/stderr, concurrency throttling, and process-group SIGKILL on timeout.
 *
 * Fails closed when OS isolation is unavailable.
 */
const ALLOWED_SANDBOX_BINARIES = new Set(['python3', 'node', 'gcc', 'g++', 'bash']);

function isInsideTmpdir(dirPath: string): boolean {
  const resolvedTmp = path.resolve(os.tmpdir());
  const resolvedDir = path.resolve(dirPath);
  return resolvedDir.startsWith(resolvedTmp + path.sep);
}

function isAllowedSandboxCommand(cmd: string, cwd: string): boolean {
  if (!cmd || cmd.includes('\0')) return false;
  if (ALLOWED_SANDBOX_BINARIES.has(cmd)) return true;
  // Allow compiled native test binary strictly inside the sandbox temp directory
  const expectedCompiledBin = path.join(path.resolve(cwd), 'sandbox_runner');
  return path.resolve(cmd) === expectedCompiledBin && isInsideTmpdir(cwd);
}

export async function runInIsolatedSandbox(
  cmd: string,
  args: string[],
  opts: SandboxExecOptions
): Promise<SandboxExecResult> {
  const cfg = loadSandboxConfig();
  const probe = probeHostIsolation();
  const t0 = performance.now();

  if (!isInsideTmpdir(opts.cwd) || !isAllowedSandboxCommand(cmd, opts.cwd) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    return {
      stdout: '',
      stderr: 'Disallowed sandbox command, working directory, or argument (fail-closed policy active).',
      code: 126,
      timedOut: false,
      outputTruncated: false,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      executionUnavailable: true,
      unavailableReason: 'Rejected disallowed sandbox binary or working directory.',
    };
  }

  if (!cfg.allowUntrustedExec || !probe.hasNamespaceIsolation) {
    return {
      stdout: '',
      stderr: 'Isolated sandbox execution is unavailable in this environment (fail-closed policy active).',
      code: 126,
      timedOut: false,
      outputTruncated: false,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      executionUnavailable: true,
      unavailableReason: !cfg.allowUntrustedExec
        ? 'Untrusted execution disabled by SANDBOX_ALLOW_UNTRUSTED_EXEC=false.'
        : 'Linux namespace isolation (unshare) is unavailable; refusing unrestricted host execution.',
    };
  }

  const acquired = await executionSemaphore.acquire(cfg.maxConcurrentExecutions, 5000);
  if (!acquired) {
    return {
      stdout: '',
      stderr: 'Sandbox execution queue saturated; please retry shortly.',
      code: 125,
      timedOut: false,
      outputTruncated: false,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      executionUnavailable: true,
      unavailableReason: 'Maximum concurrent sandbox executions reached.',
    };
  }

  try {
    const mode = opts.mode ?? 'run';
    const maxOutputBytes = opts.maxOutputBytes ?? cfg.maxOutputBytes;
    const clampedTimeoutMs = Math.max(
      250,
      Math.min(opts.timeoutMs, Math.round(cfg.maxTimeoutSeconds * 1000))
    );
    const cpuSec =
      mode === 'compile'
        ? cfg.compileCpuSeconds
        : Math.max(cfg.cpuSeconds, Math.ceil(clampedTimeoutMs / 1000) + 1);
    const fsizeBytes = mode === 'compile' ? Math.max(cfg.maxFileBytes, 20 * 1024 * 1024) : cfg.maxFileBytes;
    const nofile = mode === 'compile' || mode === 'node' ? Math.max(cfg.maxOpenFiles, 128) : cfg.maxOpenFiles;
    const nproc = mode === 'compile' || mode === 'node' ? Math.max(cfg.maxProcesses, 64) : cfg.maxProcesses;

    const unshareArgs: string[] = probe.canDropToNobody
      ? ['--user', '--net', '--pid', '--fork', '--mount-proc']
      : ['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc'];

    const wrappedArgs: string[] = [...unshareArgs];

    if (probe.hasPrlimit) {
      wrappedArgs.push('prlimit', `--cpu=${cpuSec}`, `--fsize=${fsizeBytes}`, `--nofile=${nofile}`, `--nproc=${nproc}`);
      // Apply virtual address-space cap for native/Python/Bash processes;
      // Node.js V8 reserves large virtual address space so we cap V8 heap via --max-old-space-size instead.
      if (mode === 'run') {
        wrappedArgs.push(`--as=${cfg.memoryMb * 1024 * 1024}`);
      }
      wrappedArgs.push('--');
    }

    const finalCmd = cmd;
    const finalArgs =
      mode === 'node' && cmd === 'node'
        ? [`--max-old-space-size=${cfg.nodeOldSpaceMb}`, ...args]
        : args;

    wrappedArgs.push(finalCmd, ...finalArgs);

    // Minimal stripped environment: NEVER pass GEMINI_API_KEY, tokens, or host secrets.
    const minimalEnv: Record<string, string> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: opts.cwd,
      TMPDIR: opts.cwd,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PYTHONDONTWRITEBYTECODE: '1',
      NODE_NO_WARNINGS: '1',
    };

    return await new Promise<SandboxExecResult>((resolve) => {
      const child = spawn('unshare', wrappedArgs, {
        cwd: opts.cwd,
        env: minimalEnv,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(probe.canDropToNobody ? { uid: probe.nobodyUid, gid: probe.nobodyGid } : {}),
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let settled = false;

      const killTree = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // Process already exited
            }
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, clampedTimeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - stdoutBytes;
          stdoutChunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
          stdoutBytes += Math.min(chunk.length, remaining);
        }
        if (stdoutBytes >= maxOutputBytes && !outputTruncated) {
          outputTruncated = true;
          killTree();
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - stderrBytes;
          stderrChunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
          stderrBytes += Math.min(chunk.length, remaining);
        }
        if (stderrBytes >= maxOutputBytes && !outputTruncated) {
          outputTruncated = true;
          killTree();
        }
      });

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Number((performance.now() - t0).toFixed(2));
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          code,
          timedOut,
          outputTruncated,
          durationMs,
        });
      };

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: err.message || 'Sandbox execution failed to spawn.',
          code: 1,
          timedOut: false,
          outputTruncated,
          durationMs: Number((performance.now() - t0).toFixed(2)),
        });
      });

      child.on('close', (code, signal) => {
        const exitCode = typeof code === 'number' ? code : signal === 'SIGKILL' ? 137 : 1;
        finish(exitCode);
      });

      child.stdin?.on('error', () => {});
      if (opts.stdinData !== undefined) {
        child.stdin?.write(opts.stdinData);
      }
      child.stdin?.end();
    });
  } finally {
    executionSemaphore.release();
  }
}
