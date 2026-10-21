// Bài 6 (Trung bình): đọc/ghi file JSON.
// saveWallet(path, wallet): ghi wallet ra file dưới dạng JSON (JSON.stringify).
// loadWallet(path): đọc file và trả về đối tượng (JSON.parse).
//   Nếu file KHÔNG tồn tại (error.code === 'ENOENT') -> trả về null.
//   Mọi lỗi khác phải ném tiếp (throw error) để không giấu lỗi thật.
import { readFile, writeFile } from 'node:fs/promises';

export interface WalletData {
  owner: string;
  balance: number;
}

export async function saveWallet(path: string, wallet: WalletData): Promise<void> {
  // TODO
  void writeFile;
}

export async function loadWallet(path: string): Promise<WalletData | null> {
  // TODO
  void readFile;
  return null;
}
