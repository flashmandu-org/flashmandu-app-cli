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
      // OrbStack: free, fast, bundles the docker CLI + a daemon.
      return { cmd: 'brew', args: ['install', '--cask', 'orbstack'] };
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
 * Ensure a Docker daemon is available. If `docker` is missing/broken, install
 * the platform's lightweight runtime and retry. Throws a helpful message if it
 * cannot recover (unknown platform, or install failed).
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
  // OrbStack/Rancher bring their own daemon; give it a moment, then re-check.
  if (!dockerAvailable()) {
    throw new Error(
      `Docker was installed but isn't responding yet. Start it (e.g. open OrbStack) and rerun \`flashmandu-app deploy\`.`,
    );
  }
}
