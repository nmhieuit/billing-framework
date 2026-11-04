// Bài 1 (Cơ bản): gọi payment bằng fetch.
// callPayment(url, amount): POST `${url}/charges` với body JSON { amount }.
//   Status 202 -> trả về chargeId lấy từ JSON phản hồi.
//   Status khác -> throw new Error(`payment responded ${status}`)

export async function callPayment(url: string, amount: number): Promise<string> {
  // fetch gửi một HTTP request và trả về Promise, nên cần await
  const response = await fetch(`${url}/charges`, {
    method: 'POST', // gửi dữ liệu lên server
    headers: { 'content-type': 'application/json' }, // báo cho server biết body là JSON
    body: JSON.stringify({ amount }), // đổi đối tượng thành chuỗi JSON để gửi đi
  });

  // response.status là mã trạng thái HTTP (202 = đã nhận yêu cầu)
  if (response.status !== 202) {
    throw new Error(`payment responded ${response.status}`);
  }

  // Đọc body phản hồi và đổi từ JSON thành đối tượng (cũng là thao tác bất đồng bộ)
  const data = (await response.json()) as { chargeId: string };
  return data.chargeId;
}
