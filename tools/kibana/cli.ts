import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyRules, type RuleChange } from './apply.js';
import { KibanaClient, KibanaError } from './client.js';
import { buildDashboard, renderDashboardNdjson } from './dashboard.js';
import { loadParams, ParamsError } from './params.js';
import { buildRules, MIN_STACK_VERSION, renderAlertsNdjson } from './rules.js';
import { versionProblem } from './version.js';

const DEPLOY_DIR = resolve(import.meta.dirname, '../../deploy/kibana');
const DEFAULTS_PATH = join(DEPLOY_DIR, 'params.defaults.json');
const DEFAULT_LOCAL_PATH = join(DEPLOY_DIR, 'params.local.json');
const WAIT_MS = 120_000;

const USAGE = `Usage: cli.ts <build|apply> [options]
  build   Write billing-alerts.ndjson and billing-dashboard.ndjson
  apply   Create/update the rules and import the dashboard in Kibana
Options:
  --dry-run               (apply) only read; print what would change
  --kibana-url <url>      (apply) default $KIBANA_URL or http://localhost:15601
  --out <dir>             (build) default deploy/kibana
  --defaults-only         ignore params.local.json
  --params-local <path>   default deploy/kibana/params.local.json`;

export interface CliDeps {
  client?: KibanaClient;
  writeFile?: (path: string, data: string) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

interface Flags {
  dryRun: boolean;
  defaultsOnly: boolean;
  kibanaUrl: string;
  out: string;
  paramsLocal: string;
}

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = {
    dryRun: false,
    defaultsOnly: false,
    kibanaUrl: process.env.KIBANA_URL ?? 'http://localhost:15601',
    out: DEPLOY_DIR,
    paramsLocal: DEFAULT_LOCAL_PATH,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const value = (): string | undefined => args[++i];
    if (a === '--')
      continue; // pnpm chuyển tiếp dấu `--`
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--defaults-only') flags.defaultsOnly = true;
    else if (a === '--kibana-url' || a === '--out' || a === '--params-local') {
      const v = value();
      if (v === undefined) return `Missing value for ${a}`;
      if (a === '--kibana-url') flags.kibanaUrl = v;
      else if (a === '--out') flags.out = resolve(v);
      else flags.paramsLocal = resolve(v);
    } else return `Unknown option ${a}`;
  }
  return flags;
}

function formatChange(c: RuleChange): string {
  const diff = c.differences.length > 0 ? `  [${c.differences.join(', ')}]` : '';
  return `${c.actions.join('+')}  ${c.name}${diff}`;
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));
  const write = deps.writeFile ?? ((p: string, d: string) => writeFile(p, d, 'utf8'));
  const [command, ...rest] = argv;
  if (command !== 'build' && command !== 'apply') {
    error(USAGE);
    return 2;
  }
  const flags = parseFlags(rest);
  if (typeof flags === 'string') {
    error(`${flags}\n${USAGE}`);
    return 2;
  }

  try {
    const params = await loadParams({
      defaultsPath: DEFAULTS_PATH,
      ...(flags.defaultsOnly ? {} : { localPath: flags.paramsLocal }),
    });
    const rules = buildRules(params);
    const alerts = renderAlertsNdjson(rules);
    const dashboardObjects = buildDashboard(params);
    const dashboard = renderDashboardNdjson(dashboardObjects);

    if (command === 'build') {
      if (!deps.writeFile) await mkdir(flags.out, { recursive: true });
      await write(join(flags.out, 'billing-alerts.ndjson'), alerts);
      await write(join(flags.out, 'billing-dashboard.ndjson'), dashboard);
      log(`Wrote billing-alerts.ndjson and billing-dashboard.ndjson to ${flags.out}`);
      return 0;
    }

    const client = deps.client ?? new KibanaClient({ baseUrl: flags.kibanaUrl });
    await client.waitUntilAvailable(WAIT_MS);
    // Kiểm tra phiên bản trước mọi thao tác khác (kể cả --dry-run).
    const problem = versionProblem(await client.getVersion(), MIN_STACK_VERSION);
    if (problem) {
      error(problem);
      return 1;
    }

    const { changes, orphans } = await applyRules(client, rules, { dryRun: flags.dryRun });
    for (const c of changes) log(formatChange(c));
    const count = dashboardObjects.length;
    if (flags.dryRun) {
      log(`dashboard: would import ${count} objects (dry run)`);
    } else {
      const imported = await client.importSavedObjects(dashboard, true);
      log(`dashboard: imported ${imported} objects`);
    }
    if (orphans.length > 0) {
      log(
        `warning: ${orphans.length} rule(s) tagged billing are not managed by this tool (not deleted): ${orphans
          .map((o) => `${o.name} (${o.id})`)
          .join(', ')}`,
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof ParamsError) {
      error(e.message);
      return 1;
    }
    if (e instanceof KibanaError) {
      error(e.message);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
