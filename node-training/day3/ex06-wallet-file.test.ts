import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadWallet, saveWallet } from './ex06-wallet-file.js';

// Tạo một thư mục tạm mới và trả về đường dẫn file có tên "name" nằm trong đó
async function tempPath(name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'wallet-'));
  return join(folder, name);
}

test('ghi rồi đọc lại', async () => {
  const path = await tempPath('w.json');
  await saveWallet(path, { owner: 'An', balance: 150 });
  expect(await loadWallet(path)).toEqual({ owner: 'An', balance: 150 });
});

test('file không tồn tại -> null', async () => {
  expect(await loadWallet(await tempPath('khong-co.json'))).toBeNull();
});

test('file hỏng (JSON sai) -> vẫn ném lỗi, không giấu', async () => {
  const path = await tempPath('hong.json');
  // Ghi nội dung không phải JSON hợp lệ
  await writeFile(path, '{ khong phai json');
  // rejects.toThrow: Promise phải bị reject (báo lỗi)
  await expect(loadWallet(path)).rejects.toThrow();
});
