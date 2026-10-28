import { isIP } from 'node:net';

function parseHttpUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} must be an absolute HTTP(S) URL.`); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new Error(`${label} must use HTTP(S) and must not contain userinfo.`);
  }
  return url;
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) return host.split('.')[0] === '127';
  return version === 6 && host === '::1';
}

/**
 * Validate the raw ELIOT_URL before attaching credentials. Pass it before
 * calling URL.origin, which would discard userinfo. `configuredOrigin` must
 * come from the explicit ELIOT_ORIGIN setting; it is never inferred from ELIOT_URL.
 * Returns the normalized target origin for callers to build same-origin URLs.
 */
export function assertEvalOrigin(origin, configuredOrigin) {
  const target = parseHttpUrl(origin, 'ELIOT_URL');
  let configured = null;
  if (configuredOrigin !== undefined && configuredOrigin !== '') {
    const allowed = parseHttpUrl(configuredOrigin, 'ELIOT_ORIGIN');
    if (allowed.pathname !== '/' || allowed.search !== '' || allowed.hash !== '') {
      throw new Error('ELIOT_ORIGIN must be a bare HTTP(S) origin.');
    }
    configured = allowed.origin;
  }
  if (isLoopbackHostname(target.hostname) || target.origin === configured) return target.origin;
  throw new Error('Refusing evaluation credentials for an origin outside loopback and explicit ELIOT_ORIGIN.');
}

/** Browser journeys use the existing loopback development auth path only. */
export function assertEvalBrowserOrigin(origin, configuredOrigin) {
  const normalized = assertEvalOrigin(origin, configuredOrigin);
  if (!isLoopbackHostname(new URL(normalized).hostname)) {
    throw new Error('This browser eval is local-only: Playwright Access headers cannot be safely scoped across remote redirects/WebSockets. Use loopback; Node API requests may use the separately configured ELIOT_ORIGIN.');
  }
  return normalized;
}

/** Node eval requests never follow redirects with Access headers attached. */
export function evalFetchOptions(init = {}) {
  const redirect = init.redirect ?? 'error';
  if (redirect !== 'error' && redirect !== 'manual') {
    throw new Error('Eval requests must reject redirects or inspect them manually.');
  }
  return { ...init, credentials: 'omit', redirect };
}

/**
 * Send an eval request only to the already validated Eliot origin. This keeps
 * credentials out of foreign URLs and makes redirect handling explicit.
 */
export function fetchEval(url, init = {}, targetOrigin, configuredOrigin) {
  const requestUrl = parseHttpUrl(url instanceof URL ? url.href : url, 'Eval request URL');
  const requestOrigin = assertEvalOrigin(requestUrl.href, configuredOrigin);
  const allowedOrigin = assertEvalOrigin(targetOrigin, configuredOrigin);
  if (requestOrigin !== allowedOrigin) {
    throw new Error('Refusing to send eval headers outside the selected Eliot origin.');
  }
  return globalThis.fetch(requestUrl.href, evalFetchOptions(init));
}
