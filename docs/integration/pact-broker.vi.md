# Pact Broker cho hợp đồng wallet ↔ orders

Hai chiều hợp đồng giữa billing và ecommerce được kiểm bằng Pact (message pact):

| Event                                 | Consumer | Provider |
| ------------------------------------- | -------- | -------- |
| `OrderReadyForPaymentV1`              | `wallet` | `orders` |
| `OrderPaidV1`, `OrderPaymentFailedV1` | `orders` | `wallet` |

Broker là nơi hai repo gặp nhau: mỗi bên publish pact và kết quả verify của mình, `can-i-deploy` cho biết một phiên bản
có an toàn để triển khai không. JSON Schema trong `packages/contracts` vẫn là chốt chặn thứ hai ở mỗi bên.

## Chạy broker cục bộ

```bash
cp deploy/.env.example deploy/.env      # điền PACT_BROKER_DB_PASSWORD, PACT_BROKER_USERNAME, PACT_BROKER_PASSWORD
docker compose -f deploy/compose.pact-broker.yml --env-file deploy/.env up -d
curl -u "$PACT_BROKER_USERNAME:$PACT_BROKER_PASSWORD" http://localhost:9292/diagnostic/status/heartbeat
```

`PACT_BROKER_DB_PASSWORD` chỉ gồm chữ, số, `-`, `_` vì nằm trong URL kết nối Postgres.

## Publish pact của wallet (consumer)

`corepack pnpm test` sinh `pacts/wallet-orders.json` (thư mục `pacts/` không được commit). Rồi:

```bash
docker run --rm --network pact-broker_default -v "$PWD/pacts:/pacts" \
  -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker publish /pacts \
  --consumer-app-version "$(git rev-parse --short HEAD)" --branch "$(git branch --show-current)"
```

Git Bash trên Windows: đặt `MSYS_NO_PATHCONV=1` và dùng `$(pwd -W)/pacts` cho phần trước dấu `:`.

## Verify wallet (provider) và publish kết quả

```bash
PACT_BROKER_BASE_URL=http://localhost:9292 PACT_BROKER_USERNAME=... PACT_BROKER_PASSWORD=... \
PACT_PUBLISH_VERIFICATION=true PACT_PROVIDER_VERSION="$(git rev-parse --short HEAD)" \
PACT_PROVIDER_BRANCH="$(git branch --show-current)" corepack pnpm test:contract
```

Không đặt `PACT_BROKER_BASE_URL` thì test verify pact mẫu `services/wallet/pact-fixtures/orders-wallet.json`.

## `can-i-deploy`

```bash
docker run --rm --network pact-broker_default \
  -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker can-i-deploy --pacticipant wallet --version "$(git rev-parse --short HEAD)"
```

"no" nghĩa là còn pact chưa được verify hoặc verify thất bại; "yes" khi mọi hợp đồng của phiên bản đó đã được verify.

## Jenkins

Stage `Contract tests (Pact)` chỉ chạy khi biến môi trường `PACT_BROKER_BASE_URL` của job/folder khác rỗng. Địa chỉ broker
**không** là tham số build và credentials id là hằng `pact-broker` (credential username/password trong Jenkins): nếu để
người chạy build tự nhập địa chỉ, họ sẽ gửi được mật khẩu broker tới một host tùy ý. Hãy định nghĩa
`PACT_BROKER_BASE_URL` ở cấu hình job hoặc folder (Environment variables / Folder properties). Credential được truyền cho
container bằng tên biến môi trường. Image `pact-cli` ghim theo digest trong `Jenkinsfile` (biến `PACT_CLI_IMAGE`,
hiện là pact-cli 1.78.0); muốn nâng cấp, đổi digest rồi chạy lại `docker run --rm <image> pact-broker --help`.
`can-i-deploy` "no" chỉ làm build `UNSTABLE` cho đến khi bật `PACT_ENFORCE_CAN_I_DEPLOY`. Giả định agent có Docker trực
tiếp trên host (đường dẫn `-v "$WORKSPACE/pacts"` phải đổi nếu agent là container lồng nhau).

## Giới hạn hiện tại

- Ecommerce chưa nối CI vào broker: pact `orders → wallet` lấy từ pact mẫu khi chạy cục bộ và từ broker khi ecommerce đã publish.
- Manifest K8s và Vault cho broker thuộc hạ tầng chung (Bước 6).
- Ghim phiên bản image `pactfoundation/pact-broker` khi triển khai thật (image `pact-cli` của Jenkins đã ghim theo digest).
