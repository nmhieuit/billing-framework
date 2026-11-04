// Bài 7 (Sửa lỗi kiểu): chương trình chạy được nhưng TypeScript báo lỗi.
// Chạy:  pnpm check day2/ex07-bug-types.ts     -> phải hết lỗi
// rồi:   pnpm test day2/ex07
// (Bản này đã sửa xong.)

// Mô tả hình dạng của một khách hàng
export interface Customer {
  id: string;
  name: string;
  balance: number;
}

// Tạo khách hàng mới với số dư 0
export function makeCustomer(id: string, name: string): Customer {
  return { id, name, balance: 0 };
}

// Cộng số dư của tất cả khách hàng
export function totalBalance(customers: Customer[]): number {
  let total = 0;
  for (const customer of customers) {
    total = total + customer.balance;
  }
  return total;
}
