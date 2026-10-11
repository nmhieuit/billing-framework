import { createHash } from 'node:crypto';
import { FIELDS as DEFAULT_FIELDS } from './fields.js';
import { stableId } from './ids.js';
import type { Params } from './params.js';
import { lines, type Fields } from './rules.js';

/** Saved object dạng export của Kibana 9.4.x (đủ trường để import lại). */
export interface SavedObject {
  id: string;
  type: 'index-pattern' | 'search' | 'dashboard';
  attributes: Record<string, unknown>;
  references: { id: string; name: string; type: string }[];
  coreMigrationVersion: string;
  typeMigrationVersion: string;
  managed: false;
}
export type DashboardObjects = SavedObject[];

export interface PanelQuery {
  title: string;
  esql: string;
}

/** Điều kiện khoảng thời gian của dashboard; Kibana điền `?_tstart` / `?_tend` cho mọi panel. */
const inRange = (f: Fields): string => `${f.timestamp} >= ?_tstart AND ${f.timestamp} <= ?_tend`;

const GRID_COLS = 48;
const HALF = 24;
const PANEL_HEIGHT = 14;
const HEADER_HEIGHT = 7;

const HEADER_MARKDOWN = [
  '**Billing: vận hành** — sức khoẻ outbox, DLQ, nạp tiền, đối soát và webhook của wallet/payment.',
  '',
  '- Các biểu đồ đếm (đơn thanh toán, consumer, charge, webhook) là **counter tích luỹ**: giá trị về 0 khi service khởi động lại, đó là bình thường chứ không phải mất dữ liệu.',
  '- Biểu đồ dạng gauge (độ sâu DLQ, tuổi thư cũ nhất, backlog) là giá trị lớn nhất trong mỗi phút.',
  '- Đường `threshold` là ngưỡng đang dùng của rule cảnh báo tương ứng (cùng file tham số).',
  '- Hướng dẫn đọc và xử lý: `docs/ops/kibana-alerts-and-dashboard.vi.md`.',
].join('\n');

// ---------------------------------------------------------------------------
// Bộ dựng panel nhỏ: thêm một panel chỉ cần một lời gọi.
// ---------------------------------------------------------------------------

interface Grid {
  w: number;
  h: number;
}

interface YSeries {
  /** Tên cột trong kết quả ES|QL. */
  column: string;
  axis?: 'left' | 'right';
}

interface XySpec {
  key: string;
  title: string;
  esql: string;
  /** Cột trục thời gian. */
  x: string;
  y: YSeries[];
  breakdown?: string;
  yTitle: string;
  grid: Grid;
}

interface SearchSpec {
  key: string;
  title: string;
  description: string;
  esql: string;
  columns: string[];
  grid: Grid;
}

type PanelSpec =
  | { kind: 'xy'; spec: XySpec }
  | { kind: 'search'; spec: SearchSpec; id: string }
  | { kind: 'markdown'; key: string; content: string; grid: Grid };

const xy = (spec: Omit<XySpec, 'grid'>): PanelSpec => ({
  kind: 'xy',
  spec: { ...spec, grid: { w: HALF, h: PANEL_HEIGHT } },
});

const table = (spec: Omit<SearchSpec, 'grid'>): PanelSpec => ({
  kind: 'search',
  id: stableId(`search:${spec.key}`),
  spec: { ...spec, grid: { w: GRID_COLS, h: PANEL_HEIGHT } },
});

const markdownPanel = (key: string, content: string): PanelSpec => ({
  kind: 'markdown',
  key,
  content,
  grid: { w: GRID_COLS, h: HEADER_HEIGHT },
});

const panelId = (key: string): string => stableId(`dashboard:billing-ops:panel:${key}`);

const savedSearchState = (s: SearchSpec): Record<string, unknown> => ({
  columns: s.columns,
  hideChart: true,
  isTextBasedQuery: true,
  kibanaSavedObjectMeta: {
    searchSourceJSON: JSON.stringify({ query: { esql: s.esql }, filter: [] }),
  },
  sort: [],
});

