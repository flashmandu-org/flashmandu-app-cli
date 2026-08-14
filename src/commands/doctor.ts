import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { DOCTOR_RULES, type Finding } from '../services/doctor-rules';

/**
 * `autohisab-business doctor` — run every static check in `doctor-rules.ts`
 * against an app directory and print a ✓/✗ table. Exits 1 if any `error`
 * finding fails; `warn` findings (e.g. `app-css-budget`) are reported but
 * don't fail the run.
 */
export function runDoctor(cwd: string): Finding[] {
  return DOCTOR_RULES.flatMap((rule) => rule.check(cwd));
}

function printFinding(finding: Finding): void {
  if (finding.ok) {
    console.log(`${chalk.green('✓')} ${finding.rule}`);
    return;
  }

  const icon = finding.severity === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
  const location = finding.file
    ? chalk.dim(finding.line ? ` (${finding.file}:${finding.line})` : ` (${finding.file})`)
    : '';
  console.log(`${icon} ${finding.rule}${location}`);
  if (finding.detail) {
    console.log(chalk.dim(`    ${finding.detail}`));
  }
}

export function makeDoctorCommand(): Command {
  return new Command('doctor')
    .description('Run static checks for the recorded remote-app incidents.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action((opts: { dir: string }) => {
      const cwd = path.resolve(opts.dir);
      const findings = runDoctor(cwd);

      for (const finding of findings) {
        printFinding(finding);
      }

      const errors = findings.filter((f) => !f.ok && f.severity === 'error');
      const warnings = findings.filter((f) => !f.ok && f.severity === 'warn');

      console.log('');
      if (errors.length === 0) {
        console.log(chalk.green(`✓ doctor: all checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`));
      } else {
        console.log(chalk.red(`✗ doctor: ${errors.length} check(s) failed.`));
        process.exitCode = 1;
      }
    });
}
