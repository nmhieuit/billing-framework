/** Ánh xạ tên logic → trường thật trong Elasticsearch (mapping `otel` của collector). Sửa MỘT chỗ này nếu khác. */
export const FIELDS = {
  timestamp: '@timestamp',
  service: 'resource.attributes.service.name',
  /** Giá trị metric: `metrics.<tên metric>`. */
  metric: (name: string): string => `metrics.${name}`,
  /** Nhãn của điểm dữ liệu: `attributes.<nhãn>`. */
  attribute: (name: string): string => `attributes.${name}`,
  /** Chỉ mục metric. */
  metricsIndex: 'metrics-generic.otel-default*',
} as const;
