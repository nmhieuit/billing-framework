import { readFile, writeFile } from 'node:fs/promises';

export interface WalletData {
  owner: string;
  balance: number;
}

export async function saveWallet(path: string, wallet: WalletData): Promise<void> {
  await writeFile(path, JSON.stringify(wallet, null, 2));
}

export async function loadWallet(path: string): Promise<WalletData | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as WalletData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
