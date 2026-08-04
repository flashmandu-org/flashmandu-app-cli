import { execFileSync } from 'node:child_process';

export type BuildPlatform = 'darwin' | 'linux' | 'win32';

export function detectPlatform(): BuildPlatform {
  return process.platform as BuildPlatform;
}

/** The command that installs a lightweight Docker runtime for the platform. */
export function installCommandFor(
  platform: BuildPlatform,
): { cmd: string; args: string[] } | null {
  switch (platform) {
    case 'darwin':
      // colima: free, open-source (MIT), no license restrictions. Runs a Linux
      // VM with the docker daemon; `docker` is the CLI client formula.
      return { cmd: 'brew', args: ['install', 'colima', 'docker'] };
    case 'linux':
      // Debian/Ubuntu; other distros can override. podman is a daemonless alt.
      return { cmd: 'sh', args: ['-c', 'sudo apt-get update && sudo apt-get install -y docker.io'] };
    case 'win32':
      return { cmd: 'winget', args: ['install', '-e', '--id', 'RancherDesktop.RancherDesktop'] };
    default:
      return null;
  }
}

/** True when `docker version` succeeds (CLI + daemon both reachable). */
export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch the installed runtime's daemon. On macOS OrbStack installs but does
 * not auto-start — `open -a OrbStack` boots it (first launch also does the
 * one-time VM setup). Best-effort: ignored if the launch command is missing.
 */
function startRuntime(platform: BuildPlatform): void {
  const commands: Record<BuildPlatform, { cmd: string; args: string[] } | null> = {
    darwin: { cmd: 'colima', args: ['start'] },
    linux: null, // docker.service auto-starts on most distros; systemd handles it
    win32: { cmd: 'powershell', args: ['-Command', 'Start-Process', 'rancher-desktop'] },
  };
  const start = commands[platform];
  if (!start) {
    return;
  }
  try {
    execFileSync(start.cmd, start.args, { stdio: 'ignore' });
  } catch {
    // ignore — the poll will catch it if the daemon never comes up
  }
}

/** Block for `ms` milliseconds (sync, no subprocess). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Poll `dockerAvailable()` until it succeeds or `timeoutSec` elapses.
 * Prints a dot per check so the user sees progress.
 */
function awaitDaemon(timeoutSec: number): boolean {
  const intervalMs = 3000;
  const deadline = Date.now() + timeoutSec * 1000;
  process.stdout.write('  Waiting for Docker daemon');
  while (Date.now() < deadline) {
    if (dockerAvailable()) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r'); // clear progress line
      return true;
    }
    process.stdout.write('.');
    sleepSync(intervalMs);
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
  return false;
}

/**
 * Ensure a Docker daemon is available. If `docker` is missing/broken, install
 * the platform's lightweight runtime, start it, and wait for the daemon.
 * Throws a helpful message if it cannot recover.
 */
export function ensureDocker(): void {
  if (dockerAvailable()) {
    return;
  }
  const platform = detectPlatform();
  const install = installCommandFor(platform);
  if (!install) {
    throw new Error(
      `Docker is required for \`deploy --target platform\` but could not be installed automatically on ${platform}. Install Docker manually and rerun.`,
    );
  }
  console.log(`Docker not found — installing a lightweight runtime for ${platform}…`);
  try {
    execFileSync(install.cmd, install.args, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      `Could not install Docker automatically (${(err as Error).message}). Install it manually and rerun.`,
    );
  }

  // OrbStack/Rancher are installed but not running — launch + wait for the daemon.
  startRuntime(platform);
  console.log('  Starting Docker runtime…');
  if (!awaitDaemon(90)) {
    throw new Error(
      `Docker was installed but the daemon didn't come up within 90s. Open it manually (e.g. launch OrbStack from Applications), wait for it to finish setup, and rerun \`flashmandu-app deploy\`.`,
    );
  }
}

