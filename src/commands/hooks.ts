import { Command } from 'commander';
import chalk from 'chalk';
import { get } from '../services/apiClient';

interface HookCatalogEntry {
  description: string;
  category: string;
  type?: string;
}
type HookCatalog = Record<string, HookCatalogEntry>;

/** `flashmandu-app hooks` — list platform hooks from `GET /api/apps/hooks`. */
export function makeHooksCommand(): Command {
  return new Command('hooks')
    .description('List platform hooks available to apps (public endpoint).')
    .option('--category <name>', 'Filter by category')
    .option('--type <type>', 'Filter by type (event | filter)')
    .action(async (opts: { category?: string; type?: string }) => {
      const catalog = await get<HookCatalog>('/api/apps/hooks', { noAuth: true });
      const names = Object.keys(catalog).sort();

      let rows = names.map((name) => ({ name, ...catalog[name]! }));
      if (opts.category) {
        rows = rows.filter((r) => r.category.toLowerCase() === opts.category!.toLowerCase());
      }
      if (opts.type) {
        rows = rows.filter((r) => (r.type ?? 'event') === opts.type);
      }

      if (rows.length === 0) {
        console.log(chalk.yellow('No hooks matched your filter.'));
        return;
      }

      const padName = Math.max(8, ...rows.map((r) => r.name.length));
      const padCat = Math.max(8, ...rows.map((r) => r.category.length));
      console.log(
        chalk.dim(
          `${'Hook'.padEnd(padName)}  ${'Category'.padEnd(padCat)}  Type        Description`,
        ),
      );
      for (const r of rows) {
        console.log(
          `${r.name.padEnd(padName)}  ${r.category.padEnd(padCat)}  ${(r.type ?? 'event').padEnd(11)} ${r.description}`,
        );
      }
    });
}
