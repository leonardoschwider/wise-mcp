#!/usr/bin/env node
/**
 * Wise personal-account capability probe. Read-only API GETs only.
 * Displays status codes and result counts, NEVER balances, transactions, tokens,
 * names, account IDs, Wise response bodies, or a copied credential.
 */
const token = process.env.WISE_API_TOKEN;
if (!token || token.length < 16) {
  console.error('Wise token not configured. Enrol via the secure host-specific prompt.');
  process.exit(1);
}
const isTest = process.env.WISE_MCP_TEST_MODE === 'true';
const api = isTest ? process.env.WISE_API_URL : 'https://api.wise.com';
if (!api) { console.error('Missing local test API URL.'); process.exit(1); }
let base;
try {
  base = new URL(api);
  if (!isTest && base.origin !== 'https://api.wise.com') throw new Error();
  if (isTest && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error();
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error();
} catch {
  console.error('Refusing a non-Wise API endpoint.');
  process.exit(1);
}
const results = [];
const get = async (label, route) => {
  try {
    const target = new URL(route, base);
    const response = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
    const entry = { check: label, http: response.status, result: response.ok ? 'OK' : response.status === 403 ? 'RESTRICTED' : 'FAILED' };
    results.push(entry);
    // Profiles are needed to make subsequent read-only calls, never logged.
    if (response.ok && label === 'profiles') return await response.json();
  } catch {
    results.push({ check: label, http: null, result: 'NETWORK_ERROR' });
  }
  return null;
};

await get('identity', '/v1/me');
const profiles = await get('profiles', '/v2/profiles');
const profile = Array.isArray(profiles)
  ? profiles.find(p => p.type === 'PERSONAL') ?? profiles[0]
  : null;
const profileId = profile && Number(profile.id);
if (Number.isSafeInteger(profileId) && profileId > 0) {
  const id = encodeURIComponent(String(profileId));
  await Promise.all([
    get('balances', `/v4/profiles/${id}/balances?types=STANDARD`),
    get('jars', `/v4/profiles/${id}/balances?types=SAVINGS`),
    get('transactions_and_card_activity', `/v1/profiles/${id}/activities?size=5`),
    get('transfers', `/v1/transfers?profile=${id}&limit=5`),
    get('recipients', `/v2/accounts?profileId=${id}&size=5`),
    get('exchange_rate', '/v1/rates?source=EUR&target=USD')
  ]);
}
for (const item of results) {
  const http = item.http === null ? 'network' : item.http;
  console.log(`${item.check.padEnd(32)} ${String(http).padEnd(8)} ${item.result}`);
}
console.log('No financial data, tokens, names or account identifiers were printed.');
if (!profile) console.error('Profile discovery unavailable; downstream endpoint tests were skipped.');
process.exitCode = !profile ? 1 : results.some(x => x.result !== 'OK') ? 2 : 0;
