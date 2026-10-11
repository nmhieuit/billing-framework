import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const doc = await readFile(resolve(ROOT, 'docs/ops/kibana-alerts-and-dashboard.vi.md'), 'utf8');
const defaults = JSON.parse(
  await readFile(resolve(ROOT, 'deploy/kibana/params.defaults.json'), 'utf8'),
) as { dashboard: Record<string, unknown>; rules: Record<string, Record<string, unknown>> };

// Tài liệu tham số phải đi cùng file mặc định: thêm rule hoặc khoá mà quên ghi tài liệu sẽ làm test này đỏ.
describe('docs/ops/kibana-alerts-and-dashboard.vi.md', () => {
  it.each(Object.keys(defaults.rules))('mentions rule %s', (rule) => {
    expect(doc).toContain(`\`${rule}\``);
  });

  const ruleKeys = [...new Set(Object.values(defaults.rules).flatMap((r) => Object.keys(r)))];
  it.each(ruleKeys)('mentions rule parameter %s', (key) => {
    expect(doc).toContain(`\`${key}\``);
  });

  it.each(Object.keys(defaults.dashboard))('mentions dashboard parameter %s', (key) => {
    expect(doc).toContain(`\`${key}\``);
  });

  it('documents each rule-specific key next to the rule that owns it', () => {
    for (const [rule, params] of Object.entries(defaults.rules)) {
      for (const key of Object.keys(params)) {
        // Mỗi cặp (rule, khoá) phải có một dòng bảng chứa cả hai, trừ khoá dùng chung (có bảng riêng).
        if (['enabled', 'severity', 'intervalMinutes', 'windowMinutes'].includes(key)) continue;
        const row = doc
          .split('\n')
          .find((line) => line.includes(`\`${rule}\``) && line.includes(`\`${key}\``));
        expect(row, `${rule} / ${key}`).toBeDefined();
      }
    }
  });
});
