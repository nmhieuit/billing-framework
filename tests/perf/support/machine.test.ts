import { describe, expect, it } from 'vitest';
import { describeMachine } from './machine.js';

describe('describeMachine', () => {
  it('trả thông tin máy hợp lệ', () => {
    const m = describeMachine({ label: 'laptop-a' });
    expect(m.label).toBe('laptop-a');
    expect(m.cpus).toBeGreaterThan(0);
    expect(m.memoryGb).toBeGreaterThan(0);
    expect(m.node).toBe(process.version);
    expect(m.os.length).toBeGreaterThan(0);
  });

  it('sqlServerVersion mặc định null, truyền vào thì giữ nguyên', () => {
    expect(describeMachine({ label: 'x' }).sqlServerVersion).toBeNull();
    expect(describeMachine({ label: 'x', sqlServerVersion: '2022' }).sqlServerVersion).toBe('2022');
  });

  it('gitSha là null hoặc chuỗi hex 40 ký tự', () => {
    const { gitSha } = describeMachine({ label: 'x' });
    if (gitSha !== null) expect(gitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
