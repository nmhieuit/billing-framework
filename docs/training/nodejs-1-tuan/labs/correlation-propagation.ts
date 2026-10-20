// Bài lab Ngày 3: correlation id đi đến đâu trong luồng nạp tiền wallet -> payment? (chạy code THẬT)
//   A. HttpPaymentGateway (wallet) có gửi header x-correlation-id sang payment không?
//   B. Payment (Fastify thật, buildApp) làm gì với header đó?
//   C. AsyncLocalStorage có sống qua việc chạy nền (InlineTopupSubmitter) không? Còn đường Worker thì sao?
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/correlation-propagation.ts
import { randomUUID } from 'node:crypto';
import { InlineTopupSubmitter } from '../../../../services/wallet/src/application/inline-topup-submitter.js';
import { HttpPaymentGateway } from '../../../../services/wallet/src/infrastructure/http-payment-gateway.js';
import { buildApp } from '../../../../services/payment/src/interface/http/app.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { Money } from '../../../../packages/money/src/index.js';
import {
  CORRELATION_HEADER,
  getCorrelationId,
  runWithCorrelation,
} from '../../../../packages/observability/src/index.js';

const CID = randomUUID();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

console.log(`correlation id của "khách": ${CID}\n`);

// ---- A. Wallet gọi payment: header nào được gửi đi? ----
console.log('=== A. HttpPaymentGateway.createCharge, chạy TRONG ngữ cảnh correlation của request ===');
let sentHeaders: Record<string, string> = {};
const gateway = new HttpPaymentGateway({
  baseUrl: 'http://payment.invalid',
  timeoutMs: 1000,
  fetchImpl: (async (_url: unknown, init?: RequestInit) => {
    sentHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ chargeId: 'ch_1' }), { status: 202 });
  }) as typeof fetch,
});
await runWithCorrelation(CID, () =>
  gateway.createCharge({
    idempotencyKey: 'topup:acme:tp_1',
    amount: Money.of(50_000, 'VND'),
    reference: 'tp_1',
    metadata: { tenantId: 'acme' },
  }),
);
console.log('header gửi sang payment:', Object.keys(sentHeaders).join(', '));
console.log(
  `có ${CORRELATION_HEADER} không? ${CORRELATION_HEADER in sentHeaders ? `CÓ (= ${sentHeaders[CORRELATION_HEADER]})` : 'KHÔNG'}\n`,
);

// ---- B. Payment thật (Fastify) xử lý header correlation ----
console.log('=== B. Payment (buildApp thật): nhận/sinh correlation id ===');
let seenInHandler: string | undefined;
const payment = await buildApp({
  createCharge: {
    async execute() {
      seenInHandler = getCorrelationId(); // đọc từ AsyncLocalStorage ngay trong handler
      return {
        status: 202,
        body: { chargeId: 'ch_1' } as never,
        replayed: false,
        responseTimeout: false,
      };
    },
  },
  getCharge: { execute: async () => ({}) as never },
  getSettlement: { execute: async () => ({}) as never },
  responseTimeoutMs: 10,
});
const post = (headers: Record<string, string>) =>
  payment.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'idempotency-key': 'k1', 'content-type': 'application/json', ...headers },
    payload: { amount: 1000, currency: 'VND', reference: 'r1' },
  });

const withHeader = await post({ [CORRELATION_HEADER]: CID });
console.log(`gửi kèm header: handler thấy ${seenInHandler}; response header ${withHeader.headers[CORRELATION_HEADER]}`);
console.log(`  -> giữ nguyên id của khách? ${seenInHandler === CID ? 'CÓ' : 'KHÔNG'}`);
const without = await post({});
console.log(`KHÔNG gửi header: handler thấy ${seenInHandler}`);
console.log(`  -> khác id của khách (payment tự sinh id mới)? ${seenInHandler !== CID ? 'ĐÚNG' : 'SAI'}\n`);
await payment.close();

// ---- C. AsyncLocalStorage qua việc chạy nền ----
console.log('=== C. Việc chạy nền (submitSoon, không await) có còn correlation id? ===');
const seen: Record<string, string | undefined> = {};
const submitter = new InlineTopupSubmitter({
  submit: {
    async executeFor(_tenant: TenantId, topupId: string) {
      seen[`${topupId}@đầu`] = getCorrelationId();
      await sleep(20); // I/O: chờ payment
      seen[`${topupId}@sau await`] = getCorrelationId();
    },
  } as never,
  log: noopLogger,
});
runWithCorrelation(CID, () => submitter.submitSoon(TenantId.parse('acme'), 'tp_http'));
submitter.submitSoon(TenantId.parse('acme'), 'tp_worker'); // giống đường Worker: không có ngữ cảnh request
await submitter.drain();
for (const [k, v] of Object.entries(seen)) console.log(`${k.padEnd(22)} -> ${v ?? '(không có correlation id)'}`);
