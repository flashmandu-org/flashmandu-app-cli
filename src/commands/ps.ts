import { Command } from 'commander';
import chalk from 'chalk';

import {
  listDevLoops,
  listTunnelProcesses,
  stopAll,
  stopLoop,
  stopTunnelsForPort,
} from '../services/processes';

/**
 * `flashmandu-app ps` — list running `dev` loops and the tunnel processes they
 * own, so you can see what is holding a port and stop stragglers.
 *
 * `flashmandu-app stop` — stop one loop by pid, or everything with --all, or
 * whatever holds a port with --port.
 */
export function makePsCommand(): Command {
  return new Command('ps')
    .description('List running `flashmandu-app dev` loops, their ports, and tunnels.')
    .action(() => {
      const loops = listDevLoops();
      const tunnels = listTunnelProcesses();

      if (loops.length === 0 && tunnels.length === 0) {
        console.log(chalk.dim('No flashmandu-app dev loops or tunnels running.'));
        return;
      }

      if (loops.length > 0) {
        console.log(chalk.bold('Dev loops:'));
        for (const l of loops) {
          const slug = l.cwd ? l.cwd.split('/').filter(Boolean).pop() ?? l.cwd : '(unknown app)';
          const port = l.port ? String(l.port) : '3000?';
          const tunnel = l.tunnelUrl
            ? `tunnel-url: ${l.tunnelUrl}`
            : l.tunnelProvider
              ? `tunnel: ${l.tunnelProvider}`
              : 'tunnel: (auto cloudflared)';
          console.log(
            `  ${chalk.cyan(String(l.pid)).padEnd(8)} ${chalk.yellow(port).padEnd(7)} ${tunnel.padEnd(48)} ${chalk.dim(slug)}`,
          );
        }
      }

      if (tunnels.length > 0) {
        console.log(chalk.bold('\nTunnel processes:'));
        for (const t of tunnels) {
          const port = t.port ? String(t.port) : '—';
          console.log(`  ${chalk.cyan(String(t.pid)).padEnd(8)} ${chalk.magenta(t.kind).padEnd(12)} port ${port}`);
        }
      }

      console.log(
        chalk.dim(
          `\nStop with: ${chalk.reset('flashmandu-app stop <pid>')}` +
            `  •  ${chalk.reset('flashmandu-app stop --port <n>')}` +
            `  •  ${chalk.reset('flashmandu-app stop --all')}`,
        ),
      );
    });
}

export function makeStopCommand(): Command {
  return new Command('stop')
    .description('Stop running `flashmandu-app dev` loops and their tunnels (free ports).')
    .argument('[pid]', 'PID of a dev loop to stop')
    .option('-a, --all', 'Stop every dev loop + tunnel')
    .option('-p, --port <n>', 'Stop whatever dev loop + tunnel holds this port')
    .option('-f, --force', 'SIGKILL instead of SIGTERM (graceless)')
    .action((pidArg: string | undefined, opts: { all?: boolean; port?: string; force?: boolean }) => {
      const force = !!opts.force;

      if (opts.all) {
        const { loops, tunnels } = stopAll(force);
        console.log(
          chalk.green(
            `Stopped ${loops.length} dev loop(s) and ${tunnels.length} tunnel(s).`,
          ),
        );
        return;
      }

      if (opts.port) {
        const port = Number(opts.port);
        if (!Number.isFinite(port)) {
          console.error(chalk.red('--port must be a number'));
          process.exitCode = 1;
          return;
        }
        const loop = listDevLoops().find((l) => l.port === port);
        const killedLoops = loop ? stopLoop(loop.pid, force) : [];
        const killedTunnels = stopTunnelsForPort(port, force);
        console.log(
          chalk.green(
            `Port ${port}: stopped ${killedLoops.length} dev loop(s), ${killedTunnels.length} tunnel(s).`,
          ),
        );
        return;
      }

      if (pidArg) {
        const pid = Number(pidArg);
        if (!Number.isFinite(pid)) {
          console.error(chalk.red('pid must be a number'));
          process.exitCode = 1;
          return;
        }
        const killed = stopLoop(pid, force);
        // Also clear tunnels targeting the same port if this was a dev loop.
        const loop = listDevLoops().find((l) => l.pid === pid);
        let extra = 0;
        if (loop?.port) extra = stopTunnelsForPort(loop.port, force).length;
        console.log(chalk.green(`Stopped PID ${killed[0]}${extra ? ` + ${extra} tunnel(s)` : ''}.`));
        return;
      }

      console.error(
        chalk.red('Specify a pid, --all, or --port <n>. See `flashmandu-app stop --help`.'),
      );
      process.exitCode = 1;
    });
}
