import { describe, expect, it } from 'vitest';
import {
  resolveTenantRegistry,
  assertPlatformDeployReady,
  platformHostingRefusal,
  type PlatformDeployDeps,
} from '../src/services/platformDeploy';
import type { PlatformCapabilities } from '../src/services/platformCapabilities';

const PROD_CAPS: PlatformCapabilities = {
  environment: 'production',
  tenant_registry: 'registry.apps.business.autohisab.com',
  platform_hosting: true,
};

const LOCAL_CAPS: PlatformCapabilities = {
  environment: 'local',
  tenant_registry: null,
  platform_hosting: false,
};

/** Deps stub: every check passes unless overridden per-test. */
function passingDeps(overrides: Partial<PlatformDeployDeps> = {}): PlatformDeployDeps {
  return {
    isLoggedIn: async () => true,
    dockerOnPath: () => true,
    registryReachable: async () => true,
    ...overrides,
  };
}

describe('resolveTenantRegistry', () => {
  it('honours an explicit --registry flag above everything else', () => {
    expect(
      resolveTenantRegistry({
        flag: 'my-registry:5000',
        env: { FLASHMANDU_TENANT_REGISTRY: 'env-registry:5000' },
        capabilities: PROD_CAPS,
      }),
    ).toBe('my-registry:5000');
  });

  it('falls back to FLASHMANDU_TENANT_REGISTRY when no flag is given', () => {
    expect(
      resolveTenantRegistry({
        env: { FLASHMANDU_TENANT_REGISTRY: 'env-registry:5000' },
        capabilities: PROD_CAPS,
      }),
    ).toBe('env-registry:5000');
  });

  it('uses the platform-advertised registry when neither flag nor env is set', () => {
    expect(resolveTenantRegistry({ env: {}, capabilities: PROD_CAPS })).toBe(
      'registry.apps.business.autohisab.com',
    );
  });

  it('FAILS naming the environment when no source advertises a registry', () => {
    expect(() => resolveTenantRegistry({ env: {}, capabilities: LOCAL_CAPS })).toThrow(
      /local/,
    );
  });

  it('never returns a hardcoded host — the production address must not appear', () => {
    expect(() => resolveTenantRegistry({ env: {}, capabilities: null })).toThrow(/does not advertise/);
    // The defect being removed: 10.10.0.2:5000 must never be a fallback.
    expect(resolveTenantRegistry.toString()).not.toContain('10.10.0.2');
  });
});

describe('platformHostingRefusal', () => {
  it('names `autohisab-business dev` as the local alternative', () => {
    expect(platformHostingRefusal(LOCAL_CAPS)).toMatch(/autohisab-business dev/);
  });

  it('names the environment so the developer knows where they are', () => {
    expect(platformHostingRefusal(LOCAL_CAPS)).toMatch(/local/);
  });
});

describe('assertPlatformDeployReady', () => {
  it('passes when every precondition holds', async () => {
    await expect(
      assertPlatformDeployReady(PROD_CAPS, 'registry.apps.business.autohisab.com', passingDeps()),
    ).resolves.toBeUndefined();
  });

  it('fails asking the developer to log in when not authenticated', async () => {
    await expect(
      assertPlatformDeployReady(PROD_CAPS, 'registry.apps.business.autohisab.com', passingDeps({ isLoggedIn: async () => false })),
    ).rejects.toThrow(/login/i);
  });

  it('refuses when the platform does not support platform hosting, naming `autohisab-business dev`', async () => {
    await expect(
      assertPlatformDeployReady(LOCAL_CAPS, null, passingDeps()),
    ).rejects.toThrow(/autohisab-business dev/);
  });

  it('fails when the platform supports hosting but advertises no registry', async () => {
    const caps: PlatformCapabilities = { environment: 'production', tenant_registry: null, platform_hosting: true };
    await expect(
      assertPlatformDeployReady(caps, null, passingDeps()),
    ).rejects.toThrow(/tenant registry/i);
  });

  it('fails naming Docker (not a raw ENOENT) when docker is absent from PATH', async () => {
    await expect(
      assertPlatformDeployReady(PROD_CAPS, 'registry.apps.business.autohisab.com', passingDeps({ dockerOnPath: () => false })),
    ).rejects.toThrow(/Docker/);
  });

  it('fails naming the registry host when it cannot be reached', async () => {
    await expect(
      assertPlatformDeployReady(PROD_CAPS, 'registry.apps.business.autohisab.com', passingDeps({ registryReachable: async () => false })),
    ).rejects.toThrow(/registry.apps.business.autohisab.com/);
  });

  it('checks login before spending time on a reachability probe', async () => {
    // Not logged in AND registry unreachable: the login error must win.
    await expect(
      assertPlatformDeployReady(PROD_CAPS, 'registry.apps.business.autohisab.com', passingDeps({
        isLoggedIn: async () => false,
        registryReachable: async () => { throw new Error('should not be called'); },
      })),
    ).rejects.toThrow(/login/i);
  });
});
