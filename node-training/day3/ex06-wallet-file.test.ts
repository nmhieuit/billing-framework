import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadWallet, saveWallet } from './ex06-wallet-file.js';

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'wallet-')), name);
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
  await writeFile(path, '{ khong phai json');
  await expect(loadWallet(path)).rejects.toThrow();
});
