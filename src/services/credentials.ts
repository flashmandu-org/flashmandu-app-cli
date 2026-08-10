import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as TOML from '@iarna/toml';

/**
 * On-disk credential store at `~/.flashmandu/credentials.toml`, created with
 * 0600 permissions. Holds the developer bearer token (issued by `app login`),
 * the configured dev-box `base_url`, and the active profile name.
 *
 * The file is private to the developer; the CLI refuses to read or write it
 * with looser permissions.
 */

export interface ProfileEntry {
  /** Bearer token sent as `Authorization: Bearer <token>` to the dev box. */
  token: string;
  /** Absolute base URL of the dev-box AutoHisab Business host (no trailing slash). */
  base_url: string;
}

export interface CredentialsFile {
  /** Currently selected profile name (key into `profiles`). */
  active_profile?: string;
  profiles: Record<string, ProfileEntry>;
}

const DIR = path.join(os.homedir(), '.flashmandu');
const FILE = path.join(DIR, 'credentials.toml');

/** Error thrown when no profile is authenticated. */
export class NotAuthenticatedError extends Error {
  constructor(message = 'Not logged in. Run `autohisab-business login` first.') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
}

async function chmod0600(file: string): Promise<void> {
  await fs.chmod(file, 0o600);
}

/** Read the entire credentials file, or return an empty shape. */
export async function readAll(): Promise<CredentialsFile> {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const parsed = TOML.parse(raw) as unknown as CredentialsFile;
    if (!parsed.profiles || typeof parsed.profiles !== 'object') {
      parsed.profiles = {};
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { profiles: {} };
    }
    throw err;
  }
}

async function writeAll(data: CredentialsFile): Promise<void> {
  await ensureDir();
  const body = TOML.stringify(data as unknown as TOML.JsonMap);
  await fs.writeFile(FILE, body, { encoding: 'utf8', mode: 0o600 });
  // mkdir/writeFile mode is masked by umask; chmod to be explicit.
  await chmod0600(FILE);
}

/** Store a profile and mark it active. */
export async function setProfile(name: string, entry: ProfileEntry): Promise<void> {
  const all = await readAll();
  all.profiles[name] = entry;
  all.active_profile = name;
  await writeAll(all);
}

/** Return the active profile or throw `NotAuthenticatedError`. */
export async function getActive(): Promise<ProfileEntry> {
  const all = await readAll();
  const name = all.active_profile;
  if (!name || !all.profiles[name]) {
    throw new NotAuthenticatedError();
  }
  return all.profiles[name];
}

/** Return the active profile name, or undefined. */
export async function getActiveName(): Promise<string | undefined> {
  const all = await readAll();
  return all.active_profile;
}

/** Delete a named profile. Returns true if it existed. */
export async function removeProfile(name: string): Promise<boolean> {
  const all = await readAll();
  if (!all.profiles[name]) return false;
  delete all.profiles[name];
  if (all.active_profile === name) {
    const remaining = Object.keys(all.profiles);
    all.active_profile = remaining.length > 0 ? remaining[0] : undefined;
  }
  await writeAll(all);
  return true;
}

/** List profile names. */
export async function listProfiles(): Promise<{ active?: string; names: string[] }> {
  const all = await readAll();
  return { active: all.active_profile, names: Object.keys(all.profiles) };
}
