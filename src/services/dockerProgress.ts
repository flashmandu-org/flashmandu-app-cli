import { spawn } from 'node:child_process';

/**
 * Live-progress helpers for `deploy --target platform`: streaming docker
 * build/push output and parsing it into spinner-friendly status.
 *
 * Pure parsing helpers (formatBytes, parseSize, parseBuildLine,
 * applyPushLine/pushSummary) are unit-tested; runStreaming is the only
 * side-effectful piece and spawns the real docker CLI.
 */

/** Human-readable byte size, decimal units, 1 decimal place ("182.4 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
};

/** Parse docker's size strings ("512B", "12.3MB", "1.07GB") into bytes. */
export function parseSize(s: string): number {
  const m = /([\d.]+)\s*(B|kB|KB|MB|GB|TB)/i.exec(s.trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (SIZE_UNITS[m[2]!.toUpperCase()] ?? 0));
}

/**
 * Extract a meaningful step from a BuildKit --progress=plain line:
 *   "#12 3.245 [4/7] RUN npm ci"      → "[4/7] RUN npm ci"
 *   "#12 [4/7] RUN npm ci"            → "[4/7] RUN npm ci"
 *   "#25 exporting to image"          → "exporting to image"
 *   "#12 DONE 3.2s" / "#12 CACHED"    → undefined (noise)
 */
export function parseBuildLine(line: string): string | undefined {
  const m = /^#\d+\s+(?:\d+\.\d+\s+)?(.+)$/.exec(line.trim());
  if (!m) return undefined;
  const rest = m[1]!.trim();
  if (/^(DONE|CACHED|ERROR)\b/.test(rest)) return undefined;
  if (/^\d+\.\d+s?$/.test(rest)) return undefined;
  return rest.length > 0 ? rest : undefined;
}

interface LayerProgress {
  current: number;
  total: number;
  done: boolean;
}

export interface PushState {
  layers: Map<string, LayerProgress>;
}

export function createPushState(): PushState {
  return { layers: new Map() };
}

/**
 * Fold one docker-push status line into the aggregate state. Returns true when
 * the line carried progress information (so the caller updates the spinner).
 *
 *   a1b2c3: Layer already exists        → layer done (size unknown)
 *   a1b2c3: Mounted from other/app      → layer done
 *   a1b2c3: Pushing [==>   ] 12.3MB/50.1MB → current/total
 *   a1b2c3: Pushed                      → layer done at full size
 */
export function applyPushLine(state: PushState, line: string): boolean {
  const m = /^([0-9a-f]{6,64}): (.+)$/.exec(line.trim());
  if (!m) return false;
  const [, id, status] = m as unknown as [string, string, string];
  const layer = state.layers.get(id) ?? { current: 0, total: 0, done: false };

  if (/^(Layer already exists|Mounted from|Pushed)/.test(status)) {
    layer.done = true;
    layer.current = layer.total;
  } else if (/^Pushing/.test(status)) {
    const sm = /([\d.]+\s*[a-zA-Z]+)(?:\/([\d.]+\s*[a-zA-Z]+))?/.exec(status);
    if (!sm) return false;
    layer.current = parseSize(sm[1]!);
    if (sm[2]) layer.total = parseSize(sm[2]);
  } else {
    return false; // Preparing / Waiting / …
  }
  state.layers.set(id, layer);
  return true;
}

/** Aggregate push progress across all known layers. */
export function pushSummary(state: PushState): { current: number; total: number; percent: number } {
  let current = 0;
  let total = 0;
  for (const l of state.layers.values()) {
    current += l.current;
    total += l.total;
  }
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return { current, total, percent };
}

/** Last `n` non-empty lines of captured output, for error messages. */
export function tail(output: string, n = 30): string {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}

export class DockerRunError extends Error {
  constructor(
    message: string,
    public readonly output: string,
  ) {
    super(message);
  }
}

/**
 * Spawn a docker subcommand, streaming stdout+stderr. Each completed line is
 * passed to onLine; the full output is captured for error tails. Rejects with
 * DockerRunError (carrying the captured output) on a non-zero exit.
 */
export function runStreaming(
  args: string[],
  opts: { cwd: string },
  onLine: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let pending = '';
    const handleChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      output += text;
      pending += text;
      // Split on newlines; docker also uses \r for in-place progress lines.
      const parts = pending.split(/\r?\n|\r/);
      pending = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim().length > 0) onLine(line);
      }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', (err) => reject(new DockerRunError(err.message, output)));
    child.on('close', (code) => {
      if (pending.trim().length > 0) onLine(pending);
      if (code === 0) resolve(output);
      else reject(new DockerRunError(`docker ${args[0]} exited with code ${code}`, output));
    });
  });
}
