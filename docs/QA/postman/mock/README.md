# Mock để chạy thử các collection Postman

> **Chỉ để kiểm tra script, chaining và thứ tự chạy của collection. KHÔNG phải service thật.**
> `server.js` là mock tối giản của wallet (`:3001`) và payment (`:3002`), viết theo cách đọc code; nó dùng chung cách hiểu với collection nên **không chứng minh** service thật trả đúng như kỳ vọng. Việc chạy trên stack local mới là bước kiểm chứng thật.

## Chạy

```bash
# Terminal 1 (cần Node >= 18; mặc định secret webhook là local-only-webhook-secret, đổi bằng WEBHOOK_SECRET)
node docs/QA/postman/mock/server.js

# Terminal 2 (cần newman: npm install newman@6 trong một thư mục tạm)
cd <thư mục có newman>
NODE_PATH=$PWD/node_modules node <repo>/docs/QA/postman/mock/run.js payment Smoke,Regression,EndPoints
# lần lượt: payment, wallet, ops, reconciliations
# bật đóng ca đối soát: thêm đối số thứ ba `resolve` (cần có ca OPEN, ví dụ tạo charge có metadata.tenantId rồi chạy lại)
```

`run.js <collection> <folder[,folder]> [resolve]` chạy Newman với environment `billing-local` (tự điền `webhook_secret=local-only-webhook-secret` cho mock) và in số request/assertion và các lỗi.

Kết quả đã chạy (2 lượt liên tiếp, 0 lỗi): payment 87-88 request / 178-180 assertion; wallet 96 / 201; ops 100 / 207; reconciliations 55 / 110.
