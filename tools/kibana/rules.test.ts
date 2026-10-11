import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableId } from './ids.js';
import type { Params, RuleName } from './params.js';
import {
  buildRules,
  MIN_STACK_VERSION,
  type Fields,
  renderAlertsNdjson,
  toAlertingBody,
  toSavedObject,
  type RuleDefinition,
} from './rules.js';

const DEFAULTS_PATH = resolve(import.meta.dirname, '../../deploy/kibana/params.defaults.json');
const NDJSON_PATH = resolve(import.meta.dirname, '../../deploy/kibana/billing-alerts.ndjson');
const defaults = JSON.parse(await readFile(DEFAULTS_PATH, 'utf8')) as Params;

const NAMES: RuleName[] = [
  'billing-dlq-not-empty',
  'billing-outbox-stuck',
  'billing-topups-stuck',
  'billing-ledger-integrity',
  'billing-reconciliation-stale-cases',
  'billing-reconciliation-missed',
  'billing-reconciliation-failed-run',
  'billing-service-silent',
];

const clone = (): Params => structuredClone(defaults);
const byName = (rules: RuleDefinition[], name: RuleName): RuleDefinition =>
  rules.find((r) => r.name === name)!;

describe('stableId', () => {
  it('is deterministic and UUID-shaped (v5, variant 10)', () => {
    const id = stableId('billing-dlq-not-empty');
    expect(stableId('billing-dlq-not-empty')).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableId('billing-outbox-stuck')).not.toBe(id);
  });

  it('is pinned for billing-dlq-not-empty', () => {
    expect(stableId('billing-dlq-not-empty')).toBe('e3616743-1c93-55c5-9b39-86aa0bd3e4b0');
  });
});

describe('buildRules', () => {
  const rules = buildRules(defaults);

  it('returns the 8 rules in order with ids, tags and common params', () => {
    expect(rules.map((r) => r.name)).toEqual(NAMES);
    for (const r of rules) {
      const p = defaults.rules[r.name];
      expect(r.id).toBe(stableId(r.name));
      expect(r.tags).toEqual(['billing', p.severity]);
      expect(r.enabled).toBe(p.enabled);
      expect(r.severity).toBe(p.severity);
      expect(r.intervalMinutes).toBe(p.intervalMinutes);
      // Rule silent dùng cửa sổ nhìn lại (lookbackHours * 60) thay cho windowMinutes.
      if (r.name !== 'billing-service-silent') expect(r.windowMinutes).toBe(p.windowMinutes);
      expect(r.description).toMatch(/docs\/integration|README\.md/);
    }
  });

  it('changing one parameter changes only that rule', () => {
    const p = clone();
    p.rules['billing-outbox-stuck'].thresholdSeconds = 600;
    const changed = buildRules(p);
    expect(byName(changed, 'billing-outbox-stuck').esql).toContain('age > 600');
    for (const n of NAMES.filter((x) => x !== 'billing-outbox-stuck'))
      expect(byName(changed, n)).toEqual(byName(rules, n));
  });

  it('carries enabled=false through and converts hours to seconds', () => {
    const p = clone();
    p.rules['billing-dlq-not-empty'].enabled = false;
    p.rules['billing-reconciliation-missed'].maxAgeHours = 30;
    const changed = buildRules(p);
    expect(byName(changed, 'billing-dlq-not-empty').enabled).toBe(false);
    expect(byName(changed, 'billing-reconciliation-missed').esql).toContain('age > 108000');
  });

  it('uses LAST for current-value rules and MIN/MAX for the DLQ and failed-run rules', () => {
    expect(byName(rules, 'billing-dlq-not-empty').esql).toContain('MIN(metrics.billing.dlq.depth)');
    expect(byName(rules, 'billing-outbox-stuck').esql).toContain('LAST(');
    expect(byName(rules, 'billing-reconciliation-failed-run').esql).toContain('MIN(');
  });

  it('builds every field and the index from FIELDS only', () => {
    const fake: Fields = {
      timestamp: 'TS_X',
      service: 'SVC_X',
      serviceInstance: 'INST_X',
      metric: (n: string) => `M_X<${n}>`,
      attribute: (n: string) => `A_X<${n}>`,
      metricsIndex: 'idx-x*',
    };
    for (const r of buildRules(defaults, fake)) {
      expect(r.esql).toContain('FROM idx-x*');
      expect(r.esql).not.toMatch(/@timestamp|metrics\.|attributes\.|resource\.attributes/);
      expect(r.esql).toContain('TS_X');
    }
  });

  it('includes the real index in every query', () => {
    for (const r of rules) expect(r.esql).toContain('FROM metrics-generic.otel-default*');
  });

  it('has unique ids and a stack version floor; every query starts with the SET line', () => {
    expect(new Set(rules.map((r) => r.id)).size).toBe(8);
    expect(MIN_STACK_VERSION).toBe('9.4.0');
    for (const r of rules) expect(r.esql.startsWith('SET unmapped_fields="nullify";\n')).toBe(true);
  });

  it('builds the silent rule from lookbackHours, silentMinutes and the service list', () => {
    const p = clone();
    p.rules['billing-service-silent'].lookbackHours = 7;
    p.rules['billing-service-silent'].silentMinutes = 11;
    const esql = byName(buildRules(p), 'billing-service-silent').esql;
    expect(esql).toContain('NOW() - 7 hours');
    expect(esql).toContain('NOW() - 11 minutes');
    expect(esql).toContain('IN ("wallet", "payment")');
  });

  it('pins the silent query to documents carrying a state gauge', () => {
    expect(byName(rules, 'billing-service-silent').esql).toBe(
      [
        'SET unmapped_fields="nullify";',
        'FROM metrics-generic.otel-default*',
        '| WHERE @timestamp > NOW() - 6 hours AND resource.attributes.service.name IN ("wallet", "payment") AND (metrics.billing.outbox.pending IS NOT NULL OR metrics.billing.payment.webhook_backlog IS NOT NULL)',
        '| STATS last_seen = MAX(@timestamp) BY service = resource.attributes.service.name',
        '| WHERE last_seen < NOW() - 5 minutes',
        '| KEEP service',
      ].join('\n'),
    );
  });

  it('keeps only identity columns in the final KEEP so the alert instance id is stable', () => {
    for (const r of rules) {
      expect(r.identityColumns.length).toBeGreaterThan(0);
      const keep = r.esql.split('\n').filter((l) => l.startsWith('| KEEP '));
      expect(keep).toHaveLength(1);
      const cols = keep[0]!
        .slice('| KEEP '.length)
        .split(',')
        .map((c) => c.trim());
      expect(cols).toEqual(r.identityColumns);
    }
  });

  it('pins the two-stage failed-run query (delta per process, then sum per tenant)', () => {
    expect(byName(rules, 'billing-reconciliation-failed-run').esql).toBe(
      [
        'SET unmapped_fields="nullify";',
        'FROM metrics-generic.otel-default*',
        '| WHERE @timestamp > NOW() - 30 minutes AND metrics.billing.reconciliation.runs IS NOT NULL AND attributes.status == "FAILED"',
        '| STATS first_value = MIN(TO_DOUBLE(metrics.billing.reconciliation.runs)), last_value = MAX(TO_DOUBLE(metrics.billing.reconciliation.runs)) BY tenant = attributes.tenant, instance = resource.attributes.service.instance.id',
        '| EVAL delta = last_value - first_value',
        '| STATS failed_runs = SUM(delta) BY tenant',
        '| WHERE failed_runs > 0',
        '| KEEP tenant',
      ].join('\n'),
    );
  });

  it('takes the instance field from FIELDS', () => {
    const fake: Fields = {
      timestamp: 'TS_X',
      service: 'SVC_X',
      serviceInstance: 'INST_X',
      metric: (n) => `M_X<${n}>`,
      attribute: (n) => `A_X<${n}>`,
      metricsIndex: 'idx-x*',
    };
    const esql = byName(buildRules(defaults, fake), 'billing-reconciliation-failed-run').esql;
    expect(esql).toContain('instance = INST_X');
    expect(esql).not.toContain('service.instance.id');
  });
});

