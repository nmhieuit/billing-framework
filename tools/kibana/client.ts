import type { AlertingBody } from './rules.js';

export class KibanaError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'KibanaError';
    this.status = status;
  }
}

/** Phần của rule mà `apply` cần đọc lại từ Kibana. */
export interface KibanaRule {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
  schedule: { interval: string };
  params: Record<string, unknown>;
  /** Trạng thái lần chạy gần nhất (có sau khi rule đã chạy ít nhất một lần). */
  execution_status?: { status: string; error?: { message?: string } };
  /** Action (connector) đang gắn vào rule: người vận hành có thể gắn tay, `apply` phải giữ nguyên. */
  actions?: ExistingRuleAction[];
  last_run?: { alerts_count?: { active?: number; new?: number; recovered?: number } };
}

/** Action như Kibana trả về khi đọc rule (có thêm `connector_type_id`). */
export interface ExistingRuleAction extends UpdateRuleAction {
  connector_type_id?: string;
}

/** Action ở dạng schema cập nhật chấp nhận (không có `connector_type_id`). */
export interface UpdateRuleAction {
  group: string;
  id: string;
  params: Record<string, unknown>;
  frequency?: unknown;
  uuid?: string;
  alerts_filter?: unknown;
}

/** Đổi action đọc được sang dạng body PUT: bỏ `connector_type_id`, giữ phần còn lại. */
export function toUpdateActions(actions: ExistingRuleAction[] | undefined): UpdateRuleAction[] {
  return (actions ?? []).map((a) => ({
    group: a.group,
    id: a.id,
    params: a.params,
    ...(a.frequency === undefined ? {} : { frequency: a.frequency }),
    ...(a.uuid === undefined ? {} : { uuid: a.uuid }),
    ...(a.alerts_filter === undefined ? {} : { alerts_filter: a.alerts_filter }),
  }));
}

/** Body của `PUT /api/alerting/rule/{id}`: Kibana không nhận rule_type_id, consumer, enabled. */
export type UpdateBody = Pick<AlertingBody, 'name' | 'tags' | 'schedule' | 'params'> & {
  actions: UpdateRuleAction[];
};

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface KibanaClientOptions {
  baseUrl: string;
  fetchImpl?: FetchImpl;
  /** Hàm chờ (tiêm vào để test chạy nhanh). */
  sleep?: (ms: number) => Promise<void>;
  /** Đồng hồ (tiêm vào để test timeout). */
  now?: () => number;
}

interface RequestInput {
  json?: unknown;
  form?: FormData;
}

export class KibanaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: KibanaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  private async request(method: string, path: string, input: RequestInput = {}): Promise<Response> {
    const headers: Record<string, string> = { 'kbn-xsrf': 'true' };
    const req: RequestInit = { method, headers };
    if (input.json !== undefined) {
      headers['content-type'] = 'application/json';
      req.body = JSON.stringify(input.json);
    }
    if (input.form) req.body = input.form;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, req);
    } catch (e) {
      throw new KibanaError(`${method} ${path} failed: ${(e as Error).message}`);
    }
  }

  private async ok(method: string, path: string, input?: RequestInput): Promise<Response> {
    const res = await this.request(method, path, input);
    if (!res.ok) throw await toError(method, path, res);
    return res;
  }

  /** Đọc `version.number` từ `/api/status`. */
  async getVersion(): Promise<string> {
    const res = await this.ok('GET', '/api/status');
    const body = (await res.json()) as { version?: { number?: unknown } };
    const v = body.version?.number;
    if (typeof v !== 'string') throw new KibanaError('GET /api/status returned no version.number');
    return v;
  }

  async waitUntilAvailable(timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    let last = 'no response';
    for (;;) {
      try {
        const res = await this.request('GET', '/api/status');
        if (res.ok) {
          const body = (await res.json()) as { status?: { overall?: { level?: string } } };
          const level = body.status?.overall?.level;
          if (level === 'available') return;
          last = `status ${level ?? 'unknown'}`;
        } else {
          last = `HTTP ${res.status}`;
        }
      } catch (e) {
        last = (e as Error).message;
      }
      if (this.now() >= deadline) {
        throw new KibanaError(
          `Kibana at ${this.baseUrl} not available after ${timeoutMs} ms (${last})`,
        );
      }
      await this.sleep(2000);
    }
  }

  async getRule(id: string): Promise<KibanaRule | null> {
    const path = `/api/alerting/rule/${encodeURIComponent(id)}`;
    const res = await this.request('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw await toError('GET', path, res);
    return (await res.json()) as KibanaRule;
  }

  /** `true` nếu saved object dashboard tồn tại. */
  async dashboardExists(id: string): Promise<boolean> {
    const path = `/api/saved_objects/dashboard/${encodeURIComponent(id)}`;
    const res = await this.request('GET', path);
    if (res.status === 404) return false;
    if (!res.ok) throw await toError('GET', path, res);
    return true;
  }

  async createRule(id: string, body: AlertingBody): Promise<void> {
    await this.ok('POST', `/api/alerting/rule/${encodeURIComponent(id)}`, { json: body });
  }

  async updateRule(id: string, body: UpdateBody): Promise<void> {
    // Chỉ gửi đúng 5 trường Kibana cho phép khi cập nhật.
    const { name, tags, schedule, params, actions } = body;
    await this.ok('PUT', `/api/alerting/rule/${encodeURIComponent(id)}`, {
      json: { name, tags, schedule, params, actions },
    });
  }

  async setRuleEnabled(id: string, enabled: boolean): Promise<void> {
    const action = enabled ? '_enable' : '_disable';
    await this.ok('POST', `/api/alerting/rule/${encodeURIComponent(id)}/${action}`);
  }

  async findRulesByTag(tag: string): Promise<Array<{ id: string; name: string }>> {
    const qs = new URLSearchParams({ search: tag, search_fields: 'tags', per_page: '100' });
    const res = await this.ok('GET', `/api/alerting/rules/_find?${qs.toString()}`);
    const body = (await res.json()) as {
      data?: Array<{ id: string; name: string; tags?: string[] }>;
    };
    // Lọc chính xác theo tag phía client vì `search` là tìm gần đúng.
    return (body.data ?? [])
      .filter((r) => r.tags?.includes(tag))
      .map((r) => ({ id: r.id, name: r.name }));
  }

  /** Trả số object đã import. */
  async importSavedObjects(ndjson: string, overwrite: boolean): Promise<number> {
    const form = new FormData();
    form.append('file', new Blob([ndjson], { type: 'application/ndjson' }), 'objects.ndjson');
    const path = `/api/saved_objects/_import${overwrite ? '?overwrite=true' : ''}`;
    const res = await this.ok('POST', path, { form });
    const body = (await res.json()) as {
      success?: boolean;
      successCount?: number;
      errors?: unknown[];
    };
    if (body.success !== true) {
      throw new KibanaError(
        `Saved objects import failed: ${JSON.stringify(body.errors ?? body)}`,
        res.status,
      );
    }
    return body.successCount ?? 0;
  }
}

async function toError(method: string, path: string, res: Response): Promise<KibanaError> {
  const text = (await res.text().catch(() => '')).trim();
  return new KibanaError(
    `${method} ${path} -> HTTP ${res.status}${text ? `: ${text}` : ''}`,
    res.status,
  );
}
