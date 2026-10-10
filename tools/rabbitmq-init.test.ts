import { readFileSync } from 'node:fs';
import { BILLING_EXCHANGES, BILLING_VHOST_PERMISSIONS } from '@billing/testing';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../deploy/scripts/init-rabbitmq.sh', import.meta.url), 'utf8');

/** Giá trị như nó xuất hiện trong dấu nháy đơn của shell: regex `\.` được JSON thoát thành `\\.`. */
const shellValue = (value: string): string => `'${JSON.stringify(value).slice(1, -1)}'`;

describe('deploy/scripts/init-rabbitmq.sh', () => {
  it.each(Object.entries(BILLING_VHOST_PERMISSIONS))(
    'grants %s exactly the permissions the spec and the test helper use',
    (user, permission) => {
      const expected = `permit ${user} ${shellValue(permission.configure)} ${shellValue(permission.write)} ${shellValue(permission.read)}`;
      expect(script.split('\n').map((line) => line.trim())).toContain(expected);
    },
  );

  it('declares both integration exchanges as durable topic exchanges', () => {
    for (const name of BILLING_EXCHANGES) {
      expect(script).toContain(`put "exchanges/billing/${name}" '{"type":"topic","durable":true}'`);
    }
  });

  it('never involves the default exchange and never gives a service user a wildcard', () => {
    expect(script).not.toContain('amq.default');
    const serviceGrants = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^permit (billing_|ecommerce_)/.test(line));
    expect(serviceGrants).toHaveLength(3);
    for (const line of serviceGrants) expect(line).not.toContain("'.*'");
  });

  it('keeps billing_payment without any permission until it needs the broker', () => {
    expect(script).toContain("permit billing_payment '' '' ''");
  });

  it('gives the admin account access to the vhost before declaring exchanges', () => {
    const adminGrant = script.indexOf('permit "$RABBITMQ_ADMIN_USER"');
    const firstExchange = script.indexOf('put "exchanges/billing/');
    expect(adminGrant).toBeGreaterThan(-1);
    expect(adminGrant).toBeLessThan(firstExchange);
  });

  it('reads every password from the environment and embeds none', () => {
    for (const variable of ['WALLET_MQ_PASSWORD', 'PAYMENT_MQ_PASSWORD', 'ECOMMERCE_MQ_PASSWORD']) {
      expect(script).toContain(`"$${variable}"`);
    }
  });
});
