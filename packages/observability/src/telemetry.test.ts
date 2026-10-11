import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { initTelemetry, noopTelemetry, withDeltaGauges } from './telemetry.js';

function recording() {
  const exporter = withDeltaGauges(new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE));
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  const telemetry = initTelemetry({ serviceName: 'unit', env: {}, reader });
  /** Gom giá trị mới nhất của mỗi metric theo tập thuộc tính. */
  const collect = async (): Promise<Map<string, Map<string, number>>> => {
    exporter.reset();
    await reader.forceFlush();
    const out = new Map<string, Map<string, number>>();
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

describe('initTelemetry', () => {
  it('is a no-op without an OTLP endpoint and never throws', async () => {
    const telemetry = initTelemetry({ serviceName: 'unit', env: {} });
    expect(telemetry.enabled).toBe(false);
    telemetry.counter('billing.x', 'x').add(1, { a: 'b' });
    telemetry.gauge('billing.y', 'y').replace([{ value: 1 }]);
    await telemetry.shutdown();
    expect(noopTelemetry.enabled).toBe(false);
  });

  it('records counters per attribute set', async () => {
    const { telemetry, collect } = recording();
    expect(telemetry.enabled).toBe(true);
    const counter = telemetry.counter('billing.order_payments', 'order payments');
    counter.add(1, { tenant: 'acme', outcome: 'paid' });
    counter.add(2, { tenant: 'acme', outcome: 'paid' });
    counter.add(1, { tenant: 'acme', outcome: 'failed:INSUFFICIENT_FUNDS' });

    const metrics = await collect();
    const points = metrics.get('billing.order_payments');
    expect(points?.get(JSON.stringify({ tenant: 'acme', outcome: 'paid' }))).toBe(3);
    expect(
      points?.get(JSON.stringify({ tenant: 'acme', outcome: 'failed:INSUFFICIENT_FUNDS' })),
    ).toBe(1);
    await telemetry.shutdown();
  });

  it('reports gauge samples and drops label sets that are no longer replaced', async () => {
    const { telemetry, collect } = recording();
    const gauge = telemetry.gauge('billing.outbox.pending', 'pending', '{message}');
    gauge.replace([
      { value: 4, attributes: { tenant: 'acme' } },
      { value: 9, attributes: { tenant: 'beta' } },
    ]);
    let points = (await collect()).get('billing.outbox.pending');
    expect(points?.get(JSON.stringify({ tenant: 'acme' }))).toBe(4);
    expect(points?.get(JSON.stringify({ tenant: 'beta' }))).toBe(9);

    gauge.replace([{ value: 1, attributes: { tenant: 'acme' } }]);
    points = (await collect()).get('billing.outbox.pending');
    expect(points?.get(JSON.stringify({ tenant: 'acme' }))).toBe(1);
    expect(points?.has(JSON.stringify({ tenant: 'beta' }))).toBe(false);
    await telemetry.shutdown();
  });

  it('puts the service name on the resource', async () => {
    const exporter = withDeltaGauges(new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE));
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const telemetry = initTelemetry({
      serviceName: 'wallet',
      env: { OTEL_SERVICE_NAME: 'wallet-x' },
      reader,
    });
    telemetry.counter('billing.c', 'c').add(1);
    await reader.forceFlush();
    const resource = exporter.getMetrics()[0]?.resource;
    expect(resource?.attributes['service.name']).toBe('wallet-x');
    await telemetry.shutdown();
  });

  it('puts a per-process service.instance.id on the resource', async () => {
    const idOf = async (env: NodeJS.ProcessEnv): Promise<unknown> => {
      const exporter = withDeltaGauges(
        new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      );
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 3_600_000,
      });
      const telemetry = initTelemetry({ serviceName: 'wallet', env, reader });
      telemetry.counter('billing.c', 'c').add(1);
      await reader.forceFlush();
      const id = exporter.getMetrics()[0]?.resource.attributes['service.instance.id'];
      await telemetry.shutdown();
      return id;
    };
    const a = await idOf({});
    const b = await idOf({});
    expect(typeof a).toBe('string');
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
    expect(await idOf({ OTEL_SERVICE_INSTANCE_ID: ' replica-1 ' })).toBe('replica-1');
  });
});
