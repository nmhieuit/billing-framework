import { FIELDS as DEFAULT_FIELDS } from './fields.js';
import { stableId } from './ids.js';
import type { Params, RuleName, Severity } from './params.js';

/** Hình dạng của FIELDS (kiểu rộng để test có thể thay bằng tên trường khác). */
export interface Fields {
  timestamp: string;
  service: string;
  serviceInstance: string;
  metric: (name: string) => string;
  attribute: (name: string) => string;
  metricsIndex: string;
}

export interface RuleDefinition {
  id: string;
  name: RuleName;
  description: string;
  tags: string[];
  enabled: boolean;
  severity: Severity;
  intervalMinutes: number;
  windowMinutes: number;
  /**
   * Cột định danh của alert: là các cột DUY NHẤT được phép có trong `KEEP` cuối của câu ES|QL.
   * Kibana 9.4 dựng id instance của alert (groupBy `row`) từ MỌI cột đầu ra, nên nếu để cột giá trị
   * (tuổi, độ sâu, ...) vào đó thì mỗi lần giá trị đổi lại sinh alert mới và alert cũ bị recovered.
   */
  identityColumns: string[];
  esql: string;
}

/** Mốc thời gian cố định để file xuất ra luôn tái tạo được. */
const FIXED_TIME = '2026-10-11T00:00:00.000Z';

/**
 * Phiên bản Elasticsearch/Kibana tối thiểu mà các câu ES|QL do generator sinh ra chạy được.
 * Lý do: mọi câu bắt đầu bằng `SET unmapped_fields="nullify";` (xem `lines`), cú pháp này cần >= 9.4.
 * `kibana:apply` (Task 10) dùng hằng này để báo lỗi rõ ràng trên stack cũ hơn.
 */
export const MIN_STACK_VERSION = '9.4.0';

// Gom các dòng ES|QL: mỗi pipe một dòng cho dễ đọc khi review.
// Dòng SET đầu tiên khiến trường/metric chưa tồn tại (chưa có dữ liệu) thành null thay vì lỗi
// "Unknown column", nên rule chỉ trả 0 dòng thay vì báo lỗi ở lần chạy đầu. Cần Elasticsearch/Kibana >= 9.4
// (xem MIN_STACK_VERSION); trên bản cũ hơn câu truy vấn sẽ bị từ chối.
export const lines = (...parts: string[]): string =>
  ['SET unmapped_fields="nullify";', ...parts].join('\n');

// Mẫu chung cho nhóm rule "tuổi/độ sâu hiện tại" theo tenant (hoặc nhãn khác).
interface GaugeSpec {
  f: Fields;
  window: number;
  metric: string;
  /** Hàm gộp trên cửa sổ, ví dụ `LAST(x, ts)` hoặc `MIN(x)`. */
  agg: (field: string) => string;
  alias: string;
  label: string;
  by: string;
  threshold: number;
}

function gaugeQuery(s: GaugeSpec): string {
  const field = s.f.metric(s.metric);
  return lines(
    `FROM ${s.f.metricsIndex}`,
    `| WHERE ${s.f.timestamp} > NOW() - ${s.window} minutes AND ${field} IS NOT NULL`,
    `| STATS ${s.alias} = ${s.agg(field)} BY ${s.label} = ${s.f.attribute(s.by)}`,
    `| WHERE ${s.alias} > ${s.threshold}`,
    `| KEEP ${s.label}`,
  );
}

// Giá trị mới nhất trong cửa sổ: giá trị đã hồi phục sẽ thôi cảnh báo ngay.
const last = (f: Fields) => (field: string) => `LAST(${field}, ${f.timestamp})`;

export function dlqNotEmptyEsql(f: Fields, window: number, minDepth: number): string {
  return gaugeQuery({
    f,
    window,
    metric: 'billing.dlq.depth',
    agg: (x) => `MIN(${x})`,
    alias: 'min_depth',
    label: 'queue',
    by: 'queue',
    threshold: minDepth,
  });
}

export function outboxStuckEsql(f: Fields, window: number, thresholdSeconds: number): string {
  return gaugeQuery({
    f,
    window,
    metric: 'billing.outbox.oldest_age_seconds',
    agg: last(f),
    alias: 'age',
    label: 'tenant',
    by: 'tenant',
    threshold: thresholdSeconds,
  });
}

