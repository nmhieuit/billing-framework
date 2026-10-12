import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDashboard,
  dashboardQueries,
  renderDashboardNdjson,
  type SavedObject,
} from './dashboard.js';
import { FIELDS } from './fields.js';
import { stableId } from './ids.js';
import type { Params } from './params.js';
import type { Fields } from './rules.js';

const DEFAULTS_PATH = resolve(import.meta.dirname, '../../deploy/kibana/params.defaults.json');
const NDJSON_PATH = resolve(import.meta.dirname, '../../deploy/kibana/billing-dashboard.ndjson');
const defaults = JSON.parse(await readFile(DEFAULTS_PATH, 'utf8')) as Params;
const clone = (): Params => structuredClone(defaults);

const DASHBOARD_ID = stableId('dashboard:billing-ops');

interface Panel {
  type: string;
  panelIndex: string;
  gridData: { x: number; y: number; w: number; h: number; i: string };
  embeddableConfig: Record<string, unknown>;
}

const dashboardOf = (objects: SavedObject[]): SavedObject =>
  objects.find((o) => o.type === 'dashboard')!;
const panelsOf = (objects: SavedObject[]): Panel[] =>
  JSON.parse(dashboardOf(objects).attributes.panelsJSON as string) as Panel[];
const dataPanels = (objects: SavedObject[]): Panel[] =>
  panelsOf(objects).filter((p) => p.type !== 'markdown');

describe('buildDashboard envelope', () => {
  const objects = buildDashboard(defaults);
  const dash = dashboardOf(objects);

  it('has the stable id, title, time range and refresh from params', () => {
    expect(dash.id).toBe(DASHBOARD_ID);
    expect(dash.attributes.title).toBe('Billing: vận hành');
    expect(dash.attributes.timeRestore).toBe(true);
    expect(dash.attributes.timeFrom).toBe(defaults.dashboard.timeRange);
    expect(dash.attributes.timeTo).toBe('now');
    expect(dash.attributes.refreshInterval).toEqual({ pause: false, value: 60_000 });
  });

  it('pauses the refresh when refreshSeconds is 0', () => {
    const p = clone();
    p.dashboard.refreshSeconds = 0;
    p.dashboard.timeRange = 'now-2h';
    const d = dashboardOf(buildDashboard(p));
    expect(d.attributes.refreshInterval).toEqual({ pause: true, value: 0 });
    expect(d.attributes.timeFrom).toBe('now-2h');
  });

  it('puts the data view and saved searches before the dashboard', () => {
    expect(objects.at(-1)!.type).toBe('dashboard');
    expect(objects[0]!.type).toBe('index-pattern');
    expect(objects.filter((o) => o.type === 'search')).toHaveLength(3);
  });
});

