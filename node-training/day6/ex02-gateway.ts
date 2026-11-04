// Bài 2 (Trung bình): cổng gọi payment có TIMEOUT, trả về kết quả có tên rõ ràng thay vì ném lỗi.
// createCharge(url, amount, timeoutMs) trả về MỘT trong ba dạng:
//   { outcome: 'created', chargeId }     khi payment trả 202
//   { outcome: 'rejected', status }      khi payment trả 4xx (từ chối, thử lại vô ích)
//   { outcome: 'unavailable' }           khi quá thời gian chờ, lỗi mạng, hoặc payment trả 5xx (có thể thử lại)
// Hàm này KHÔNG bao giờ ném lỗi.

// Ba kết quả có thể xảy ra (| nghĩa là "hoặc")
export type ChargeOutcome =
  | { outcome: 'created'; chargeId: string }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable' };

export async function createCharge(url: string, amount: number, timeoutMs: number): Promise<ChargeOutcome> {
  try {
    const response = await fetch(`${url}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount }),
      // AbortSignal.timeout: tự hủy request nếu quá timeoutMs mili-giây (fetch sẽ ném lỗi)
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 202: payment đã nhận yêu cầu
    if (response.status === 202) {
      const data = (await response.json()) as { chargeId: string };
      return { outcome: 'created', chargeId: data.chargeId };
    }

    // 4xx: lỗi do yêu cầu của mình, thử lại cũng vô ích
    if (response.status >= 400 && response.status < 500) {
      return { outcome: 'rejected', status: response.status };
    }

    // Còn lại (5xx...): payment đang gặp sự cố, có thể thử lại sau
    return { outcome: 'unavailable' };
  } catch {
    // Quá thời gian chờ hoặc lỗi mạng đều rơi vào đây
    return { outcome: 'unavailable' };
  }
}
