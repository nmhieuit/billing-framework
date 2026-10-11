/** Ánh xạ tên logic → trường thật trong Elasticsearch (mapping `otel` của collector). Sửa MỘT chỗ này nếu khác. */
export const FIELDS = {
  timestamp: '@timestamp',
  service: 'resource.attributes.service.name',
  /** Id tiến trình (mỗi process một giá trị), dùng để tính delta counter riêng cho từng process. */
  serviceInstance: 'resource.attributes.service.instance.id',
  /** Giá trị metric: `metrics.<tên metric>`. */
  metric: (name: string): string => `metrics.${name}`,
  /** Nhãn của điểm dữ liệu: `attributes.<nhãn>`. */
  attribute: (name: string): string => `attributes.${name}`,
  /** Chỉ mục metric. */
  metricsIndex: 'metrics-generic.otel-default*',
} as const;