export function topupsStuckEsql(f: Fields, window: number, thresholdSeconds: number): string {
  return gaugeQuery({
    f,
    window,
    metric: 'billing.topups.oldest_requested_age_seconds',
    agg: last(f),
    alias: 'age',
    label: 'tenant',
    by: 'tenant',
    threshold: thresholdSeconds,
  });
}

export function ledgerIntegrityEsql(f: Fields, window: number, minOpenItems: number): string {
  const open = f.metric('billing.reconciliation.open_items');
  return lines(
    `FROM ${f.metricsIndex}`,
    `| WHERE ${f.timestamp} > NOW() - ${window} minutes AND ${open} IS NOT NULL AND ${f.attribute('kind')} IN ("LEDGER_UNBALANCED", "BALANCE_MISMATCH")`,
    `| STATS open = LAST(${open}, ${f.timestamp}) BY tenant = ${f.attribute('tenant')}, kind = ${f.attribute('kind')}`,
    `| WHERE open > ${minOpenItems}`,
    `| KEEP tenant, kind`,
  );
}

export function staleCasesEsql(f: Fields, window: number, maxAgeHours: number): string {
  return gaugeQuery({
    f,
    window,
    metric: 'billing.reconciliation.oldest_open_item_age_seconds',
    agg: last(f),
    alias: 'age',
    label: 'tenant',
    by: 'tenant',
    threshold: maxAgeHours * 3600,
  });
}

export function reconciliationMissedEsql(f: Fields, window: number, maxAgeHours: number): string {
  return gaugeQuery({
    f,
    window,
    metric: 'billing.reconciliation.last_success_age_seconds',
    agg: last(f),
    alias: 'age',
    label: 'tenant',
    by: 'tenant',
    threshold: maxAgeHours * 3600,
  });
}

export function failedRunEsql(f: Fields, window: number): string {
  const runs = f.metric('billing.reconciliation.runs');
  return lines(
    `FROM ${f.metricsIndex}`,
    `| WHERE ${f.timestamp} > NOW() - ${window} minutes AND ${runs} IS NOT NULL AND ${f.attribute('status')} == "FAILED"`,
    `| STATS first_value = MIN(TO_DOUBLE(${runs})), last_value = MAX(TO_DOUBLE(${runs})) BY tenant = ${f.attribute('tenant')}, instance = ${f.serviceInstance}`,
    `| EVAL delta = last_value - first_value`,
    `| STATS failed_runs = SUM(delta) BY tenant`,
    `| WHERE failed_runs > 0`,
    `| KEEP tenant`,
  );
}

export function serviceSilentEsql(f: Fields, lookbackHours: number, silentMinutes: number): string {
  return lines(
    `FROM ${f.metricsIndex}`,
    // Chỉ tính tài liệu có gauge trạng thái: dịch vụ vẫn sống (counter/dlq.depth còn chảy) nhưng không lấy mẫu được thì vẫn bị coi là im lặng.
    `| WHERE ${f.timestamp} > NOW() - ${lookbackHours} hours AND ${f.service} IN ("wallet", "payment") AND (${f.metric('billing.outbox.pending')} IS NOT NULL OR ${f.metric('billing.payment.webhook_backlog')} IS NOT NULL)`,
    `| STATS last_seen = MAX(${f.timestamp}) BY service = ${f.service}`,
    `| WHERE last_seen < NOW() - ${silentMinutes} minutes`,
    `| KEEP service`,
  );
}

export function retentionStalledEsql(
  f: Fields,
  lookbackHours: number,
  maxAgeHours: number,
): string {
  const ok = f.metric('billing.retention.last_success_timestamp_seconds');
  return lines(
    `FROM ${f.metricsIndex}`,
    // Gauge là epoch giây của lần retention thành công gần nhất; so với NOW() (mili giây) đổi sang giây.
    `| WHERE ${f.timestamp} > NOW() - ${lookbackHours} hours AND ${ok} IS NOT NULL`,
    `| STATS last_ok = LAST(${ok}, ${f.timestamp}) BY service = ${f.service}`,
    `| WHERE last_ok < TO_LONG(NOW()) / 1000 - ${maxAgeHours * 3600}`,
    `| KEEP service`,
  );
}

