/** Chạy lần lượt mọi bước kể cả khi bước trước lỗi; cuối cùng ném lại lỗi ĐẦU TIÊN (nếu có). */
export async function runAll(steps: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/** Chỉ chạy `fn` một lần; mọi lần gọi sau trả lại cùng promise (đang chạy hoặc đã xong). */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= fn());
}

export interface ShutdownLogger {
  info(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface ShutdownOptions {
  stop: () => Promise<void>;
  log: ShutdownLogger;
  exit: (code: number) => void;
}

/** Tín hiệu đầu tiên dừng dịch vụ rồi thoát; tín hiệu sau khi đã bắt đầu dừng bị bỏ qua. */
export function createShutdownHandler(options: ShutdownOptions): (signal: string) => void {
  let shuttingDown = false;
  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.log.info({ signal }, 'shutting down');
    options.stop().then(
      () => options.exit(0),
      (error: unknown) => {
        options.log.error({ err: error }, 'shutdown failed');
        options.exit(1);
      },
    );
  };
}

export interface StartupOptions<S extends { stop(): Promise<void> }> {
  start: () => Promise<S>;
  listen: (service: S) => Promise<void>;
  log: ShutdownLogger;
  exit: (code: number) => void;
}

/**
 * Khởi động service rồi lắng nghe. Nếu bước nào lỗi: dừng service (nếu đã tạo; bỏ qua lỗi khi dừng),
 * ghi log có cấu trúc rồi thoát với mã 1, để worker và pool DB không bị bỏ lại.
 */
export async function startOrExit<S extends { stop(): Promise<void> }>(
  options: StartupOptions<S>,
): Promise<S | undefined> {
  let service: S | undefined;
  try {
    service = await options.start();
    await options.listen(service);
    return service;
  } catch (error) {
    if (service) {
      try {
        await service.stop();
      } catch {
        // Lỗi khi dừng không được che mất lỗi khởi động gốc.
      }
    }
    options.log.error({ err: error }, 'failed to start');
    options.exit(1);
    return undefined;
  }
}
