/** Trạng thái vận hành của payment, được lấy mẫu định kỳ để đẩy lên gauge. */
export interface PaymentState {
  /** Số sự kiện webhook còn PENDING (chờ gửi hoặc chờ thử lại). */
  webhookPending: number;
  /** Tuổi (giây, làm tròn xuống) của sự kiện PENDING cũ nhất; 0 nếu không có. */
  webhookOldestAgeSeconds: number;
}
