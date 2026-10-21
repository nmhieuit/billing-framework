import { CURRENCY, formatMoney } from './b-money.js';

const tx = { type: 'deposit', amount: 100, note: 'nạp tiền' };
const { type, amount } = tx;

console.log(formatMoney(amount), type, CURRENCY);
