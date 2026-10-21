// Bài 1 (Cơ bản): gọi payment bằng fetch.
// callPayment(url, amount): POST `${url}/charges` với body JSON { amount }.
//   Status 202 -> trả về chargeId lấy từ JSON phản hồi.
//   Status khác -> throw new Error(`payment responded ${status}`)
// Xem ví dụ a-goi-payment.ts. Nhớ header content-type: application/json và JSON.stringify.
export async function callPayment(url: string, amount: number): Promise<string> {
  // TODO
  void url;
  void amount;
  return '';
}