export function buildRules(params: Params, f: Fields = DEFAULT_FIELDS): RuleDefinition[] {
  const r = params.rules;
  const make = (
    name: RuleName,
    description: string,
    esql: string,
    identityColumns: string[],
    windowMinutes?: number,
  ): RuleDefinition => {
    const p = r[name];
    return {
      id: stableId(name),
      name,
      description,
      tags: ['billing', p.severity],
      enabled: p.enabled,
      severity: p.severity,
      intervalMinutes: p.intervalMinutes,
      windowMinutes: windowMinutes ?? p.windowMinutes,
      identityColumns,
      esql,
    };
  };
  const w = (name: RuleName): number => r[name].windowMinutes;
  const dlq = r['billing-dlq-not-empty'];
  const outbox = r['billing-outbox-stuck'];
  const topups = r['billing-topups-stuck'];
  const ledger = r['billing-ledger-integrity'];
  const stale = r['billing-reconciliation-stale-cases'];
  const missed = r['billing-reconciliation-missed'];
  const silent = r['billing-service-silent'];
  const retention = r['billing-retention-stalled'];

  return [
    make(
      'billing-dlq-not-empty',
      `Hàng đợi DLQ luôn có thư (độ sâu > ${dlq.minDepth} liên tục trong ${dlq.windowMinutes} phút). Mở docs/integration/dlq-runbook.vi.md để xử lý.`,
      dlqNotEmptyEsql(f, w('billing-dlq-not-empty'), dlq.minDepth),
      ['queue'],
    ),
    make(
      'billing-outbox-stuck',
      `Outbox có thư chờ quá ${outbox.thresholdSeconds} giây chưa gửi. Mở docs/integration/orders-handoff.vi.md để kiểm tra.`,
      outboxStuckEsql(f, w('billing-outbox-stuck'), outbox.thresholdSeconds),
      ['tenant'],
    ),
    make(
      'billing-topups-stuck',
      `Yêu cầu nạp tiền chờ quá ${topups.thresholdSeconds} giây chưa hoàn tất. Xem README.md mục ví (wallet).`,
      topupsStuckEsql(f, w('billing-topups-stuck'), topups.thresholdSeconds),
      ['tenant'],
    ),
    make(
      'billing-ledger-integrity',
      `Sổ cái không cân hoặc số dư lệch (số mục mở > ${ledger.minOpenItems}). Mở docs/integration/reconciliation-runbook.vi.md để xử lý.`,
      ledgerIntegrityEsql(f, w('billing-ledger-integrity'), ledger.minOpenItems),
      ['tenant', 'kind'],
    ),
    make(
      'billing-reconciliation-stale-cases',
      `Có mục đối soát mở quá ${stale.maxAgeHours} giờ chưa xử lý. Mở docs/integration/reconciliation-runbook.vi.md.`,
      staleCasesEsql(f, w('billing-reconciliation-stale-cases'), stale.maxAgeHours),
      ['tenant'],
    ),
    make(
      'billing-reconciliation-missed',
      `Đối soát hằng ngày chưa chạy thành công quá ${missed.maxAgeHours} giờ. Mở docs/integration/reconciliation-runbook.vi.md.`,
      reconciliationMissedEsql(f, w('billing-reconciliation-missed'), missed.maxAgeHours),
      ['tenant'],
    ),
    make(
      'billing-reconciliation-failed-run',
      `Lượt đối soát bị FAILED trong ${r['billing-reconciliation-failed-run'].windowMinutes} phút gần đây. Mở docs/integration/reconciliation-runbook.vi.md.`,
      failedRunEsql(f, w('billing-reconciliation-failed-run')),
      ['tenant'],
    ),
    make(
      'billing-service-silent',
      `Dịch vụ wallet hoặc payment không gửi metric quá ${silent.silentMinutes} phút (nhìn lại ${silent.lookbackHours} giờ). Xem README.md mục ví (wallet).`,
      serviceSilentEsql(f, silent.lookbackHours, silent.silentMinutes),
      ['service'],
      silent.lookbackHours * 60,
    ),
    make(
      'billing-retention-stalled',
      `Retention của wallet hoặc payment chưa chạy thành công quá ${retention.maxAgeHours} giờ (nhìn lại ${retention.lookbackHours} giờ). Mở docs/ops/retention.vi.md.`,
      retentionStalledEsql(f, retention.lookbackHours, retention.maxAgeHours),
      ['service'],
      retention.lookbackHours * 60,
    ),
  ];
}

