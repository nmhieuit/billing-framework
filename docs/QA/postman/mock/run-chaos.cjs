// Chạy một folder của collection chaos và GIỮ trạng thái (biến environment ch_*) giữa các lần chạy.
// Dùng: node run-chaos.js <file-trạng-thái.json> <folder> [số-lượt-lặp]
// File trạng thái được tạo từ billing-local.postman_environment.json ở lần chạy đầu và được ghi đè sau mỗi lần.
const newman = require('newman'); const path = require('path'); const fs = require('fs');
const B = path.resolve(__dirname, '..');
const [,, statePath, folder, iterations] = process.argv;
if (!statePath || !folder) { console.error('Usage: node run-chaos.js <state.json> <folder> [iterations]'); process.exit(2); }
if (!fs.existsSync(statePath)) {
  const env = JSON.parse(fs.readFileSync(B + '/billing-local.postman_environment.json', 'utf8'));
  env.values = env.values.map((v) => (v.key === 'webhook_secret' && !v.value ? { ...v, value: process.env.WEBHOOK_SECRET || 'local-only-webhook-secret' } : v));
  fs.writeFileSync(statePath, JSON.stringify(env));
}
newman.run({ collection: `${B}/chaos/chaos.postman_collection.json`, environment: statePath, exportEnvironment: statePath, folder: folder.split(','), iterationCount: parseInt(iterations || '1', 10), reporters: [], timeoutRequest: 120000 }, (err, sum) => {
  if (err) { console.error('ERR', err); process.exit(2); }
  const s = sum.run.stats;
  console.log(`chaos [${folder}] x${iterations || 1}: requests ${s.requests.total} (failed ${s.requests.failed}) | assertions ${s.assertions.total} (failed ${s.assertions.failed})`);
  const seen = new Set();
  for (const f of sum.run.failures) { const line = `  - ${(f.source && f.source.name) || '?'} :: ${f.error.test || f.error.name} :: ${(f.error.message || '').slice(0, 200)}`; if (!seen.has(line)) { seen.add(line); console.log(line); } }
  process.exit(sum.run.failures.length ? 1 : 0);
});