/** Saved search (by-reference) cho panel dạng bảng. */
function searchObject(s: SearchSpec, id: string): SavedObject {
  return {
    id,
    type: 'search',
    attributes: { ...savedSearchState(s), description: s.description, title: s.title },
    references: [],
    coreMigrationVersion: '8.8.0',
    typeMigrationVersion: '10.12.0',
    managed: false,
  };
}

/** Panel Lens XY dựa trên ES|QL (datasource textBased, data view ad hoc theo mẫu export của Kibana). */
function lensPanel(s: XySpec, index: string, id: string, x: number, y: number): unknown {
  const adHocId = `${index}-${createHash('sha256').update(s.esql).digest('hex')}`;
  const columns = [
    { columnId: 'line_0_x', fieldName: s.x, meta: { type: 'date' } },
    ...s.y.map((series, i) => ({
      columnId: `line_0_y_${i}`,
      fieldName: series.column,
      meta: { type: 'number' },
    })),
    ...(s.breakdown
      ? [{ columnId: 'line_0_breakdown', fieldName: s.breakdown, meta: { type: 'string' } }]
      : []),
  ];
  const visualization = {
    preferredSeriesType: 'line',
    legend: { isVisible: true, position: 'right', maxLines: 2 },
    yTitle: s.yTitle,
    yLeftScale: 'linear',
    axisTitlesVisibilitySettings: { x: false, yLeft: true, yRight: true },
    tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
    gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
    xExtent: { mode: 'dataBounds', niceValues: false },
    yLeftExtent: { mode: 'full', niceValues: true },
    labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
    hideEndzones: true,
    showCurrentTimeMarker: false,
    pointVisibility: 'auto',
    curveType: 'LINEAR',
    layers: [
      {
        layerId: 'line_0',
        accessors: s.y.map((_, i) => `line_0_y_${i}`),
        layerType: 'data',
        seriesType: 'line',
        xAccessor: 'line_0_x',
        yConfig: s.y.map((series, i) => ({
          axisMode: series.axis ?? 'left',
          forAccessor: `line_0_y_${i}`,
        })),
        ...(s.breakdown ? { splitAccessors: ['line_0_breakdown'] } : {}),
        colorMapping: {
          colorMode: { type: 'categorical' },
          paletteId: 'elastic_line_optimized',
          assignments: [],
          specialAssignments: [
            { rules: [{ type: 'other' }], color: { type: 'loop' }, touched: false },
          ],
        },
      },
    ],
  };
  return {
    type: 'vis',
    embeddableConfig: {
      title: s.title,
      attributes: {
        visualizationType: 'lnsXY',
        title: '',
        state: {
          datasourceStates: {
            textBased: { layers: { line_0: { index: adHocId, query: { esql: s.esql }, columns } } },
          },
          internalReferences: [
            { type: 'index-pattern', id: adHocId, name: 'indexpattern-datasource-layer-line_0' },
          ],
          visualization,
          adHocDataViews: {
            [adHocId]: {
              id: adHocId,
              title: index,
              name: index,
              sourceFilters: [],
              fieldFormats: {},
              runtimeFieldMap: {},
              fieldAttrs: {},
              allowNoIndex: false,
              allowHidden: false,
              type: 'esql',
            },
          },
          query: { esql: s.esql },
          filters: [],
        },
        references: [],
      },
    },
    panelIndex: id,
    gridData: { x, y, w: s.grid.w, h: s.grid.h, i: id },
  };
}

const searchPanel = (s: SearchSpec, id: string, x: number, y: number): unknown => ({
  type: 'discover_session',
  embeddableConfig: { title: s.title },
  panelIndex: id,
  gridData: { x, y, w: s.grid.w, h: s.grid.h, i: id },
});

