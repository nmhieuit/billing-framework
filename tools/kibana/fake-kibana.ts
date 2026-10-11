import type { FetchImpl, KibanaRule } from './client.js';

export interface FakeCall {
  method: string;
  path: string;
}

export interface FakeKibanaOptions {
  version?: string;
  /** Trạng thái lần lượt trả về cho `/api/status`; phần tử cuối được lặp lại. */
  statusLevels?: string[];
  /** Nếu đặt, `_import` trả payload lỗi này. */
  importErrors?: unknown[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const UPDATE_KEYS = ['name', 'tags', 'schedule', 'params', 'actions'];

/** Kibana giả trong bộ nhớ: đủ các endpoint Alerting, status và saved-objects import mà client dùng. */
export class FakeKibana {
  readonly rules = new Map<string, KibanaRule>();
  readonly calls: FakeCall[] = [];
  /** Body JSON của các lời gọi có body, theo thứ tự gửi. */
  readonly bodies: Array<FakeCall & { body: Record<string, unknown> }> = [];
  /** Id các dashboard đã import. */
  readonly dashboards = new Set<string>();
  readonly imports: Array<{ ndjson: string; overwrite: boolean }> = [];
  readonly headers: Array<Record<string, string>> = [];
  private statusIndex = 0;

  constructor(private readonly options: FakeKibanaOptions = {}) {}

  /** Các lời gọi ghi (khác GET). */
  get writeCalls(): FakeCall[] {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  readonly fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    this.calls.push({ method, path });
    if (typeof init?.body === 'string') {
      this.bodies.push({ method, path, body: JSON.parse(init.body) as Record<string, unknown> });
    }
    this.headers.push((init?.headers ?? {}) as Record<string, string>);

    if (method === 'GET' && path === '/api/status') {
      const levels = this.options.statusLevels ?? ['available'];
      const level = levels[Math.min(this.statusIndex, levels.length - 1)]!;
      this.statusIndex += 1;
      return json(200, {
        version: { number: this.options.version ?? '9.4.4' },
        status: { overall: { level } },
      });
    }

    if (method === 'GET' && path === '/api/alerting/rules/_find') {
      const search = url.searchParams.get('search') ?? '';
      const data = [...this.rules.values()].filter((r) => r.tags.some((t) => t.includes(search)));
      return json(200, { page: 1, per_page: 100, total: data.length, data });
    }

    if (method === 'POST' && path === '/api/saved_objects/_import') {
      const form = init?.body as FormData;
      const ndjson = await (form.get('file') as Blob).text();
      this.imports.push({ ndjson, overwrite: url.searchParams.get('overwrite') === 'true' });
      if (this.options.importErrors) {
        return json(200, { success: false, successCount: 0, errors: this.options.importErrors });
      }
      const objects = ndjson
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { id?: string; type?: string })
        .filter((o) => 'id' in o);
      for (const o of objects) if (o.type === 'dashboard') this.dashboards.add(o.id!);
      return json(200, { success: true, successCount: objects.length });
    }

    const d = /^\/api\/saved_objects\/dashboard\/([^/]+)$/.exec(path);
    if (method === 'GET' && d) {
      const id = decodeURIComponent(d[1]!);
      return this.dashboards.has(id)
        ? json(200, { id, type: 'dashboard' })
        : json(404, { message: `Saved object [dashboard/${id}] not found` });
    }

    const m = /^\/api\/alerting\/rule\/([^/]+)(?:\/(_enable|_disable))?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const sub = m[2];
      const existing = this.rules.get(id);
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      if (method === 'GET' && !sub) {
        return existing
          ? json(200, existing)
          : json(404, { message: `Saved object [alert/${id}] not found` });
      }
      if (method === 'POST' && !sub) {
        if (existing) return json(409, { message: `Saved object [alert/${id}] conflict` });
        this.rules.set(id, {
          id,
          name: body.name as string,
          tags: body.tags as string[],
          enabled: body.enabled as boolean,
          schedule: body.schedule as { interval: string },
          params: body.params as Record<string, unknown>,
          actions: (body.actions as KibanaRule['actions']) ?? [],
        });
        return json(200, this.rules.get(id));
      }
      if (method === 'PUT' && !sub) {
        if (!existing) return json(404, { message: `Saved object [alert/${id}] not found` });
        const extra = Object.keys(body).filter((k) => !UPDATE_KEYS.includes(k));
        if (extra.length > 0) return json(400, { message: `invalid keys: ${extra.join(', ')}` });
        // Schema cập nhật của Kibana từ chối `connector_type_id` trong action.
        const bad = ((body.actions as Array<Record<string, unknown>> | undefined) ?? []).find(
          (a) => 'connector_type_id' in a,
        );
        if (bad) return json(400, { message: 'invalid action key: connector_type_id' });
        this.rules.set(id, {
          ...existing,
          actions: (body.actions as KibanaRule['actions']) ?? [],
          name: body.name as string,
          tags: body.tags as string[],
          schedule: body.schedule as { interval: string },
          params: body.params as Record<string, unknown>,
        });
        return json(200, this.rules.get(id));
      }
      if (method === 'POST' && sub) {
        if (!existing) return json(404, { message: `Saved object [alert/${id}] not found` });
        existing.enabled = sub === '_enable';
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { message: `unhandled ${method} ${path}` });
  };
}
