import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ChildService {
  readonly name: 'wallet' | 'payment';
  readonly pid: number;
  /** Chờ /health = 200; lỗi kèm đuôi stdout/stderr đã bắt của tiến trình con (đã che mật khẩu/khóa). */
  waitReady(timeoutMs?: number): Promise<void>;
  /** SIGKILL (Windows: TerminateProcess) rồi đợi tiến trình thoát hẳn. Idempotent. */
  kill(): Promise<void>;
  /** SIGTERM rồi SIGKILL nếu quá hạn. Trên Windows SIGTERM cũng kết thúc ngay (không có tắt êm). Idempotent. */
  stop(): Promise<void>;
  /** Mã thoát; null khi bị giết bằng tín hiệu (SIGKILL). */
  readonly exited: Promise<number | null>;
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GUARD_URL = pathToFileURL(fileURLToPath(new URL('./child-guard.mjs', import.meta.url))).href;
const MAIN_FILE = {
  wallet: 'services/wallet/src/main.ts',
  payment: 'services/payment/src/main.ts',
} as const;

/** Biến hệ thống tối thiểu để node/tsx chạy được; KHÔNG kế thừa phần còn lại của env (tránh rò WALLET_DB_*, OTEL_*...). */
const BASE_ENV_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];
const TAIL_CHARS = 8_000;
const KILL_TIMEOUT_MS = 15_000;
const SECRET_KEY = /PASSWORD|SECRET|TOKEN/i;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `work` thắng thì trả kết quả của nó; hết `ms` thì trả false. Timer luôn được hủy để không treo vòng lặp sự kiện. */
export async function raceTimeout(work: Promise<true>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tiến trình con còn sống: dùng để kiểm tra "không để lại mồ côi" (signal 0 không gửi gì, chỉ dò tồn tại). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: tồn tại nhưng không đủ quyền gửi tín hiệu.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Mọi tiến trình con còn sống; giết đồng bộ khi tiến trình test thoát (kể cả khi test thất bại / bị ngắt).
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of live) {
      try {
        child.kill('SIGKILL');
      } catch {
        // đã chết
      }
    }
  });
}

/**
 * Chạy wallet/payment thành tiến trình con thật: `node --import child-guard --import tsx main.ts`, nên pid chính là
 * tiến trình dịch vụ (không qua pnpm/cmd). env của con chỉ gồm biến hệ thống tối thiểu + `input.env` + PORT.
 */
export async function spawnChildService(input: {
  name: 'wallet' | 'payment';
  env: Record<string, string>;
  port: number;
}): Promise<ChildService> {
  installExitHook();
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, input.env, { PORT: String(input.port) });

  const secrets = Object.entries(env)
    .filter(([key, value]) => SECRET_KEY.test(key) && value.length >= 4)
    .map(([, value]) => value);
  const redact = (text: string): string =>
    secrets.reduce((acc, s) => acc.split(s).join('***'), text);

  const child = spawn(
    process.execPath,
    ['--import', GUARD_URL, '--import', 'tsx', MAIN_FILE[input.name]],
    { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  live.add(child);

  let tail = '';
  const capture = (chunk: Buffer): void => {
    tail = (tail + chunk.toString('utf8')).slice(-TAIL_CHARS);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  // Pipe stdin do cha giữ mở để child-guard phát hiện cha chết; lỗi ghi/đóng không được làm test sập.
  child.stdin?.on('error', () => undefined);

  let spawnError: Error | undefined;
  let hasExited = false;
  let exitInfo = '';
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      if (child.pid === undefined) {
        hasExited = true;
        live.delete(child);
        resolve(null);
      }
    });
    child.once('exit', (code, signal) => {
      hasExited = true;
      exitInfo = signal === null ? `mã thoát ${code}` : `bị tín hiệu ${signal}`;
      live.delete(child);
      resolve(code);
    });
  });

  // 'close' đến sau khi stdout/stderr đã đọc hết: đảm bảo đuôi log đầy đủ trước khi dựng thông báo lỗi.
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid as number;

  const describeFailure = (reason: string): Error =>
    new Error(
      `${input.name} (pid ${pid}) ${reason}\n--- đuôi stdout/stderr của tiến trình con ---\n${redact(tail).trim()}`,
    );

  const kill = async (): Promise<void> => {
    if (!hasExited) child.kill('SIGKILL');
    // Chặn trên: SIGKILL mà không thoát được là bất thường, báo rõ thay vì treo cả test.
    const done = await raceTimeout(
      exited.then(() => true),
      KILL_TIMEOUT_MS,
    );
    if (!done) throw describeFailure(`không thoát sau ${KILL_TIMEOUT_MS}ms kể từ SIGKILL`);
  };

  return {
    name: input.name,
    pid,
    exited,
    kill,
    async stop() {
      if (hasExited) return;
      child.kill('SIGTERM');
      const gracefully = await raceTimeout(
        exited.then(() => true),
        10_000,
      );
      if (!gracefully) await kill();
    },
    async waitReady(timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (hasExited) {
          await closed;
          throw describeFailure(`đã thoát trước khi sẵn sàng (${exitInfo})`);
        }
        if (spawnError !== undefined)
          throw describeFailure(`lỗi tiến trình: ${spawnError.message}`);
        try {
          const response = await fetch(`http://127.0.0.1:${input.port}/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          await response.arrayBuffer();
          if (response.status === 200) return;
        } catch {
          // chưa lắng nghe cổng: thử lại
        }
        await sleep(100);
      }
      throw describeFailure(`không sẵn sàng sau ${timeoutMs}ms (/health)`);
    },
  };
}