const markdownEntry = (content: string, id: string, x: number, y: number, g: Grid): unknown => ({
  type: 'markdown',
  embeddableConfig: { content, settings: { open_links_in_new_tab: false } },
  panelIndex: id,
  gridData: { x, y, w: g.w, h: g.h, i: id },
});

// ---------------------------------------------------------------------------
// Định nghĩa 10 panel dữ liệu.
// ---------------------------------------------------------------------------

function panelSpecs(params: Params, f: Fields): PanelSpec[] {
  const range = inRange(f);
  const ts = f.timestamp;
  const minute = `t = BUCKET(${ts}, 1 minute)`;
  const m = (name: string): string => f.metric(`billing.${name}`);
  const a = (name: string): string => f.attribute(name);
  const rules = params.rules;

  // Gauge theo phút, tách theo một nhãn: giá trị lớn nhất trong phút.
  const gauge = (metric: string, by: string, alias = 'value'): string =>
    lines(
      `FROM ${f.metricsIndex}`,
      `| WHERE ${range} AND ${m(metric)} IS NOT NULL`,
      `| STATS ${alias} = MAX(${m(metric)}) BY ${minute}, ${by} = ${a(by)}`,
      `| SORT t`,
    );

  // Counter tích luỹ theo phút, tách theo các nhãn.
  const counter = (metric: string, labels: string[]): string =>
    lines(
      `FROM ${f.metricsIndex}`,
      `| WHERE ${range} AND ${m(metric)} IS NOT NULL`,
      `| STATS value = MAX(TO_DOUBLE(${m(metric)})) BY ${minute}, ${labels.map((l) => `${l} = ${a(l)}`).join(', ')}`,
      `| SORT t`,
    );

  const outbox = rules['billing-outbox-stuck'];
  const topups = rules['billing-topups-stuck'];
  const stale = rules['billing-reconciliation-stale-cases'];
  const missed = rules['billing-reconciliation-missed'];

  const orderPayments = lines(
    `FROM ${f.metricsIndex}`,
    `| WHERE ${range} AND ${m('order_payments')} IS NOT NULL`,
    `| STATS value = MAX(TO_DOUBLE(${m('order_payments')})) BY ${minute}, series = CONCAT(${a('tenant')}, " / ", ${a('outcome')})`,
    `| SORT t`,
  );

  // Hai họ counter của payment gộp một biểu đồ; tiền tố charge:/webhook: phân biệt chuỗi.
  const charges = m('payment.charges');
  const deliveries = m('payment.webhook_deliveries');
  const paymentFlow = lines(
    `FROM ${f.metricsIndex}`,
    `| WHERE ${range} AND (${charges} IS NOT NULL OR ${deliveries} IS NOT NULL)`,
    `| EVAL series = CASE(${charges} IS NOT NULL, CONCAT("charge:", ${a('status')}), CONCAT("webhook:", ${a('result')})), cumulative = COALESCE(TO_DOUBLE(${charges}), TO_DOUBLE(${deliveries}))`,
    `| STATS value = MAX(cumulative) BY ${minute}, series`,
    `| SORT t`,
  );

  const open = m('reconciliation.open_items');
  const lastSuccess = m('reconciliation.last_success_age_seconds');
  const oldestOpen = m('reconciliation.oldest_open_item_age_seconds');

  return [
    markdownPanel('header', HEADER_MARKDOWN),
    table({
      key: 'billing-active-alerts',
      title: 'Active billing alerts',
      description:
        'Cảnh báo billing đang active (trạng thái hiện tại, không phụ thuộc thanh thời gian).',
      esql: lines(
        'FROM .alerts-stack.alerts-default',
        '| WHERE MV_CONTAINS(kibana.alert.rule.tags, "billing") AND kibana.alert.status == "active"',
        '| KEEP kibana.alert.rule.name, kibana.alert.start, kibana.alert.reason',
        '| SORT kibana.alert.start DESC',
      ),
      columns: ['kibana.alert.rule.name', 'kibana.alert.start', 'kibana.alert.reason'],
    }),
    xy({
      key: 'dlq-depth',
      title: 'DLQ depth',
      esql: gauge('dlq.depth', 'queue', 'depth'),
      x: 't',
      y: [{ column: 'depth' }],
      breakdown: 'queue',
      yTitle: 'Messages',
    }),
    xy({
      key: 'outbox-age',
      title: 'Outbox: oldest unsent age (s) vs threshold',
      esql: lines(
        `FROM ${f.metricsIndex}`,
        `| WHERE ${range} AND ${m('outbox.oldest_age_seconds')} IS NOT NULL`,
        `| STATS age = MAX(${m('outbox.oldest_age_seconds')}) BY ${minute}, tenant = ${a('tenant')}`,
        `| EVAL threshold = ${outbox.thresholdSeconds}`,
        `| SORT t`,
      ),
      x: 't',
      y: [{ column: 'age' }, { column: 'threshold' }],
      breakdown: 'tenant',
      yTitle: 'Seconds',
    }),
    xy({
      key: 'order-payments',
      title: 'Order payments by outcome (cumulative)',
      esql: orderPayments,
      x: 't',
      y: [{ column: 'value' }],
      breakdown: 'series',
      yTitle: 'Count (cumulative)',
    }),
    xy({
      key: 'consumer-messages',
      title: 'Consumer messages by result (cumulative)',
      esql: counter('consumer.messages', ['result']),
      x: 't',
      y: [{ column: 'value' }],
      breakdown: 'result',
      yTitle: 'Count (cumulative)',
    }),
    xy({
      key: 'topups',
      title: 'Top-up backlog and oldest age vs threshold',
      esql: lines(
        `FROM ${f.metricsIndex}`,
        `| WHERE ${range} AND (${m('topups.requested_backlog')} IS NOT NULL OR ${m('topups.oldest_requested_age_seconds')} IS NOT NULL)`,
        `| STATS backlog = MAX(${m('topups.requested_backlog')}), oldest_age = MAX(${m('topups.oldest_requested_age_seconds')}) BY ${minute}`,
        `| EVAL threshold = ${topups.thresholdSeconds}`,
        `| SORT t`,
      ),
      x: 't',
      y: [
        { column: 'backlog', axis: 'left' },
        { column: 'oldest_age', axis: 'right' },
        { column: 'threshold', axis: 'right' },
      ],
      yTitle: 'Backlog (left) / seconds (right)',
    }),
    xy({
      key: 'payment-flow',
      title: 'Payment charges by status and webhook deliveries by result (cumulative)',
      esql: paymentFlow,
      x: 't',
      y: [{ column: 'value' }],
      breakdown: 'series',
      yTitle: 'Count (cumulative)',
    }),
    xy({
      key: 'webhook-backlog',
      title: 'Payment webhook backlog',
      esql: lines(
        `FROM ${f.metricsIndex}`,
        `| WHERE ${range} AND (${m('payment.webhook_backlog')} IS NOT NULL OR ${m('payment.webhook_oldest_age_seconds')} IS NOT NULL)`,
        `| STATS backlog = MAX(${m('payment.webhook_backlog')}), oldest_age = MAX(${m('payment.webhook_oldest_age_seconds')}) BY ${minute}`,
        `| SORT t`,
      ),
      x: 't',
      y: [
        { column: 'backlog', axis: 'left' },
        { column: 'oldest_age', axis: 'right' },
      ],
      yTitle: 'Backlog (left) / seconds (right)',
    }),
    table({
      key: 'billing-open-reconciliation-cases',
      title: 'Open reconciliation cases by kind',
      description:
        'Số mục đối soát đang mở theo tenant và loại (giá trị mới nhất trong khoảng thời gian; loại không còn mục mở thì không xuất hiện).',
      esql: lines(
        `FROM ${f.metricsIndex}`,
        `| WHERE ${range} AND ${open} IS NOT NULL`,
        `| STATS open_items = LAST(${open}, ${ts}) BY tenant = ${a('tenant')}, kind = ${a('kind')}`,
        `| SORT open_items DESC, tenant, kind`,
        `| KEEP tenant, kind, open_items`,
      ),
      columns: ['tenant', 'kind', 'open_items'],
    }),
    table({
      key: 'billing-reconciliation-freshness',
      title: 'Reconciliation freshness',
      description:
        'Tuổi lượt đối soát thành công gần nhất và mục mở cũ nhất theo tenant, kèm ngưỡng của các rule (giây).',
      esql: lines(
        `FROM ${f.metricsIndex}`,
        `| WHERE ${range} AND (${lastSuccess} IS NOT NULL OR ${oldestOpen} IS NOT NULL)`,
        `| STATS last_success_age_s = LAST(${lastSuccess}, ${ts}), oldest_open_item_age_s = LAST(${oldestOpen}, ${ts}) BY tenant = ${a('tenant')}`,
        `| EVAL missed_threshold_s = ${missed.maxAgeHours * 3600}, stale_threshold_s = ${stale.maxAgeHours * 3600}`,
        `| SORT tenant`,
        `| KEEP tenant, last_success_age_s, missed_threshold_s, oldest_open_item_age_s, stale_threshold_s`,
      ),
      columns: [
        'tenant',
        'last_success_age_s',
        'missed_threshold_s',
        'oldest_open_item_age_s',
        'stale_threshold_s',
      ],
    }),
  ];
}

