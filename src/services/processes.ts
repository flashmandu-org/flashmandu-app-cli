import { execSync } from 'node:child_process';

/**
 * Discovery + lifecycle for running `autohisab-business dev` loops.
 *
 * Each `dev` loop is a Node process (`autohisab-business dev ...`) that owns an app
 * server (next/php) and a tunnel (cloudflared/ngrok). Stragglers happen when a
 * terminal is closed hard or a previous loop didn't clean up — they keep
 * holding ports and (for cloudflared) producing dead trycloudflare URLs. These
 * helpers list and stop them.
 *
 * Uses `ps` + `lsof` (POSIX) — works on macOS and Linux. Best-effort: if a tool
 * is unavailable we degrade gracefully rather than fatal.
 */

export interface DevLoop {
  pid: number;
  /** Resolved app cwd when discoverable (via lsof), else null. */
  cwd: string | null;
  port: number | null;
  /** '--tunnel <provider>' if a managed tunnel was requested. */
  tunnelProvider: string | null;
  /** '--tunnel-url <url>' if a bring-your-own URL was used. */
  tunnelUrl: string | null;
  /** Raw command line (trimmed). */
  command: string;
}

export interface TunnelProcess {
  pid: number;
  /** 'cloudflared' | 'ngrok' | 'other'. */
  kind: string;
  /** Local port the tunnel targets, parsed from `--url http://localhost:PORT`. */
  port: number | null;
  command: string;
}

/** Return all processes as [{pid, ppid, command}]. */
function snapshot(): Array<{ pid: number; ppid: number; command: string }> {
  try {
    const out = execSync('ps -eo pid=,ppid=,command=', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) return null;
        return { pid: Number(m[1]), ppid: Number(m[2]), command: (m[3] ?? '').trim() };
      })
      .filter((p): p is { pid: number; ppid: number; command: string } => p !== null);
  } catch {
    return [];
  }
}

/** Extract --port <n> from a command line (default 3000 when absent). */
function parsePort(cmd: string): number | null {
  const m = cmd.match(/--port\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseOpt(cmd: string, opt: string): string | null {
  const m = cmd.match(new RegExp(`${opt}\\s+(\\S+)`));
  return m ? (m[1] ?? null) : null;
}

/** Resolve a process's cwd via lsof (macOS/Linux). null when unavailable. */
function cwdOf(pid: number): string | null {
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const m = out.match(/^n(.+)$/m);
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Running `autohisab-business dev` loops. */
export function listDevLoops(): DevLoop[] {
  return snapshot()
    .filter((p) => /\b(flashmandu-app|autohisab-business)\b/.test(p.command) && /\bdev\b/.test(p.command))
    .map((p) => ({
      pid: p.pid,
      cwd: cwdOf(p.pid),
      port: parsePort(p.command) ?? 3000,
      tunnelProvider: parseOpt(p.command, '--tunnel'),
      tunnelUrl: parseOpt(p.command, '--tunnel-url'),
      command: p.command,
    }));
}

/** Running tunnel processes (cloudflared / ngrok), with the local port they target. */
export function listTunnelProcesses(): TunnelProcess[] {
  return snapshot()
    .filter(
      // Match the actual binaries, not a dev loop's `--tunnel cloudflared` arg.
      (p) =>
        p.command.includes('cloudflared/bin/cloudflared') || /\bngrok\b/.test(p.command),
    )
    .map((p) => {
      const kind = p.command.includes('cloudflared/bin/cloudflared')
        ? 'cloudflared'
        : 'ngrok';
      const urlMatch = p.command.match(/(?:--url\s+|ngrok\s+(?:http|tcp)\s+)http:\/\/localhost:(\d+)/);
      const portMatch = p.command.match(/:(\d{2,5})/);
      return {
        pid: p.pid,
        kind,
        port: urlMatch ? Number(urlMatch[1]) : portMatch ? Number(portMatch[1]) : null,
        command: p.command,
      };
    });
}

/** True if a PID is currently alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Send a signal to a PID, ignoring errors for already-dead processes. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already dead */
  }
}

/**
 * Stop a dev loop (and the tunnel it owns). Sends SIGTERM, then SIGKILL after a
 * short grace period. Returns the pids that were targeted.
 */
export function stopLoop(pid: number, force = false): number[] {
  const targeted = [pid];
  signal(pid, force ? 'SIGKILL' : 'SIGTERM');
  if (!force) {
    // Grace period, then escalate.
    const start = Date.now();
    while (alive(pid) && Date.now() - start < 3000) {
      // busy-wait briefly
    }
    if (alive(pid)) signal(pid, 'SIGKILL');
  }
  return targeted;
}

/**
 * Stop a tunnel whose target port matches. Used to clear orphaned cloudflared /
 * ngrok processes left behind by a crashed dev loop.
 */
export function stopTunnelsForPort(port: number, force = false): number[] {
  const killed: number[] = [];
  for (const t of listTunnelProcesses()) {
    if (t.port === port) {
      signal(t.pid, force ? 'SIGKILL' : 'SIGTERM');
      killed.push(t.pid);
    }
  }
  return killed;
}

/** Stop everything autohisab-business-related (dev loops + their tunnels). */
export function stopAll(force = false): { loops: number[]; tunnels: number[] } {
  const loops = listDevLoops();
  const killedLoops: number[] = [];
  const killedTunnels: number[] = [];
  const ports = new Set<number>();
  for (const l of loops) {
    if (l.port) ports.add(l.port);
    killedLoops.push(...stopLoop(l.pid, force));
  }
  // Clear orphaned tunnels targeting those ports too.
  for (const port of ports) killedTunnels.push(...stopTunnelsForPort(port, force));
  // Also clear any tunnel with no surviving dev loop (true orphans).
  for (const t of listTunnelProcesses()) {
    if (!alive(t.pid)) continue;
    signal(t.pid, force ? 'SIGKILL' : 'SIGTERM');
    killedTunnels.push(t.pid);
  }
  return { loops: killedLoops, tunnels: killedTunnels };
}
