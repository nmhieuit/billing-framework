import { isDeepStrictEqual } from 'node:util';
import type { KibanaClient, KibanaRule } from './client.js';
import { toAlertingBody, type AlertingBody, type RuleDefinition } from './rules.js';

export type RuleAction = 'create' | 'update' | 'enable' | 'disable' | 'unchanged';

export interface RuleChange {
  id: string;
  name: string;
  actions: RuleAction[];
  differences: string[];
}

export interface ApplyResult {
  changes: RuleChange[];
  orphans: Array<{ id: string; name: string }>;
}

/** Tag dùng để nhận diện rule do generator quản lý. */
const MANAGED_TAG = 'billing';

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/** Tên các khía cạnh khác nhau giữa rule đang có trên Kibana và rule mong muốn. */
export function diffRule(existing: KibanaRule, desired: AlertingBody): string[] {
  const diffs: string[] = [];
  if (existing.name !== desired.name) diffs.push('name');
  if (!sameSet(existing.tags ?? [], desired.tags)) diffs.push('tags');
  if (!isDeepStrictEqual(existing.schedule, desired.schedule)) diffs.push('schedule');
  // Chỉ so các khoá có trong desired.params: Kibana có thể thêm khoá mặc định phía server.
  const params = existing.params ?? {};
  const differs = Object.entries(desired.params).some(([k, v]) => !isDeepStrictEqual(params[k], v));
  if (differs) diffs.push('params');
  if (existing.enabled !== desired.enabled) diffs.push('enabled');
  return diffs;
}

async function plan(
  client: KibanaClient,
  rules: RuleDefinition[],
): Promise<Array<RuleChange & { rule: RuleDefinition; body: AlertingBody }>> {
  const out: Array<RuleChange & { rule: RuleDefinition; body: AlertingBody }> = [];
  for (const rule of rules) {
    const body = toAlertingBody(rule);
    const existing = await client.getRule(rule.id);
    const base = { id: rule.id, name: rule.name, rule, body };
    if (!existing) {
      out.push({ ...base, actions: ['create'], differences: [] });
      continue;
    }
    const differences = diffRule(existing, body);
    const actions: RuleAction[] = [];
    if (differences.some((d) => d !== 'enabled')) actions.push('update');
    if (differences.includes('enabled')) actions.push(body.enabled ? 'enable' : 'disable');
    out.push({ ...base, actions: actions.length > 0 ? actions : ['unchanged'], differences });
  }
  return out;
}

const strip = ({ id, name, actions, differences }: RuleChange): RuleChange => ({
  id,
  name,
  actions,
  differences,
});

export async function planRules(
  client: KibanaClient,
  rules: RuleDefinition[],
): Promise<RuleChange[]> {
  return (await plan(client, rules)).map(strip);
}

export async function applyRules(
  client: KibanaClient,
  rules: RuleDefinition[],
  options: { dryRun: boolean },
): Promise<ApplyResult> {
  const planned = await plan(client, rules);
  if (!options.dryRun) {
    for (const p of planned) {
      for (const action of p.actions) {
        if (action === 'create') await client.createRule(p.id, p.body);
        else if (action === 'update') await client.updateRule(p.id, p.body);
        else if (action === 'enable') await client.setRuleEnabled(p.id, true);
        else if (action === 'disable') await client.setRuleEnabled(p.id, false);
      }
    }
  }
  const desiredIds = new Set(rules.map((r) => r.id));
  const orphans = (await client.findRulesByTag(MANAGED_TAG)).filter((r) => !desiredIds.has(r.id));
  return { changes: planned.map(strip), orphans };
}