describe('toAlertingBody', () => {
  const rules = buildRules(defaults);

  it('has the exact shape for one rule', () => {
    const r = byName(rules, 'billing-dlq-not-empty');
    expect(toAlertingBody(r)).toEqual({
      name: 'billing-dlq-not-empty',
      rule_type_id: '.es-query',
      consumer: 'stackAlerts',
      enabled: true,
      schedule: { interval: '1m' },
      tags: ['billing', 'critical'],
      params: {
        searchType: 'esqlQuery',
        esqlQuery: { esql: r.esql },
        aggType: 'count',
        groupBy: 'row',
        size: 0,
        threshold: [0],
        thresholdComparator: '>',
        timeField: '@timestamp',
        timeWindowSize: 5,
        timeWindowUnit: 'm',
        excludeHitsFromPreviousRun: false,
      },
      actions: [],
    });
  });

  it('uses lookbackHours*60 as the window of the silent rule', () => {
    expect(toAlertingBody(byName(rules, 'billing-service-silent')).params.timeWindowSize).toBe(360);
    expect(toAlertingBody(byName(rules, 'billing-reconciliation-missed')).schedule.interval).toBe(
      '15m',
    );
  });
});

describe('saved objects and ndjson', () => {
  const rules = buildRules(defaults);

  it('builds an alert saved object with reproducible fields', () => {
    const so = toSavedObject(rules[0]!) as {
      type: string;
      id: string;
      attributes: Record<string, unknown>;
    };
    expect(so.type).toBe('alert');
    expect(so.id).toBe(rules[0]!.id);
    expect(so.attributes.enabled).toBe(false);
    expect(so.attributes.alertTypeId).toBe('.es-query');
    expect(so.attributes.createdAt).toBe('2026-10-11T00:00:00.000Z');
    expect(so.attributes.updatedAt).toBe('2026-10-11T00:00:00.000Z');
    expect(so.attributes.executionStatus).toEqual({
      error: null,
      lastExecutionDate: '2026-10-11T00:00:00.000Z',
      status: 'pending',
      warning: null,
    });
    expect(JSON.stringify(toSavedObject(rules[0]!))).toBe(JSON.stringify(toSavedObject(rules[0]!)));
  });

  it('renders 8 objects plus the summary, newline terminated', () => {
    const text = renderAlertsNdjson(rules);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(9);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.slice(0, 8).every((o) => o.type === 'alert')).toBe(true);
    expect(parsed[8]).toEqual({
      excludedObjects: [],
      excludedObjectsCount: 0,
      exportedCount: 8,
      missingRefCount: 0,
      missingReferences: [],
    });
  });

  it('matches the committed deploy/kibana/billing-alerts.ndjson', async () => {
    const committed = await readFile(NDJSON_PATH, 'utf8');
    expect(
      renderAlertsNdjson(rules),
      'billing-alerts.ndjson is stale: run `corepack pnpm kibana:build`',
    ).toBe(committed);
  });
});