export interface AlertingBody {
  name: string;
  rule_type_id: '.es-query';
  consumer: 'stackAlerts';
  enabled: boolean;
  schedule: { interval: string };
  tags: string[];
  params: {
    searchType: 'esqlQuery';
    esqlQuery: { esql: string };
    aggType: 'count';
    groupBy: 'row';
    size: 0;
    threshold: [0];
    thresholdComparator: '>';
    timeField: string;
    timeWindowSize: number;
    timeWindowUnit: 'm';
    excludeHitsFromPreviousRun: false;
  };
  actions: [];
}

function ruleParams(rule: RuleDefinition, timeField: string): AlertingBody['params'] {
  return {
    searchType: 'esqlQuery',
    esqlQuery: { esql: rule.esql },
    aggType: 'count',
    groupBy: 'row',
    size: 0,
    threshold: [0],
    thresholdComparator: '>',
    timeField,
    timeWindowSize: rule.windowMinutes,
    timeWindowUnit: 'm',
    excludeHitsFromPreviousRun: false,
  };
}

/** Body cho `POST /api/alerting/rule/{id}`. */
export function toAlertingBody(rule: RuleDefinition): AlertingBody {
  return {
    name: rule.name,
    rule_type_id: '.es-query',
    consumer: 'stackAlerts',
    enabled: rule.enabled,
    schedule: { interval: `${rule.intervalMinutes}m` },
    tags: rule.tags,
    params: ruleParams(rule, DEFAULT_FIELDS.timestamp),
    actions: [],
  };
}

/** Saved object dạng export của Kibana 9.4.4 (import luôn tới ở trạng thái tắt). */
export function toSavedObject(rule: RuleDefinition): object {
  return {
    attributes: {
      actions: [],
      alertTypeId: '.es-query',
      apiKey: null,
      apiKeyCreatedByUser: null,
      apiKeyOwner: null,
      artifacts: { dashboards: [], investigation_guide: { blob: '' } },
      consumer: 'stackAlerts',
      createdAt: FIXED_TIME,
      createdBy: null,
      enabled: false,
      // Kibana bắt buộc có executionStatus khi import; dùng giá trị cố định để file tái tạo được.
      executionStatus: {
        error: null,
        lastExecutionDate: FIXED_TIME,
        status: 'pending',
        warning: null,
      },
      lastEnabledAt: FIXED_TIME,
      legacyId: null,
      meta: { versionApiKeyLastmodified: '9.4.4' },
      muteAll: false,
      mutedInstanceIds: [],
      name: rule.name,
      notifyWhen: null,
      params: ruleParams(rule, DEFAULT_FIELDS.timestamp),
      revision: 0,
      running: false,
      schedule: { interval: `${rule.intervalMinutes}m` },
      scheduledTaskId: null,
      snoozeSchedule: [],
      tags: rule.tags,
      throttle: null,
      uiamApiKey: null,
      updatedAt: FIXED_TIME,
      updatedBy: null,
    },
    coreMigrationVersion: '8.8.0',
    id: rule.id,
    managed: false,
    references: [],
    type: 'alert',
    typeMigrationVersion: '10.12.0',
  };
}

/** Các saved object, mỗi dòng một JSON, kèm dòng tóm tắt export ở cuối. */
export function renderAlertsNdjson(rules: RuleDefinition[]): string {
  const summary = {
    excludedObjects: [],
    excludedObjectsCount: 0,
    exportedCount: rules.length,
    missingRefCount: 0,
    missingReferences: [],
  };
  return (
    [...rules.map((r) => JSON.stringify(toSavedObject(r))), JSON.stringify(summary)].join('\n') +
    '\n'
  );
}
