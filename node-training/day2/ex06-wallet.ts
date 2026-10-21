// Bài 6 (Nâng cao): class Wallet.
//   new Wallet('An')          -> owner = 'An', balance = 0
//   deposit(amount)           -> cộng tiền, trả về số dư mới
//   withdraw(amount)          -> trừ tiền, trả về số dư mới
//   Số tiền phải là số nguyên dương, nếu không: throw new Error('amount must be a positive integer')
//   Rút quá số dư:            throw new Error('insufficient funds') và số dư KHÔNG đổi
// Số dư lưu trong trường riêng #balance, bên ngoài chỉ đọc qua `get balance()`.
export class Wallet {
  // TODO: #balance, constructor(readonly owner: string), get balance(), deposit(), withdraw()
}
