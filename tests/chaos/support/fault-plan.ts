import type { OpLog } from './op-log.js';
import type { Prng } from './prng.js';

export type FaultInfo = Record<string, unknown>;

export interface FaultRule {
  point: string;
  when?: (info: FaultInfo) => boolean;
  nth?: number;
  probability?: number;
  times?: number;
  label?: string;
  action: (info: FaultInfo) => void | Promise<void>;
}

interface RuleState {
  rule: FaultRule;
  matches: number;
  fired: number;
}

// Kế hoạch tiêm lỗi: mã sản phẩm gọi hit(point) tại các seam, rule khớp sẽ chạy action.
export class FaultPlan {
  private readonly log: OpLog;
  private readonly prng: Prng | undefined;
  private rules: RuleState[] = [];
  private hitCounts = new Map<string, number>();
  private enabled = true;

  constructor(options: { log: OpLog; prng?: Prng }) {
    this.log = options.log;
    this.prng = options.prng;
  }

  add(rule: FaultRule): this {
    if (rule.probability !== undefined && this.prng === undefined) {
      throw new Error(
        `Rule "${rule.label ?? rule.point}" dùng probability nhưng FaultPlan không có prng`,
      );
    }
    this.rules.push({ rule, matches: 0, fired: 0 });
    return this;
  }

  async hit(point: string, info: FaultInfo = {}): Promise<void> {
    if (!this.enabled) return;
    this.hitCounts.set(point, (this.hitCounts.get(point) ?? 0) + 1);
    // Chụp danh sách rule để clear() trong lúc action chạy không làm lệch vòng lặp.
    for (const state of [...this.rules]) {
      const { rule } = state;
      if (rule.point !== point) continue;
      if (rule.when !== undefined && !rule.when(info)) continue;
      state.matches += 1;
      if (rule.nth !== undefined && state.matches !== rule.nth) continue;
      if (rule.times !== undefined && state.fired >= rule.times) continue;
      if (rule.probability !== undefined && !(this.prng as Prng).chance(rule.probability)) continue;
      state.fired += 1;
      this.log.record('fault', { point, label: rule.label, match: state.matches });
      await rule.action(info);
    }
  }

  hits(point: string): number {
    return this.hitCounts.get(point) ?? 0;
  }

  fired(label?: string): number {
    return this.rules
      .filter((s) => label === undefined || s.rule.label === label)
      .reduce((sum, s) => sum + s.fired, 0);
  }

  disable(): void {
    this.enabled = false;
  }

  enable(): void {
    this.enabled = true;
  }

  // Xoá mọi rule và bộ đếm; trạng thái bật/tắt giữ nguyên.
  clear(): void {
    this.rules = [];
    this.hitCounts = new Map();
  }
}
