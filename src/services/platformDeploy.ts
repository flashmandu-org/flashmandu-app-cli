import { execFileSync } from 'node:child_process';
import type { PlatformCapabilities } from './platformCapabilities';

/**
 * Platform-target deployment logic for `flashmandu-app deploy --target platform`.
 *
 * The CLI compiles in NO production host (the spec promise). The registry
 * address and platform-hosting availability both come from the platform's
 * capabilities response, and a platform that cannot host platform apps gets a
 * clear refusal — never a silent fallback to the production registry.
 */

export interface RegistryResolutionInput {
  /** Explicit `--registry` flag. Wins over everything. */
  flag?: string;
  /** Process env (injected so tests need not mutate `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Capabilities advertised by the logged-in platform, or null/absent. */
  capabilities?: PlatformCapabilities | null;
}

/**
 * Resolve the tenant registry in priority order, first match wins:
 *   1. `--registry` flag
 *   2. `FLASHMANDU_TENANT_REGISTRY` env var
 *   3. the registry advertised by the platform
 *   4. REFUSE — never a hardcoded default.
 *
 * Step 4 is the whole point: the previous code fell back to a hardcoded
 * production tenant registry, so a local login silently pushed to prod.
 */
export function resolveTenantRegistry(input: RegistryResolutionInput): string {
  const { flag, env = process.env, capabilities = null } = input;

  if (typeof flag === 'string' && flag.length > 0) return flag;

  const envRegistry = env.FLASHMANDU_TENANT_REGISTRY;
  if (typeof envRegistry === 'string' && envRegistry.length > 0) return envRegistry;

  if (capabilities?.tenant_registry) return capabilities.tenant_registry;

  const environment = capabilities?.environment ?? 'this platform';
  throw new Error(
    `${environment} does not advertise a tenant registry, so --target platform cannot run there. ` +
      `For local development run \`flashmandu-app dev\` (tunnel + registration, no Docker needed); ` +
      `otherwise deploy with --target self or --target vercel.`,
  );
}

/**
 * The refusal shown when the logged-in platform cannot host platform apps.
 * Names `flashmandu-app dev` because that is the local path a developer
 * reaching for `--target platform` actually wants.
 */
export function platformHostingRefusal(caps: PlatformCapabilities | null): string {
  const environment = caps?.environment ?? 'this platform';
  return (
    `--target platform is not available against ${environment}: platform hosting needs the ` +
      `tenant cluster, which only exists in production. For local development run ` +
      `\`flashmandu-app dev\` (tunnel + registration, no Docker), or deploy to your own host ` +
      `with --target self / --target vercel.`
  );
}

/** Dependencies the precondition checks need, injectable for tests. */
export interface PlatformDeployDeps {
  isLoggedIn: () => Promise<boolean>;
  dockerOnPath: () => boolean;
  registryReachable: (host: string) => Promise<boolean>;
}

/**
 * Verify every precondition for `--target platform`, in order of cheapest and
 * most common failure first, throwing a specific message on the first miss.
 *
 *   1. logged in
 *   2. the platform supports platform hosting
 *   3. the platform advertises a registry
 *   4. `docker` is on PATH (the operator laptop lacks it → hit here)
 *   5. the registry is reachable
 *
 * Order matters: check cheap common failures before spending time on a
 * reachability probe.
 */
export async function assertPlatformDeployReady(
  caps: PlatformCapabilities | null,
  registry: string | null,
  deps: PlatformDeployDeps,
): Promise<void> {
  if (!(await deps.isLoggedIn())) {
    throw new Error('Not logged in. Run `flashmandu-app login` first.');
  }

  if (!caps || !caps.platform_hosting) {
    throw new Error(platformHostingRefusal(caps));
  }

  if (!caps.tenant_registry) {
    throw new Error(
      `${caps.environment} supports platform hosting but did not advertise a tenant registry. ` +
        `Check the platform's tenant_cluster.registry config, or pass --registry explicitly.`,
    );
  }

  if (!deps.dockerOnPath()) {
    throw new Error(
      'Docker is required for --target platform: the CLI builds and pushes the image locally. ' +
        'Install Docker, or for local development run `flashmandu-app dev` instead (no Docker needed).',
    );
  }

  if (!registry || !(await deps.registryReachable(registry))) {
    throw new Error(
      `Could not reach the tenant registry at ${registry ?? '<unset>'} from this machine. ` +
        `The registry is on a private network; connect from a machine that can reach it.`,
    );
  }
}

/** True when a `docker` executable is resolvable on PATH. */
export function isDockerOnPath(): boolean {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // ENOENT → docker is not on PATH. Any other failure means docker exists
    // but errored, so treat it as present and let the build step report it.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Best-effort reachability probe for the tenant registry. The registry is a
 * container registry; a connection to `/v2/` (200 or 401) proves routability.
 * Returns false on any network failure so the precondition fails with a named
 * error instead of an opaque fetch exception.
 */
export async function isRegistryReachable(host: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://${host}/v2/`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
