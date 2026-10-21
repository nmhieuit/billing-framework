// Bài 7 (Sửa lỗi kiểu): chương trình chạy được nhưng TypeScript báo lỗi.
// Chạy:  pnpm check day2/ex07-bug-types.ts     -> phải hết lỗi
// rồi:   pnpm test day2/ex07
// Đọc kỹ từng dòng lỗi (số dòng nằm trong ngoặc), sửa 2 chỗ.
export interface Customer {
  id: string;
  name: string;
  balance: number;
}

export function makeCustomer(id: string, name: string): Customer {
  return { id, name };
}

export function totalBalance(customers: Customer[]): number {
  let total = 0;
  for (const c of customers) {
    total = total + c.balanse;
  }
  return total;
}
