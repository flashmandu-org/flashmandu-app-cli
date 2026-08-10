import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { makeCompletionCommand, renderCompletion, detectShell } from '../src/commands/completion';
import { makeDeployCommand } from '../src/commands/deploy';
import { makeLoginCommand } from '../src/commands/login';
import { makeInitCommand } from '../src/commands/init';
import { makeDevCommand } from '../src/commands/dev';

function makeProgram(): Command {
  const program = new Command();
  program
    .name('autohisab-business')
    .option('--base-url <url>', 'Override the dev-box base URL for this invocation');
  program.addCommand(makeLoginCommand());
  program.addCommand(makeInitCommand());
  program.addCommand(makeDevCommand());
  program.addCommand(makeDeployCommand());
  program.addCommand(makeCompletionCommand(program));
  return program;
}

describe('renderCompletion', () => {
  const program = makeProgram();

  it('emits a zsh script with command names and options', () => {
    const zsh = renderCompletion(program, 'zsh');
    expect(zsh).toContain('#compdef autohisab-business');
    for (const cmd of ['login', 'init', 'dev', 'deploy', 'completion']) {
      expect(zsh).toContain(cmd);
    }
    expect(zsh).toContain('--base-url');
    expect(zsh).toContain('--help');
    expect(zsh).toContain('--target');
    expect(zsh).toContain('(platform vercel self)');
  });

  it('emits a bash script with command names and options', () => {
    const bash = renderCompletion(program, 'bash');
    expect(bash).toContain('complete -F _autohisab_business autohisab-business');
    expect(bash).toContain('login init dev deploy completion');
    expect(bash).toContain('--base-url');
    expect(bash).toContain('--target');
    expect(bash).toContain('platform vercel self');
  });

  it('rejects an unsupported shell', () => {
    expect(() => renderCompletion(program, 'fish')).toThrow(/Unsupported shell/);
  });
});

describe('powershell renderer', () => {
  const program = makeProgram();

  it('emits a Register-ArgumentCompleter script with commands and options', () => {
    const ps = renderCompletion(program, 'powershell');
    expect(ps).toContain('Register-ArgumentCompleter -Native -CommandName autohisab-business');
    for (const cmd of ['login', 'init', 'dev', 'deploy', 'completion']) {
      expect(ps).toContain(`'${cmd}'`);
    }
    expect(ps).toContain("'--base-url'");
    expect(ps).toContain("'--help'");
    expect(ps).toContain("'--target'");
    expect(ps).toContain("'platform', 'vercel', 'self'");
    expect(ps).toContain("'--template'");
  });
});

describe('detectShell', () => {
  it('uses the basename of $SHELL', () => {
    expect(detectShell({ SHELL: '/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/local/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: 'zsh' })).toBe('zsh');
  });

  it('defaults to powershell on Windows', () => {
    expect(detectShell({}, 'win32')).toBe('powershell');
    expect(detectShell({ SHELL: '/bin/bash' }, 'win32')).toBe('powershell');
  });

  it('throws a helpful error for unknown shells', () => {
    expect(() => detectShell({ SHELL: '/usr/bin/fish' })).toThrow(/Could not detect your shell/);
    expect(() => detectShell({})).toThrow(/completion <zsh\|bash\|powershell>/);
  });
});
