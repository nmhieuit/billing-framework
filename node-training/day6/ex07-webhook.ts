// Bài 7 (Nâng cao): nhận kết quả (webhook) từ payment, có thể bị gửi TRÙNG hoặc ĐẾN MUỘN.
//
// createWalletState() trả về một đối tượng có 4 hàm:
//   addTopup(id, amount)    tạo topup mới với status 'PENDING'
//   handleWebhook(event)    xử lý webhook, event = { eventId, topupId, result: 'succeeded' | 'failed' }
//   statusOf(topupId)       xem trạng thái: 'PENDING' | 'SUCCEEDED' | 'FAILED'
//   balance()               tổng tiền của các topup đang SUCCEEDED
//
// Quy tắc:
//   - eventId đã xử lý rồi        -> bỏ qua hoàn toàn, trả 'duplicate'
//   - topupId không tồn tại       -> throw new Error('unknown topup: <id>')
//   - succeeded                   -> topup thành SUCCEEDED (cộng vào balance MỘT lần), trả 'applied'
//   - failed                      -> topup thành FAILED, trả 'applied'
//   - succeeded đến MUỘN khi topup đã FAILED vẫn được chấp nhận (payment mới là nguồn sự thật): FAILED -> SUCCEEDED
//   - topup đã SUCCEEDED rồi thì webhook khác eventId bị bỏ qua, trả 'ignored', trạng thái không đổi

// Dữ liệu webhook mà payment gửi tới
export interface WebhookEvent {
  eventId: string; // id của webhook, dùng để phát hiện webhook gửi trùng
  topupId: string; // webhook này nói về topup nào
  result: 'succeeded' | 'failed'; // kết quả thanh toán
}

// 3 trạng thái có thể có của một topup
type Status = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export function createWalletState() {
  // Lưu các topup: key là topupId, value là { số tiền, trạng thái }
  const topups = new Map<string, { amount: number; status: Status }>();

  // Lưu các eventId đã xử lý, để lần sau gặp lại thì biết là trùng
  const seenEvents = new Set<string>();

  return {
    // Tạo topup mới, luôn bắt đầu ở trạng thái PENDING (đang chờ kết quả)
    addTopup(id: string, amount: number): void {
      topups.set(id, { amount, status: 'PENDING' });
    },

    // Xử lý một webhook từ payment
    handleWebhook(event: WebhookEvent): 'applied' | 'duplicate' | 'ignored' {
      // Bước 1: eventId này đã xử lý rồi -> không làm gì nữa, báo 'duplicate'
      if (seenEvents.has(event.eventId)) {
        return 'duplicate';
      }

      // Bước 2: tìm topup mà webhook nhắc tới; không có thì báo lỗi
      const topup = topups.get(event.topupId);
      if (!topup) {
        throw new Error(`unknown topup: ${event.topupId}`);
      }

      // Bước 3: ghi nhớ eventId này đã xử lý
      // (đặt SAU bước kiểm tra topup, để event lỗi không bị đánh dấu là đã xử lý)
      seenEvents.add(event.eventId);

      // Bước 4: topup đã SUCCEEDED thì không đổi nữa (tiền đã cộng rồi), báo 'ignored'
      // Nhờ vậy 'succeeded' gửi lần hai (khác eventId) không cộng tiền hai lần,
      // và 'failed' đến sau cũng không làm mất tiền đã cộng.
      if (topup.status === 'SUCCEEDED') {
        return 'ignored';
      }

      // Bước 5: còn lại là PENDING hoặc FAILED -> cập nhật theo kết quả mới
      // (FAILED -> SUCCEEDED khi 'succeeded' đến muộn cũng đi qua đây)
      topup.status = event.result === 'succeeded' ? 'SUCCEEDED' : 'FAILED';
      return 'applied';
    },

    // Xem trạng thái hiện tại của một topup
    statusOf(topupId: string): Status {
      const topup = topups.get(topupId);
      if (!topup) {
        throw new Error(`unknown topup: ${topupId}`);
      }
      return topup.status;
    },

    // Tính số dư = cộng tiền của tất cả topup đã SUCCEEDED
    // (tính lại mỗi lần gọi nên không bao giờ bị cộng trùng)
    balance(): number {
      let total = 0;
      for (const topup of topups.values()) {
        if (topup.status === 'SUCCEEDED') {
          total += topup.amount;
        }
      }
      return total;
    },
  };
}
