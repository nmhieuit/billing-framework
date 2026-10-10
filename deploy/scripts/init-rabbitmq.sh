#!/bin/sh
# Tạo vhost "billing", các user riêng và hai exchange tích hợp qua management API. Idempotent (PUT).
# Quyền lấy nguyên văn từ spec Bước 4 mục 3; tools/rabbitmq-init.test.ts chống lệch với @billing/testing.
set -eu

base="http://${RABBITMQ_HOST}:${RABBITMQ_MGMT_PORT}/api"
auth="${RABBITMQ_ADMIN_USER}:${RABBITMQ_ADMIN_PASSWORD}"

put() { curl -fsS -u "$auth" -H 'content-type: application/json' -X PUT "$base/$1" -d "$2"; }
user() { put "users/$1" "{\"password\":\"$2\",\"tags\":\"\"}"; }
permit() { put "permissions/billing/$1" "{\"configure\":\"$2\",\"write\":\"$3\",\"read\":\"$4\"}"; }

put "vhosts/billing" '{}'
# Tài khoản quản trị cần quyền trong vhost thì mới khai báo được exchange.
permit "$RABBITMQ_ADMIN_USER" '.*' '.*' '.*'

user billing_wallet "$WALLET_MQ_PASSWORD"
permit billing_wallet '^wallet\\..*' '^(billing\\.events|wallet\\..*)$' '^(orders\\.events|wallet\\..*)$'

user ecommerce_orders "$ECOMMERCE_MQ_PASSWORD"
permit ecommerce_orders '^ecommerce\\..*' '^(orders\\.events|ecommerce\\..*)$' '^(billing\\.events|ecommerce\\..*)$'

# Payment chưa dùng RabbitMQ: có tài khoản nhưng không có quyền nào.
user billing_payment "$PAYMENT_MQ_PASSWORD"
permit billing_payment '' '' ''

put "exchanges/billing/orders.events" '{"type":"topic","durable":true}'
put "exchanges/billing/billing.events" '{"type":"topic","durable":true}'

echo "rabbitmq: vhost 'billing', service users and integration exchanges ready"
