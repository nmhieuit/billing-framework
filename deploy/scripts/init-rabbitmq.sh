#!/bin/sh
# Tạo vhost "billing" và user riêng qua management API. Idempotent (PUT).
set -eu

base="http://${RABBITMQ_HOST}:${RABBITMQ_MGMT_PORT}/api"
auth="${RABBITMQ_ADMIN_USER}:${RABBITMQ_ADMIN_PASSWORD}"

put() { curl -fsS -u "$auth" -H 'content-type: application/json' -X PUT "$base/$1" -d "$2"; }

put "vhosts/billing" '{}'

for svc in wallet payment; do
  case "$svc" in
    wallet) pass="$WALLET_MQ_PASSWORD" ;;
    payment) pass="$PAYMENT_MQ_PASSWORD" ;;
  esac
  put "users/billing_${svc}" "{\"password\":\"${pass}\",\"tags\":\"\"}"
  put "permissions/billing/billing_${svc}" '{"configure":".*","write":".*","read":".*"}'
done

echo "rabbitmq: vhost 'billing' and service users ready"
