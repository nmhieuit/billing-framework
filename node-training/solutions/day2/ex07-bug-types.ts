export interface Customer {
  id: string;
  name: string;
  balance: number;
}

export function makeCustomer(id: string, name: string): Customer {
  return { id, name, balance: 0 };
}

export function totalBalance(customers: Customer[]): number {
  let total = 0;
  for (const c of customers) {
    total = total + c.balance;
  }
  return total;
}
