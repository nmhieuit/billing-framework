import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('architecture boundaries', () => {
  it('forbids domain from importing infrastructure', async () => {
    const v = await violations(
      'services/wallet/src/domain/wallet.ts',
      "import { db } from '../infrastructure/db.js';\nexport const x = db;\n",
    );
    expect(v).toHaveLength(1);
  });

  it('forbids domain from importing frameworks and drivers', async () => {
    for (const lib of ['kysely', 'fastify', '@nestjs/common', 'amqplib', 'pino']) {
      const v = await violations(
        'services/wallet/src/domain/wallet.ts',
        `import x from '${lib}';\nexport const y = x;\n`,
      );
      expect(v, lib).toHaveLength(1);
    }
  });

  it('forbids domain from importing shared packages other than money', async () => {
    const bad = await violations(
      'services/wallet/src/domain/wallet.ts',
      "import { validateMessage } from '@billing/contracts';\nexport const y = validateMessage;\n",
    );
    expect(bad).toHaveLength(1);
    const ok = await violations(
      'services/wallet/src/domain/wallet.ts',
      "import { Money } from '@billing/money';\nexport const y = Money;\n",
    );
    expect(ok).toHaveLength(0);
  });

  it('forbids application from importing infrastructure, interface and frameworks', async () => {
    for (const spec of ['../infrastructure/db.js', '../interface/http/app.js', 'fastify']) {
      const v = await violations(
        'services/payment/src/application/charge.ts',
        `import x from '${spec}';\nexport const y = x;\n`,
      );
      expect(v, spec).toHaveLength(1);
    }
  });

  it('forbids interface from importing infrastructure', async () => {
    const v = await violations(
      'services/payment/src/interface/http/app.ts',
      "import { db } from '../../infrastructure/db.js';\nexport const x = db;\n",
    );
    expect(v).toHaveLength(1);
  });

  it('allows infrastructure to import application and domain', async () => {
    const v = await violations(
      'services/wallet/src/infrastructure/repo.ts',
      "import { a } from '../application/a.js';\nimport { d } from '../domain/d.js';\nexport const x = [a, d];\n",
    );
    expect(v).toHaveLength(0);
  });

  it('forbids one service from importing the other, in every layer', async () => {
    const cases: Array<[string, string]> = [
      ['services/wallet/src/application/x.ts', '../../../payment/src/domain/charge.js'],
      ['services/wallet/src/main.ts', '@billing/payment-service'],
      ['services/payment/src/infrastructure/x.ts', '../../../wallet/src/domain/wallet.js'],
      ['services/payment/src/domain/x.ts', '@billing/wallet-service'],
    ];
    for (const [file, spec] of cases) {
      const v = await violations(file, `import x from '${spec}';\nexport const y = x;\n`);
      // Một import có thể vi phạm thêm luật khác (ví dụ domain cấm @billing/*); chỉ cần có luật chéo-service.
      expect(
        v.some((message) => message.includes('không được import code của service')),
        `${file} -> ${spec}`,
      ).toBe(true);
    }
  });
});
