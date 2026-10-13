const newman = require('newman'); const path = require('path');
const B = path.resolve(__dirname, '..');
const [,, key, folder, extra] = process.argv;
const env = JSON.parse(require('fs').readFileSync(B + '/billing-local.postman_environment.json', 'utf8'));
env.values = env.values.map((v) => (v.key === 'webhook_secret' ? { ...v, value: 'local-only-webhook-secret' } : v.key === 'reconciliation_resolve_enabled' && extra === 'resolve' ? { ...v, value: 'true' } : v));
newman.run({ collection: `${B}/${key}/${key}.postman_collection.json`, environment: env, folder: folder.split(','), reporters: [], timeoutRequest: 60000, delayRequest: 0 }, (err, sum) => {
  if (err) { console.error('ERR', err); process.exit(2); }
  const s = sum.run.stats; console.log(`${key} [${folder}] requests ${s.requests.total} (failed ${s.requests.failed}) | assertions ${s.assertions.total} (failed ${s.assertions.failed}) | scripts errors ${sum.run.failures.filter(f=>f.error.name!=='AssertionError').length}`);
  for (const f of sum.run.failures) console.log('  -', (f.source && f.source.name) || '?', '::', f.error.test || f.error.name, '::', (f.error.message || '').slice(0, 160));
});
