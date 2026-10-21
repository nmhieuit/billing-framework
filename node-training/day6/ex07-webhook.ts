// Bài 7 (Nâng cao): nhận kết quả (webhook) từ payment, có thể bị gửi TRÙNG hoặc ĐẾN MUỘN.
// createWalletState() trả về đối tượng có:
//   addTopup(id, amount)           tạo topup với status 'PENDING'
//   handleWebhook(event)           event = { eventId, topupId, result: 'succeeded' | 'failed' }
//   statusOf(topupId)              'PENDING' | 'SUCCEEDED' | 'FAILED'
//   balance()                      tổng tiền của các topup SUCCEEDED
// Quy tắc:
//   - eventId đã xử lý rồi -> bỏ qua hoàn toàn, trả 'duplicate'
//   - topupId không tồn tại -> throw new Error('unknown topup: <id>')
//   - succeeded -> topup SUCCEEDED (cộng vào balance MỘT lần), trả 'applied'
//   - failed    -> topup FAILED, trả 'applied'
//   - Webhook 'succeeded' đến MUỘN khi topup đã FAILED vẫn được chấp nhận (payment mới là nguồn sự thật): FAILED -> SUCCEEDED
//   - Topup đã SUCCEEDED thì webhook 'failed' khác eventId bị bỏ qua, trả 'ignored', trạng thái không đổi
export interface WebhookEvent {
  eventId: string;
  topupId: string;
  result: 'succeeded' | 'failed';
}

export function createWalletState() {
  // TODO
  return {
    addTopup(id: string, amount: number): void {
      void id;
      void amount;
    },
    handleWebhook(event: WebhookEvent): 'applied' | 'duplicate' | 'ignored' {
      void event;
      throw new Error('TODO');
    },
    statusOf(topupId: string): 'PENDING' | 'SUCCEEDED' | 'FAILED' {
      void topupId;
      throw new Error('TODO');
    },
    balance(): number {
      return NaN;
    },
  };
}
