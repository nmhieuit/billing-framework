import { randomUUID } from 'node:crypto';
import type { Attributes } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';

export type MetricAttributes = Readonly<Record<string, string>>;

export interface Counter {
  add(value: number, attributes?: MetricAttributes): void;
}

export interface GaugeSample {
  value: number;
  attributes?: MetricAttributes;
}

export interface Gauge {
  /** Thay toàn bộ mẫu hiện có: tập thuộc tính không còn trong `samples` sẽ ngừng được báo. */
  replace(samples: readonly GaugeSample[]): void;
}

export interface Telemetry {
  /** `false` khi không cấu hình OTLP: mọi thao tác là no-op. */
  readonly enabled: boolean;
  counter(name: string, description: string): Counter;
  gauge(name: string, description: string, unit?: string): Gauge;
  shutdown(): Promise<void>;
}

const noopCounter: Counter = { add: () => undefined };
const noopGauge: Gauge = { replace: () => undefined };

export const noopTelemetry: Telemetry = {
  enabled: false,
  counter: () => noopCounter,
  gauge: () => noopGauge,
  shutdown: () => Promise.resolve(),
};

export interface TelemetryOptions {
  serviceName: string;
  env?: NodeJS.ProcessEnv;
  /** Dùng trong test: reader tùy ý thay cho exporter OTLP. */
  reader?: MetricReader;
  exportIntervalMs?: number;
}

const DEFAULT_EXPORT_INTERVAL_MS = 10_000;

/**
 * SDK ở chế độ cumulative giữ mãi mọi tập thuộc tính từng được quan sát, nên gauge sẽ không bao giờ "quên" nhãn cũ.
 * Ép gauge sang delta (gauge OTLP không mang temporality) để chỉ báo các mẫu của lần `replace` gần nhất;
 * counter giữ nguyên temporality gốc của exporter.
 */
export function withDeltaGauges<T extends PushMetricExporter>(exporter: T): T {
  const base = exporter.selectAggregationTemporality?.bind(exporter);
  exporter.selectAggregationTemporality = (type) =>
    type === InstrumentType.OBSERVABLE_GAUGE
      ? AggregationTemporality.DELTA
      : (base?.(type) ?? AggregationTemporality.CUMULATIVE);
  return exporter;
}

/**
 * Khởi tạo xuất metric OTLP/gRPC. Không có `OTEL_EXPORTER_OTLP_ENDPOINT` (và không truyền `reader`) thì trả về
 * `noopTelemetry`, nên chạy trần và test không đổi hành vi.
 */
export function initTelemetry(options: TelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  let reader = options.reader;
  if (!reader) {
    if (!endpoint) return noopTelemetry;
    reader = new PeriodicExportingMetricReader({
      exporter: withDeltaGauges(new OTLPMetricExporter({ url: endpoint })),
      exportIntervalMillis: options.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS,
    });
  }

  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME?.trim() || options.serviceName,
      // Mỗi tiến trình một series riêng: counter reset sau restart không bị trộn với bản trước.
      'service.instance.id': env.OTEL_SERVICE_INSTANCE_ID?.trim() || randomUUID(),
    }),
    readers: [reader],
  });
  const meter = provider.getMeter('billing');

  return {
    enabled: true,
    counter(name, description) {
      const counter = meter.createCounter(name, { description });
      return {
        add: (value, attributes) => counter.add(value, attributes as Attributes | undefined),
      };
    },
    gauge(name, description, unit) {
      let samples: readonly GaugeSample[] = [];
      const gauge = meter.createObservableGauge(name, { description, ...(unit ? { unit } : {}) });
      gauge.addCallback((result) => {
        for (const sample of samples) {
          result.observe(sample.value, sample.attributes as Attributes | undefined);
        }
      });
      return {
        replace(next) {
          samples = [...next];
        },
      };
    },
    shutdown: () => provider.shutdown(),
  };
}
