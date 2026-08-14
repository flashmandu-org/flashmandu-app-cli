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

/**
 * Print the full ✓/✗ table for a set of findings and the summary line.
 * Shared by the `doctor` command and `init` (which runs doctor once, right
 * after scaffolding, so a broken template is caught the moment it is
 * generated rather than on the developer's first manual `doctor` run).
 * Returns `true` when there were zero `error`-severity failures.
 */
export function printDoctorReport(findings: Finding[]): boolean {
  for (const finding of findings) {
    printFinding(finding);
  }

  const errors = findings.filter((f) => !f.ok && f.severity === 'error');
  const warnings = findings.filter((f) => !f.ok && f.severity === 'warn');

  console.log('');
  if (errors.length === 0) {
    console.log(chalk.green(`✓ doctor: all checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`));
    return true;
  }
  console.log(chalk.red(`✗ doctor: ${errors.length} check(s) failed.`));
  return false;
}

export function makeDoctorCommand(): Command {
  return new Command('doctor')
    .description('Run static checks for the recorded remote-app incidents.')
    .option('-d, --dir <path>', 'App directory', '.')
    .action((opts: { dir: string }) => {
      const cwd = path.resolve(opts.dir);
      const findings = runDoctor(cwd);
      const ok = printDoctorReport(findings);
      if (!ok) {
        process.exitCode = 1;
      }
    });
}
