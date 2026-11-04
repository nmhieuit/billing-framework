// Bài 6 (Trung bình): đọc/ghi file JSON.
// saveWallet(path, wallet): ghi wallet ra file dưới dạng JSON (JSON.stringify).
// loadWallet(path): đọc file và trả về đối tượng (JSON.parse).
//   Nếu file KHÔNG tồn tại (error.code === 'ENOENT') -> trả về null.
//   Mọi lỗi khác phải ném tiếp (throw error) để không giấu lỗi thật.

// Thư viện có sẵn của Node để đọc/ghi file (phiên bản trả về Promise)
import { readFile, writeFile } from 'node:fs/promises';

// Dữ liệu của một ví
export interface WalletData {
  owner: string;
  balance: number;
}

// Ghi ví ra file
export async function saveWallet(path: string, wallet: WalletData): Promise<void> {
  // JSON.stringify: đổi đối tượng thành chuỗi JSON để lưu vào file
  const jsonText = JSON.stringify(wallet);
  await writeFile(path, jsonText);
}

// Đọc ví từ file; file chưa có thì trả về null
export async function loadWallet(path: string): Promise<WalletData | null> {
  try {
    // 'utf8': đọc nội dung file thành chuỗi chữ
    const jsonText = await readFile(path, 'utf8');
    // JSON.parse: đổi chuỗi JSON ngược lại thành đối tượng
    return JSON.parse(jsonText);
  } catch (error) {
    // ENOENT = "Error NO ENTry": file không tồn tại
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Lỗi khác (ví dụ JSON hỏng) thì ném tiếp, không được giấu đi
    throw error;
  }
}