// Thứ tự hiển thị: tiêu đề, cảnh báo đang active, các biểu đồ, rồi hai bảng đối soát.
function orderForLayout(specs: PanelSpec[]): PanelSpec[] {
  const rank = (p: PanelSpec): number => {
    if (p.kind === 'markdown') return 0;
    if (p.kind === 'xy') return 2;
    return p.spec.key === 'billing-active-alerts' ? 1 : 3;
  };
  return specs
    .map((p, i) => ({ p, i }))
    .sort((l, r) => rank(l.p) - rank(r.p) || l.i - r.i)
    .map((e) => e.p);
}

/** Xếp lưới 2 cột (24/48): panel nửa rộng đi theo cặp; panel nửa rộng lẻ cuối hàng được kéo rộng hết cỡ. */
function layout(specs: PanelSpec[]): { spec: PanelSpec; x: number; y: number; w: number }[] {
  const out: { spec: PanelSpec; x: number; y: number; w: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const gridOf = (p: PanelSpec): Grid => (p.kind === 'markdown' ? p.grid : p.spec.grid);
  specs.forEach((spec, i) => {
    const g = gridOf(spec);
    const next = specs[i + 1];
    let w = g.w;
    if (w < GRID_COLS && x === 0 && (!next || gridOf(next).w === GRID_COLS)) w = GRID_COLS;
    if (x + w > GRID_COLS) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    out.push({ spec, x, y, w });
    rowHeight = Math.max(rowHeight, g.h);
    x += w;
    if (x >= GRID_COLS) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
  });
  return out;
}

export function buildDashboard(params: Params, f: Fields = DEFAULT_FIELDS): DashboardObjects {
  const specs = orderForLayout(panelSpecs(params, f));
  const dataViewId = stableId('dataview:billing-metrics');
  const dashboardId = stableId('dashboard:billing-ops');

  const dataView: SavedObject = {
    id: dataViewId,
    type: 'index-pattern',
    attributes: {
      allowHidden: false,
      fieldAttrs: '{}',
      fieldFormatMap: '{}',
      fields: '[]',
      name: 'Billing metrics',
      runtimeFieldMap: '{}',
      sourceFilters: '[]',
      timeFieldName: f.timestamp,
      title: f.metricsIndex,
    },
    references: [],
    coreMigrationVersion: '8.8.0',
    typeMigrationVersion: '8.0.0',
    managed: false,
  };

  const searches: SavedObject[] = [];
  const references: SavedObject['references'] = [];
  const panels: unknown[] = [];
  for (const { spec, x, y, w } of layout(specs)) {
    if (spec.kind === 'markdown') {
      panels.push(markdownEntry(spec.content, panelId(spec.key), x, y, { ...spec.grid, w }));
    } else if (spec.kind === 'xy') {
      panels.push(
        lensPanel(
          { ...spec.spec, grid: { ...spec.spec.grid, w } },
          f.metricsIndex,
          panelId(spec.spec.key),
          x,
          y,
        ),
      );
    } else {
      const id = panelId(spec.spec.key);
      searches.push(searchObject(spec.spec, spec.id));
      references.push({ id: spec.id, name: `${id}:savedObjectRef`, type: 'search' });
      panels.push(searchPanel({ ...spec.spec, grid: { ...spec.spec.grid, w } }, id, x, y));
    }
  }

  const refresh = params.dashboard.refreshSeconds;
  const dashboard: SavedObject = {
    id: dashboardId,
    type: 'dashboard',
    attributes: {
      description:
        'Sức khoẻ vận hành billing (wallet/payment): outbox, DLQ, nạp tiền, đối soát, webhook và cảnh báo đang active. Sinh bởi tools/kibana/dashboard.ts.',
      kibanaSavedObjectMeta: { searchSourceJSON: '{"filter":[]}' },
      optionsJSON: JSON.stringify({
        autoApplyFilters: true,
        hidePanelBorders: false,
        hidePanelTitles: false,
        syncColors: false,
        syncCursor: true,
        syncTooltips: false,
        useMargins: true,
      }),
      panelsJSON: JSON.stringify(panels),
      refreshInterval: { pause: refresh === 0, value: refresh * 1000 },
      timeFrom: params.dashboard.timeRange,
      timeRestore: true,
      timeTo: 'now',
      title: 'Billing: vận hành',
    },
    references,
    coreMigrationVersion: '8.8.0',
    typeMigrationVersion: '10.3.0',
    managed: false,
  };
  return [dataView, ...searches, dashboard];
}

/** Mọi câu ES|QL của dashboard theo thứ tự panel (dùng cho test và để kiểm tra trên Elasticsearch thật). */
export function dashboardQueries(objects: DashboardObjects): PanelQuery[] {
  const dashboard = objects.find((o) => o.type === 'dashboard');
  if (!dashboard) return [];
  const panels = JSON.parse(dashboard.attributes.panelsJSON as string) as {
    type: string;
    panelIndex: string;
    embeddableConfig: { title?: string; attributes?: { state: { query: { esql: string } } } };
  }[];
  const out: PanelQuery[] = [];
  for (const p of panels) {
    const title = p.embeddableConfig.title ?? '';
    if (p.type === 'vis') {
      out.push({ title, esql: p.embeddableConfig.attributes!.state.query.esql });
    } else if (p.type === 'discover_session') {
      const ref = dashboard.references.find((r) => r.name === `${p.panelIndex}:savedObjectRef`)!;
      const search = objects.find((o) => o.type === 'search' && o.id === ref.id)!;
      const meta = search.attributes.kibanaSavedObjectMeta as { searchSourceJSON: string };
      const query = (JSON.parse(meta.searchSourceJSON) as { query: { esql: string } }).query;
      out.push({ title: search.attributes.title as string, esql: query.esql });
    }
  }
  return out;
}

/** Một object mỗi dòng, kèm dòng tóm tắt export ở cuối (giống `renderAlertsNdjson`). */
export function renderDashboardNdjson(objects: DashboardObjects): string {
  const summary = {
    excludedObjects: [],
    excludedObjectsCount: 0,
    exportedCount: objects.length,
    missingRefCount: 0,
    missingReferences: [],
  };
  return [...objects.map((o) => JSON.stringify(o)), JSON.stringify(summary)].join('\n') + '\n';
}
