import { get } from './apiClient';

/**
 * Runtime capabilities advertised by the platform the CLI is logged into.
 * Sourced from `GET /api/apps/capabilities` — the CLI compiles in NO
 * production host, so this is the only place it learns the tenant registry
 * address and whether platform hosting is even available.
 */
export interface PlatformCapabilities {
  /** Platform environment name (e.g. production, local, development). */
  environment: string;
  /**
   * Tenant image registry address, or null where the platform has no tenant
   * cluster (everywhere but production). Null means `--target platform` cannot
   * run there — the CLI refuses rather than falling back to a compiled host.
   */
  tenant_registry: string | null;
  /** Whether the platform can host platform-target apps (production only). */
  platform_hosting: boolean;
}

/** Fetch the platform's runtime capabilities. Requires an authenticated profile. */
export function fetchCapabilities(): Promise<PlatformCapabilities> {
  return get<PlatformCapabilities>('/api/apps/capabilities');
}
