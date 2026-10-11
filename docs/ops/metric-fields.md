# Trường metric trong Elasticsearch (stack local)

Đã quan sát trên Elasticsearch/Kibana 9.4.4 với OTel Collector `otel-collector-contrib:0.160.0`
(exporter `elasticsearch`, `mapping.mode: otel`). Wallet và payment gửi OTLP gRPC tới collector;
collector ghi vào data stream `metrics-generic.otel-default`.

| Tên logic (`FIELDS`)  | Trường thật                               | Ghi chú                                          |
| --------------------- | ----------------------------------------- | ------------------------------------------------ |
| `timestamp`           | `@timestamp`                              | kiểu date                                        |
| `service`             | `resource.attributes.service.name`        | keyword; giá trị `wallet` / `payment`            |
| `metric(name)`        | `metrics.<tên metric>`                    | double; ví dụ `metrics.billing.outbox.pending`   |
| `attribute(name)`     | `attributes.<nhãn>`                       | keyword; ví dụ `attributes.tenant`               |
| `metricsIndex`        | `metrics-generic.otel-default*`           | data stream, mapping time series                 |

Gauge (`time_series_metric: gauge`): `billing.outbox.pending`, `billing.outbox.oldest_age_seconds`,
`billing.topups.requested_backlog`, `billing.topups.oldest_requested_age_seconds`, `billing.dlq.depth`,
`billing.payment.webhook_backlog`, `billing.payment.webhook_oldest_age_seconds`,
`billing.reconciliation.oldest_open_item_age_seconds`, `billing.reconciliation.last_success_age_seconds`.
Counter (`time_series_metric: counter`): `billing.order_payments`, `billing.consumer.messages`,
`billing.reconciliation.runs` (đã thấy); `billing.topups`, `billing.payment.charges`,
`billing.payment.webhook_deliveries` chỉ xuất hiện khi có sự kiện, và `billing.reconciliation.open_items`
(nhãn `attributes.kind`) chỉ xuất hiện khi có ca mở: kiểm chứng ở Task 11 sau khi seed.

Nhãn đã quan sát: `attributes.tenant` (gauge outbox/topups/reconciliation, `order_payments`, `reconciliation.runs`),
`attributes.queue` (`billing.dlq.depth`, giá trị `wallet.order-payments.dlq`),
`attributes.status` (`reconciliation.runs`: COMPLETED/FAILED), `attributes.outcome` (`order_payments`),
`attributes.result` (`consumer.messages`). Metric của payment không có nhãn.

Chú ý: nhãn nằm ở `attributes.<nhãn>` (không có hậu tố `.keyword`), tên metric chứa dấu chấm nằm
nguyên trong một khóa `metrics.billing.outbox.pending`.

## ES|QL mẫu đã chạy được

```esql
FROM metrics-generic.otel-default*
| WHERE metrics.billing.outbox.pending IS NOT NULL
| STATS v = LAST(metrics.billing.outbox.pending, @timestamp)
    BY tenant = attributes.tenant, svc = resource.attributes.service.name
```

Kết quả: `acme` và `beta`, service `wallet`, giá trị 0. `STATS ... BY` trên `attributes.tenant` và trên
`resource.attributes.service.name` đều hoạt động.

## `LAST(field, @timestamp)`

**Có**: `LAST(metrics.billing.outbox.pending, @timestamp)` chạy được trên Elasticsearch 9.4.4
(trả về giá trị mới nhất theo từng nhóm).
