import { describe, expect, it } from 'vitest';
import { browserOpenCommand } from '../src/commands/dev';

/**
 * `autohisab-business dev` crashed on Windows the moment it tried to open the
 * sandbox:
 *
 *   Error: spawn start "" ENOENT
 *     syscall: 'spawn start ""'
 *
 * TWO defects, both fatal:
 *   1. `start` is a cmd.exe BUILTIN, not an executable on PATH. Spawning the
 *      string `start ""` without a shell can only ever be ENOENT — and the
 *      `""` was being passed as part of the program NAME.
 *   2. spawn() reports ENOENT via an asynchronous 'error' event. With no
 *      listener, Node rethrows it as an unhandled 'error' and the whole dev
 *      loop dies — taking the tunnel with it and stranding the app server on
 *      the port, which is why the next run failed with "Port 3000 is already
 *      in use".
 *
 * The invocation must go through cmd.exe, and the empty `""` must be a
 * separate argument: it is `start`'s window-TITLE parameter. Without it,
 * `start "https://…"` reads the quoted URL AS the title and opens nothing.
 */
describe('browserOpenCommand', () => {
  const url = 'https://business-dev.autohisab.com/apps/acme/test-app/embed?a=1&b=2';

  it('routes through cmd.exe on Windows with an empty title argument', () => {
    const { cmd, args, verbatim } = browserOpenCommand(url, 'win32');

    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/c', 'start', '""']);
    // The URL is quoted so cmd does not read `&` as a command separator.
    expect(args[3]).toBe(`"${url}"`);
    // ...which only survives if Node passes the args through untouched.
    expect(verbatim).toBe(true);
    // The program name must never carry arguments.
    expect(cmd).not.toContain(' ');
  });

  it('uses the native opener on macOS and Linux', () => {
    expect(browserOpenCommand(url, 'darwin')).toEqual({
      cmd: 'open',
      args: [url],
      verbatim: false,
    });
    expect(browserOpenCommand(url, 'linux')).toEqual({
      cmd: 'xdg-open',
      args: [url],
      verbatim: false,
    });
  });
});
