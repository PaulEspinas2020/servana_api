/* Read-only production measurement for Command 25 review APIs. */
const baseUrl = String(process.env.REVIEW_MEASURE_BASE_URL ?? '').replace(/\/$/, '');
const token = String(process.env.REVIEW_MEASURE_PROVIDER_TOKEN ?? '');
const iterations = Math.max(5, Math.min(Number(process.env.REVIEW_MEASURE_ITERATIONS ?? 30), 200));
const p95BudgetMs = Number(process.env.REVIEW_MEASURE_P95_BUDGET_MS ?? 1000);

if (!baseUrl || !token) {
  console.error('Set REVIEW_MEASURE_BASE_URL and REVIEW_MEASURE_PROVIDER_TOKEN.');
  process.exit(2);
}

const endpoints = ['/provider/performance', '/provider/reputation/summary', '/provider/reviews?limit=50'];
const percentile = (values, ratio) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
};

async function timedGet(path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  await response.arrayBuffer();
  const durationMs = performance.now() - started;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return durationMs;
}

// Warm connections and server caches once; warmup results are not reported.
await Promise.all(endpoints.map(timedGet));
let failed = false;
for (const endpoint of endpoints) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) samples.push(await timedGet(endpoint));
  const result = {
    endpoint,
    samples: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(1)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...samples).toFixed(1)),
    budgetMs: p95BudgetMs,
  };
  if (result.p95Ms > p95BudgetMs) failed = true;
  console.log(JSON.stringify(result));
}
process.exitCode = failed ? 1 : 0;
