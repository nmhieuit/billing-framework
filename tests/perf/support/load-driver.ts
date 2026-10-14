export type ErrorKind = 'deadlock' | 'timeout' | 'other';

export interface DriverOptions {
  concurrency: number;
  /** Độ dài cửa sổ ĐO (không tính khởi động nóng). */
  durationMs: number;
  warmupMs: number;
  /** Ném lỗi = thao tác thất bại. */
  task: (context: { worker: number; seq: number }) => Promise<void>;
  /** Mặc định: {@link defaultClassify}. Ném lỗi hoặc trả giá trị lạ → coi là other (không làm hỏng lượt đo). */
  classify?: (error: unknown) => ErrorKind;
  /**
   * Thời gian tối đa (ms, đồng hồ thật) chờ các thao tác còn đang bay sau khi hết cửa sổ đo. Quá hạn thì từ chối
   * với thông báo nêu số thao tác bị kẹt (tránh treo vô hạn). Mặc định 30000.
   */
  drainTimeoutMs?: number;
  /** Đồng hồ (ms), tiêm được cho test. Mặc định performance.now(). */
  now?: () => number;
}

export interface DriverResult {
  ok: number;
  errors: { deadlock: number; timeout: number; other: number };
  /** Độ dài cửa sổ đo (= durationMs). */
  elapsedMs: number;
  throughputPerSec: number;
  /** Độ trễ (ms) của các thao tác THÀNH CÔNG hoàn tất trong cửa sổ đo. */
  latenciesMs: number[];
}

// SQL Server: 1205 = nạn nhân deadlock; 1222 = lock request time out.
const DEADLOCK_NUMBER = 1205;
const LOCK_TIMEOUT_NUMBER = 1222;

// Lỗi tedious/Kysely là chính đối tượng RequestError (có `number`, `code`), nhưng có thể bị bọc lại
// (cause, originalError kiểu mssql, precedingErrors/errors kiểu AggregateError) nên duyệt có giới hạn độ sâu.
function* errorChain(error: unknown): Generator<Record<string, unknown>> {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let visited = 0; queue.length > 0 && visited < 16; visited += 1) {
    const e = queue.shift();
    if (typeof e !== 'object' || e === null || seen.has(e)) continue;
    seen.add(e);
    const rec = e as Record<string, unknown>;
    yield rec;
    for (const key of ['cause', 'originalError']) queue.push(rec[key]);
    for (const key of ['precedingErrors', 'errors']) {
      const list = rec[key];
      if (Array.isArray(list)) queue.push(...list);
    }
  }
}

/** Mã SQL 1205 (ở bất kỳ tầng bọc nào) → deadlock; ETIMEOUT/1222/thông báo timeout → timeout; còn lại other. */
export function defaultClassify(error: unknown): ErrorKind {
  let timeout = false;
  for (const e of errorChain(error)) {
    if (e.number === DEADLOCK_NUMBER) return 'deadlock';
    if (e.number === LOCK_TIMEOUT_NUMBER || e.code === 'ETIMEOUT') timeout = true;
    if (typeof e.message === 'string' && /time(?:d)?[\s-]?out/i.test(e.message)) timeout = true;
  }
  return timeout ? 'timeout' : 'other';
}

// Nhường event loop một macrotask: lỗi tức thì liên tục (chỉ microtask) sẽ không làm đói timer/I/O.
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Vòng tải kín: `concurrency` worker chạy `task` liên tục, không bao giờ quá `concurrency` thao tác cùng lúc.
 * Cửa sổ đo = [t0 + warmupMs, t0 + warmupMs + durationMs). Chỉ thao tác HOÀN TẤT trong cửa sổ mới được tính
 * (thành công, hoặc lỗi đếm theo classify). Thao tác đang bay khi hết cửa sổ vẫn được chờ xong rồi bỏ.
 * Lỗi của task không dừng worker.
 */
export async function runClosedLoop(options: DriverOptions): Promise<DriverResult> {
  const { concurrency, durationMs, warmupMs, task } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency phải là số nguyên >= 1, nhận ${concurrency}`);
  }
  if (!(durationMs > 0)) throw new RangeError(`durationMs phải > 0, nhận ${durationMs}`);
  if (!(warmupMs >= 0)) throw new RangeError(`warmupMs phải >= 0, nhận ${warmupMs}`);
  const rawClassify = options.classify ?? defaultClassify;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  if (!(drainTimeoutMs > 0))
    throw new RangeError(`drainTimeoutMs phải > 0, nhận ${drainTimeoutMs}`);
  // classify của người dùng có thể ném lỗi/trả giá trị lạ: không để nó làm Promise.all từ chối khi các worker khác vẫn chạy.
  const classify = (error: unknown): ErrorKind => {
    try {
      const kind = rawClassify(error);
      return kind === 'deadlock' || kind === 'timeout' || kind === 'other' ? kind : 'other';
    } catch {
      return 'other';
    }
  };
  let inFlight = 0;
  const now = options.now ?? ((): number => performance.now());

  const start = now();
  const measureStart = start + warmupMs;
  const measureEnd = measureStart + durationMs;
  const result: DriverResult = {
    ok: 0,
    errors: { deadlock: 0, timeout: 0, other: 0 },
    elapsedMs: durationMs,
    throughputPerSec: 0,
    latenciesMs: [],
  };

  const runWorker = async (worker: number): Promise<void> => {
    for (let seq = 0; now() < measureEnd; seq += 1) {
      const began = now();
      let failure: { error: unknown } | undefined;
      inFlight += 1;
      try {
        await task({ worker, seq });
      } catch (error) {
        failure = { error };
      } finally {
        inFlight -= 1;
      }
      const finished = now();
      if (finished >= measureStart && finished < measureEnd) {
        if (failure === undefined) {
          result.ok += 1;
          result.latenciesMs.push(finished - began);
        } else {
          result.errors[classify(failure.error)] += 1;
        }
      }
      await yieldToEventLoop();
    }
  };

  // Đồng hồ thật: quá hạn cửa sổ + drainTimeoutMs mà vẫn còn thao tác bay thì báo lỗi rõ ràng thay vì treo.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    watchdog = setTimeout(
      () =>
        reject(
          new Error(
            `${inFlight} thao tác vẫn chưa kết thúc sau ${drainTimeoutMs} ms kể từ hết cửa sổ đo (kẹt?)`,
          ),
        ),
      warmupMs + durationMs + drainTimeoutMs,
    );
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: concurrency }, (_, worker) => runWorker(worker))),
      stuck,
    ]);
  } finally {
    clearTimeout(watchdog);
  }
  result.throughputPerSec = result.ok / (result.elapsedMs / 1000);
  return result;
}
