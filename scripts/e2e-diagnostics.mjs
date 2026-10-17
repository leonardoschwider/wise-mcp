#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const token = randomUUID();
let nonGet = false;
const server = createServer((req, res) => {
  if (req.method !== 'GET') nonGet = true;
  const route = new URL(req.url, 'http://localhost').pathname;
  let status = 200;
  let body = {};
  if (req.headers.authorization !== 'Bearer ' + token) status = 401;
  else if (route === '/v2/profiles') body = [{ id: 123, type: 'PERSONAL' }];
  else if (route.endsWith('/activities')) status = 403;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const { port } = server.address();
const child = spawn(process.execPath, [resolve('scripts/diagnose-personal-account.mjs')], {
  cwd: process.cwd(),
  env: { ...process.env, WISE_API_TOKEN: token, WISE_MCP_TEST_MODE: 'true', WISE_API_URL: 'http://127.0.0.1:' + port }
});
let output = '';
child.stdout.on('data', x => output += String(x));
child.stderr.on('data', x => output += String(x));
const code = await new Promise(ok => child.on('close', ok));
server.close();
const ok = code === 2 && !nonGet &&
  output.includes('transactions_and_card_activity') &&
  output.includes('RESTRICTED') &&
  output.includes('balances') &&
  output.includes('OK') &&
  !output.includes(token) && !output.includes('123');
console.log(ok ? 'PASS: personal diagnostics are GET-only, report restrictions, and redact credentials/data.' :
  'FAIL: personal diagnostics mock test did not pass.');
process.exit(ok ? 0 : 1);
