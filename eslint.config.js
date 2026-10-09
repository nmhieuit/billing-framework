import tseslint from 'typescript-eslint';

const SERVICES = ['wallet', 'payment'];
const LAYERS = ['domain', 'application', 'infrastructure', 'interface'];

const FRAMEWORKS = [
  '@nestjs/*',
  'fastify',
  'fastify/*',
  'kysely',
  'mssql',
  'tedious',
  'amqplib',
  'pino',
  'pino/*',
];

const layerImport = (layer) => ({
  group: [`**/${layer}/**`, `**/${layer}`],
  message: `Import từ lớp "${layer}" vi phạm hướng phụ thuộc (domain ← application ← infrastructure/interface).`,
});

const FORBIDDEN_BY_LAYER = {
  domain: [
    layerImport('application'),
    layerImport('infrastructure'),
    layerImport('interface'),
    { group: FRAMEWORKS, message: 'domain phải thuần: không import framework hay driver.' },
    {
      group: ['@billing/*', '!@billing/money'],
      message: 'domain chỉ được dùng @billing/money trong số các package dùng chung.',
    },
  ],
  application: [
    layerImport('infrastructure'),
    layerImport('interface'),
    {
      group: FRAMEWORKS,
      message: 'application chỉ phụ thuộc port, không phụ thuộc framework hay driver.',
    },
  ],
  infrastructure: [layerImport('interface')],
  interface: [layerImport('infrastructure')],
};

const otherService = (service) => {
  const other = SERVICES.find((s) => s !== service);
  return {
    group: [`**/${other}/src/**`, `@billing/${other}-service`, `@billing/${other}-service/*`],
    message: `Service "${service}" không được import code của service "${other}"; giao tiếp qua @billing/contracts.`,
  };
};

const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  // Cấm import chéo service ở mọi file của service (kể cả composition root).
  ...SERVICES.map((service) => ({
    files: [`services/${service}/src/**/*.ts`],
    rules: restrict([otherService(service)]),
  })),
  // Luật theo lớp; phải lặp lại luật chéo-service vì `no-restricted-imports` bị thay thế, không gộp.
  ...SERVICES.flatMap((service) =>
    LAYERS.map((layer) => ({
      files: [`services/${service}/src/${layer}/**/*.ts`],
      rules: restrict([...FORBIDDEN_BY_LAYER[layer], otherService(service)]),
    })),
  ),
];
