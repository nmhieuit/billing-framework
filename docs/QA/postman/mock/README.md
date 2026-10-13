# Mock để chạy thử các collection Postman

> **Chỉ để kiểm tra script, chaining và thứ tự chạy của collection. KHÔNG phải service thật.**
> `server.cjs` là mock tối giản của wallet (`:3001`) và payment (`:3002`), viết theo cách đọc code; nó dùng chung cách hiểu với collection nên **không chứng minh** service thật trả đúng như kỳ vọng. Việc chạy trên stack local mới là bước kiểm chứng thật.
>
> Các tệp là **CommonJS** (`.cjs`) vì `package.json` của repo có `"type": "module"`; đặt tên `.js` sẽ lỗi `require is not defined`.

## Chạy các collection wallet, payment, ops, reconciliations

```bash
# Terminal 1 (Node >= 18). Secret webhook mặc định: local-only-webhook-secret (đổi bằng WEBHOOK_SECRET)
node docs/QA/postman/mock/server.cjs

# Terminal 2 (cần newman: npm install newman@6 trong một thư mục tạm, rồi trỏ NODE_PATH vào node_modules đó)
NODE_PATH=<thư mục tạm>/node_modules node docs/QA/postman/mock/run.cjs payment Smoke,Regression,EndPoints
# lần lượt: payment, wallet, ops, reconciliations
# bật đóng ca đối soát: thêm đối số thứ ba `resolve` (cần có ca OPEN)
```

`run.cjs <collection> <folder[,folder]> [resolve]` chạy Newman với environment `billing-local` (tự điền `webhook_secret` cho mock) và in số request/assertion và các lỗi.

## Chạy collection chaos (`chaos/`)

Collection chaos giữ trạng thái giữa các folder trong **biến environment** (`ch_*`), nên chạy từng folder và dùng chung một file trạng thái:

```bash
S=/tmp/chaos-state.json; rm -f $S
node docs/QA/postman/mock/run-chaos.cjs $S Smoke 1
node docs/QA/postman/mock/run-chaos.cjs $S Workload 12     # 12 lượt lặp
node docs/QA/postman/mock/run-chaos.cjs $S Oracle 1
node docs/QA/postman/mock/run-chaos.cjs $S Regression 1
```

Cờ lỗi của mock (đặt trong môi trường khi chạy `server.cjs`) để **chứng minh oracle bắt được lỗi**:

| Biến | Giá trị | Hiệu ứng | Oracle phải báo |
| --- | --- | --- | --- |
| `MOCK_FLAKY` | `0.3` | 30% `POST /topups` và `/ops/*` trả `503` (một nửa **trước** khi xử lý, một nửa **sau** khi đã xử lý nhưng mất phản hồi) | Không vi phạm (client gửi lại cùng khóa) |
| `MOCK_BUG` | `double_credit` | Webhook thành công được áp dụng hai lần | `DUPLICATE_BUSINESS_KEY`, `TOPUP_TX_MISSING` (INV-1/2/3) |
| `MOCK_BUG` | `lost_entry` | Cộng ví nhưng không ghi dòng sổ cái | `BALANCE_DRIFT`, `TOPUP_TX_MISSING` |
| `MOCK_BUG` | `dup_adjust` | Gửi lại cùng khóa ops chạy lại hiệu ứng | `IDEMPOTENT_REPLAY_MISMATCH` (INV-6) |
| `MOCK_BUG` | `stuck` | Topup không bao giờ hoàn tất | `TOPUP_NOT_SETTLED` / quiesce hết hạn |

Kết quả đã chạy và giới hạn: xem `docs/QA/11-postman-chaos.md`.
