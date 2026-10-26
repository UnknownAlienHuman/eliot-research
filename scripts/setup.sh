#!/usr/bin/env sh
# K0 only. --plan/--check are offline; --apply explicitly configures Access and a custom domain.
# Cloudflare OpenAPI checked 2026-10-25 (America/New_York).
set -eu
export ELIOT_SETUP_MODE="${1:---plan}"
exec node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const mode = process.env.ELIOT_SETUP_MODE;
if (!['--plan', '--check', '--apply', '--help'].includes(mode)) throw new Error('Usage: sh scripts/setup.sh [--plan|--check|--apply|--help]');
const names = ['CLOUDFLARE_ACCOUNT_ID', 'ELIOT_HOSTNAME', 'ELIOT_OWNER_EMAIL', 'ELIOT_OWNER_SERVICE_TOKEN_ID', 'ELIOT_OWNER_SERVICE_TOKEN', 'ELIOT_ACCESS_TEAM_DOMAIN'];
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if (mode === '--plan' || mode === '--help') {
  console.log('Required environment: ' + names.join(', '));
  console.log('ELIOT_OWNER_SERVICE_TOKEN is the signed JWT common_name; ELIOT_OWNER_SERVICE_TOKEN_ID is the Access policy UUID. Neither is the client secret.');
  console.log('Set CLOUDFLARE_API_TOKEN only for --apply (Access: Apps and Policies Write; Workers Scripts Write).');
  console.log('1. --check validates the target and Worker protection offline.');
  console.log('2. --apply creates a self_hosted hostname Access app with owner-email and Service Auth policies, then binds the hostname to ' + config.name + '.');
  console.log('3. Copy the printed public vars into wrangler.jsonc, deploy the checked Worker, then exercise browser login and pnpm eval k0 with an owner service token.');
  console.log('Existing resources must match; no takeover, policy widening, service-token creation or secret printing.');
  process.exit(0);
}
for (const name of names) if (!process.env[name]) throw new Error('Missing ' + name);
const hostname = process.env.ELIOT_HOSTNAME;
const team = process.env.ELIOT_ACCESS_TEAM_DOMAIN;
if (!/^research\.[a-z0-9.-]+$/.test(hostname) || new URL('https://' + hostname).hostname !== hostname) throw new Error('ELIOT_HOSTNAME must be the exact research.<domain> hostname.');
if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) throw new Error('ELIOT_ACCESS_TEAM_DOMAIN must be a bare team hostname.');
if (!/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID)) throw new Error('Invalid account ID.');
if (!/^[^\s@]+@[^\s@]+$/.test(process.env.ELIOT_OWNER_EMAIL)) throw new Error('Invalid owner email.');
if (config.workers_dev !== false || config.preview_urls !== false || config.assets.run_worker_first !== true || config.vars.ELIOT_LOCAL_DEV !== '0') throw new Error('Worker must protect all assets, disable workers.dev/previews and disable local bypass.');
if (mode === '--check') { console.log('K0 setup configuration valid. No network calls made.'); process.exit(0); }
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Missing CLOUDFLARE_API_TOKEN for --apply.');
const account = '/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID;
async function api(method, path, body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(method + ' ' + path + ' failed (HTTP ' + response.status + '); inspect Cloudflare dashboard.');
  return data.result;
}
const domainPath = account + '/workers/domains';
const domains = await api('GET', domainPath + '?hostname=' + encodeURIComponent(hostname));
if (domains.some(domain => domain.service !== config.name)) throw new Error('Hostname is already bound to a different Worker; refusing takeover.');
const policies = [
  { name: 'Eliot owner', decision: 'allow', precedence: 1, include: [{ email: { email: process.env.ELIOT_OWNER_EMAIL } }] },
  { name: 'Eliot owner service token', decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: process.env.ELIOT_OWNER_SERVICE_TOKEN_ID } }] },
];
const appsPath = account + '/access/apps';
const apps = await api('GET', appsPath + '?domain=' + encodeURIComponent(hostname) + '&exact=true&per_page=2');
if (apps.length > 1) throw new Error('Multiple Access applications match the hostname; resolve in dashboard.');
let app = apps[0];
if (app) {
  const existing = await api('GET', appsPath + '/' + app.id + '/policies');
  const matches = policy => existing.some(item => item.decision === policy.decision && JSON.stringify(item.include) === JSON.stringify(policy.include) && !item.exclude?.length && !item.require?.length);
  if (app.type !== 'self_hosted' || existing.length !== 2 || !policies.every(matches)) throw new Error('Existing Access policies differ; refusing to change them.');
} else {
  app = await api('POST', appsPath, { name: config.name, type: 'self_hosted', domain: hostname, destinations: [{ type: 'public', uri: hostname }], session_duration: '24h', service_auth_401_redirect: true, policies });
}
await api('PUT', domainPath, { hostname, service: config.name, enabled: true, previews_enabled: false });
console.log(JSON.stringify({ ELIOT_ACCESS_TEAM_DOMAIN: team, ELIOT_ACCESS_AUD: app.aud, ELIOT_OWNER_EMAIL: process.env.ELIOT_OWNER_EMAIL, ELIOT_OWNER_SERVICE_TOKEN: process.env.ELIOT_OWNER_SERVICE_TOKEN, ELIOT_ORIGIN: 'https://' + hostname, ELIOT_LOCAL_DEV: '0' }, null, 2));
JS