describe('panels', () => {
  const objects = buildDashboard(defaults);

  it('has 12 data panels plus 1 markdown header, parsed from panelsJSON', () => {
    const panels = panelsOf(objects);
    expect(panels).toHaveLength(13);
    expect(panels.filter((p) => p.type === 'markdown')).toHaveLength(1);
    expect(dataPanels(objects)).toHaveLength(12);
    expect(panels[0]!.type).toBe('markdown');
    const md = panels[0]!.embeddableConfig.content as string;
    expect(md).toContain('docs/ops/kibana-alerts-and-dashboard.vi.md');
    expect(md).toMatch(/khởi động lại/);
  });

  it('keeps grid cells inside the 48-column board', () => {
    for (const p of panelsOf(objects)) {
      expect(p.gridData.x + p.gridData.w).toBeLessThanOrEqual(48);
      expect(p.gridData.i).toBe(p.panelIndex);
    }
  });

  it('matches the multi-valued rule tags with MV_CONTAINS (== on a multi-value field yields no rows)', () => {
    const alerts = dashboardQueries(objects).find((q) => q.esql.includes('.alerts-stack'))!;
    expect(alerts.esql).toContain('MV_CONTAINS(kibana.alert.rule.tags, "billing")');
    expect(alerts.esql).not.toMatch(/kibana\.alert\.rule\.tags\s*==/);
  });

  it('filters metric queries by the dashboard time range and nullifies unmapped fields', () => {
    const queries = dashboardQueries(objects);
    expect(queries).toHaveLength(12);
    for (const q of queries) {
      expect(q.esql.startsWith('SET unmapped_fields="nullify";\n')).toBe(true);
      if (!q.esql.includes('.alerts-stack')) {
        expect(q.esql).toContain('@timestamp >= ?_tstart AND @timestamp <= ?_tend');
      }
    }
  });

  it('uses only FIELDS-derived names (stubbed FIELDS with unusual names)', () => {
    const stub: Fields = {
      timestamp: 'ts_x',
      service: 'svc_x',
      serviceInstance: 'inst_x',
      metric: (n) => `m_x.${n}`,
      attribute: (n) => `a_x.${n}`,
      metricsIndex: 'idx-x*',
    };
    const queries = dashboardQueries(buildDashboard(defaults, stub));
    for (const q of queries) {
      if (q.esql.includes('.alerts-stack')) continue;
      expect(q.esql).not.toMatch(
        /@timestamp|resource\.attributes|metrics\.|(?<![a-z_])attributes\./,
      );
      expect(q.esql).toContain('FROM idx-x*');
      expect(q.esql).toContain('ts_x >= ?_tstart');
      expect(q.esql).toMatch(/m_x\.billing\./);
    }
    // Panel cảnh báo đọc chỉ mục cảnh báo của Kibana, không thuộc FIELDS.
    expect(queries.filter((q) => q.esql.includes('.alerts-stack'))).toHaveLength(1);
  });

  it('changing the outbox threshold changes only panel 2', () => {
    const p = clone();
    p.rules['billing-outbox-stuck'].thresholdSeconds = 600;
    const changed = buildDashboard(p);
    const before = dashboardQueries(objects);
    const after = dashboardQueries(changed);
    const diff = after.filter((q, i) => q.esql !== before[i]!.esql);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.esql).toContain('threshold = 600');
    expect(diff[0]!.title).toMatch(/Outbox/);
    expect(before.find((q) => q.title === diff[0]!.title)!.esql).toContain('threshold = 300');
    // Ngoài hằng ngưỡng của panel 2, phần còn lại của dashboard giữ nguyên.
    // Tên data view ad hoc có hậu tố băm theo query nên bỏ hậu tố trước khi so sánh.
    const strip = (o: SavedObject[]): string =>
      JSON.stringify(o)
        .replaceAll('threshold = 600', 'T')
        .replaceAll('threshold = 300', 'T')
        .replace(/-[0-9a-f]{64}/g, '');
    expect(strip(changed)).toBe(strip(objects));
  });

  it('pins the two retention panels (cumulative rows, seconds since last success) before the tables', () => {
    const queries = dashboardQueries(objects);
    const titles = queries.map((q) => q.title);
    const rows = queries.find((q) => q.title.startsWith('Retention: số dòng'))!;
    const age = queries.find((q) => q.title.startsWith('Retention: số giây'))!;
    expect(titles.indexOf(rows.title)).toBeLessThan(
      titles.indexOf('Open reconciliation cases by kind'),
    );
    expect(titles.indexOf(age.title)).toBeLessThan(
      titles.indexOf('Open reconciliation cases by kind'),
    );
    expect(rows.esql).toBe(
      [
        'SET unmapped_fields="nullify";',
        'FROM metrics-generic.otel-default*',
        '| WHERE @timestamp >= ?_tstart AND @timestamp <= ?_tend AND metrics.billing.retention.rows IS NOT NULL',
        '| STATS m = MAX(metrics.billing.retention.rows) BY t = BUCKET(@timestamp, 1 minute), tenant = attributes.tenant, table = attributes.table, mode = attributes.mode',
        '| STATS rows = SUM(m) BY t, series = CONCAT(table, " / ", mode)',
        '| KEEP t, series, rows',
        '| SORT t',
      ].join('\n'),
    );
    expect(age.esql).toBe(
      [
        'SET unmapped_fields="nullify";',
        'FROM metrics-generic.otel-default*',
        '| WHERE @timestamp >= ?_tstart AND @timestamp <= ?_tend AND metrics.billing.retention.last_success_timestamp_seconds IS NOT NULL',
        '| STATS ts_ok = LAST(metrics.billing.retention.last_success_timestamp_seconds, @timestamp) BY t = BUCKET(@timestamp, 1 minute), service = resource.attributes.service.name',
        '| EVAL age_seconds = TO_LONG(t) / 1000 - ts_ok, threshold = 10800',
        '| KEEP t, service, age_seconds, threshold',
        '| SORT t',
      ].join('\n'),
    );
  });

  it('binds the retention age threshold to billing-retention-stalled.maxAgeHours', () => {
    const p = clone();
    p.rules['billing-retention-stalled'].maxAgeHours = 5;
    const find = (o: SavedObject[]) =>
      dashboardQueries(o).find((q) => q.title.startsWith('Retention: số giây'))!.esql;
    expect(find(buildDashboard(p))).toContain('threshold = 18000');
    expect(find(objects)).toContain('threshold = 10800');
    const before = dashboardQueries(objects);
    const diff = dashboardQueries(buildDashboard(p)).filter((q, i) => q.esql !== before[i]!.esql);
    expect(diff).toHaveLength(1);
  });

  it('shows reconciliation thresholds from params as table columns', () => {
    const p = clone();
    p.rules['billing-reconciliation-missed'].maxAgeHours = 30;
    const fresh = dashboardQueries(buildDashboard(p)).find((q) => q.title.includes('freshness'))!;
    expect(fresh.esql).toContain(`missed_threshold_s = ${30 * 3600}`);
    expect(fresh.esql).toContain(
      `stale_threshold_s = ${defaults.rules['billing-reconciliation-stale-cases'].maxAgeHours * 3600}`,
    );
  });
});

