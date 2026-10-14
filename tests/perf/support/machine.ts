import { execFileSync } from 'node:child_process';
import { arch, cpus, release, totalmem, type } from 'node:os';

export interface MachineInfo {
  label: string;
  cpus: number;
  memoryGb: number;
  node: string;
  os: string;
  sqlServerVersion: string | null;
  gitSha: string | null;
}

// SHA hiện tại; null nếu không có git hoặc không ở trong repo.
function currentGitSha(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Mô tả máy chạy đo, để so sánh kết quả giữa các máy. */
export function describeMachine(input: {
  label: string;
  sqlServerVersion?: string | null;
}): MachineInfo {
  return {
    label: input.label,
    cpus: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    os: `${type()} ${release()} ${arch()}`,
    sqlServerVersion: input.sqlServerVersion ?? null,
    gitSha: currentGitSha(),
  };
}
