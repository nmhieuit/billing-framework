import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { initTelemetry, withDeltaGauges, type Telemetry } from './telemetry.js';

/** Giá trị mới nhất của mỗi metric, gom theo tên rồi theo tập thuộc tính (JSON của thuộc tính). */
export type CollectedMetrics = Map<string, Map<string, number>>;

/**
 * Dành cho test: `Telemetry` thật ghi vào bộ nhớ (gauge ép sang delta như exporter OTLP), kèm `collect()`
 * để đọc lại những gì sẽ được xuất. Không dùng ở mã chạy thật.
 */
export function recordingTelemetry(): {
  telemetry: Telemetry;
  collect(): Promise<CollectedMetrics>;
} {
  const exporter = withDeltaGauges(new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE));
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const telemetry = initTelemetry({ serviceName: 'unit', env: {}, reader });
  const collect = async (): Promise<CollectedMetrics> => {
    exporter.reset();
    await reader.forceFlush();
    const out: CollectedMetrics = new Map();
    for (const resourceMetrics of exporter.getMetrics()) {
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) {
          const byAttributes = out.get(metric.descriptor.name) ?? new Map<string, number>();
          for (const point of metric.dataPoints) {
            byAttributes.set(JSON.stringify(point.attributes), Number(point.value));
          }
          out.set(metric.descriptor.name, byAttributes);
        }
      }
    }
    return out;
  };
  return { telemetry, collect };
}