describe('saved objects', () => {
  const objects = buildDashboard(defaults);

  it('has stable, unique ids for the saved searches', () => {
    const searches = objects.filter((o) => o.type === 'search');
    expect(searches.map((s) => s.id)).toEqual([
      stableId('search:billing-active-alerts'),
      stableId('search:billing-open-reconciliation-cases'),
      stableId('search:billing-reconciliation-freshness'),
    ]);
    expect(new Set(objects.map((o) => `${o.type}:${o.id}`)).size).toBe(objects.length);
    expect(buildDashboard(defaults)).toEqual(objects);
  });

  it('resolves every reference to an object in the same file', () => {
    const ids = new Set(objects.map((o) => `${o.type}:${o.id}`));
    const panelIds = new Set(panelsOf(objects).map((p) => p.panelIndex));
    for (const o of objects)
      for (const r of o.references) {
        expect(ids.has(`${r.type}:${r.id}`), `${o.type}/${o.id} -> ${r.type}/${r.id}`).toBe(true);
        if (o.type === 'dashboard') expect(panelIds.has(r.name.split(':')[0]!)).toBe(true);
      }
    // Mỗi panel saved search đều có reference tương ứng.
    const refs = dashboardOf(objects).references.filter((r) => r.type === 'search');
    expect(refs).toHaveLength(3);
  });
});

describe('renderDashboardNdjson', () => {
  const objects = buildDashboard(defaults);

  it('writes one object per line plus the export summary and a trailing newline', () => {
    const text = renderDashboardNdjson(objects);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(objects.length + 1);
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      excludedObjects: [],
      excludedObjectsCount: 0,
      exportedCount: objects.length,
      missingRefCount: 0,
      missingReferences: [],
    });
  });

  it('matches the committed deploy/kibana/billing-dashboard.ndjson', async () => {
    const committed = await readFile(NDJSON_PATH, 'utf8');
    expect(
      renderDashboardNdjson(buildDashboard(defaults, FIELDS)),
      'billing-dashboard.ndjson is stale: run `corepack pnpm kibana:build`',
    ).toBe(committed);
  });
});
