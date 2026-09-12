import readline from 'node:readline';
import { sleep } from './util.js';

export class VkApiError extends Error {
  constructor(method, body) {
    super(`VK API ${method} failed: [${body.error_code}] ${body.error_msg}`);
    this.name = 'VkApiError';
    this.method = method;
    this.code = body.error_code;
    this.body = body;
  }
}

// Error codes worth knowing:
//   5  user authorization failed (bad/expired token)
//   6  too many requests per second
//   9  flood control
//  10  internal server error
//  14  captcha needed
//  15  access denied
//  17  validation required (open redirect_uri in a browser)
//  18  user deleted/banned
//  29  rate limit reached (method quota)
// 917  you don't have access to this chat (kicked)
// 924  can't forward these messages
const RETRYABLE = new Set([1, 6, 9, 10, 29]);
export const ALT_DOMAINS = ['vk.com', 'vk.ru'];

/**
 * Minimal VK API client:
 *  - serialises requests and keeps them under the 3 req/s user-token limit
 *  - retries transient errors (network, 6/9/10/29) with backoff
 *  - handles captcha by asking on stdin
 */
export class VkApi {
  constructor({
    token,
    version = '5.131',
    domain = 'vk.com',
    baseUrl,
    userAgent,
    minInterval = 340,
    maxRetries = 6,
    timeoutMs = 20000,
    log = console,
    captchaSolver,
    fetchImpl = globalThis.fetch,
    lang = 'ru',
  }) {
    if (!token) throw new Error('Access token is required');
    this.token = token;
    this.version = version;
    // VK serves the same API from api.vk.com and api.vk.ru; if one host is unreachable we switch to the other.
    this.altBases = baseUrl ? [] : ALT_DOMAINS.filter((d) => d !== domain).map((d) => `https://api.${d}/method/`);
    const base = baseUrl ?? `https://api.${domain}/method/`;
    this.baseUrl = base.endsWith('/') ? base : `${base}/`;
    this.userAgent = userAgent;
    this.minInterval = minInterval;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this._redirects = 0;
    this.log = log;
    this.captchaSolver = captchaSolver ?? defaultCaptchaSolver;
    this.fetch = fetchImpl;
    this.lang = lang;
    this._queue = Promise.resolve();
    this._lastCall = 0;
    this.stats = { calls: 0, retries: 0 };
  }

  /** Call a VK API method. Returns the `response` field. */
  call(method, params = {}) {
    // Serialise all calls through one promise chain so we never exceed the rate limit.
    const run = this._queue.then(() => this._callWithRetries(method, params));
    this._queue = run.catch(() => {});
    return run;
  }

  async _throttle() {
    const wait = this._lastCall + this.minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastCall = Date.now();
  }

  async _callWithRetries(method, params) {
    let attempt = 0;
    let extra = {};
    for (;;) {
      await this._throttle();
      let body;
      try {
        body = await this._request(method, { ...params, ...extra });
      } catch (err) {
        // VK answered with a redirect to another host (vk.com -> vk.ru): follow it and re-POST.
        if (err.redirectBase) {
          if (this._redirects++ >= 3) throw new Error(`Too many redirects from ${this.baseUrl}`);
          this.log.warn(`${method}: ${this.baseUrl} redirects to ${err.redirectBase}; switching`);
          this.altBases = this.altBases.filter((b) => b !== err.redirectBase);
          this.baseUrl = err.redirectBase;
          continue;
        }
        // Network-level failure. First try the alternative API host (vk.com <-> vk.ru).
        if (this.altBases.length) {
          const next = this.altBases.shift();
          this.log.warn(`${method}: ${this.baseUrl} unreachable (${err.message}); switching to ${next}`);
          this.baseUrl = next;
          continue;
        }
        if (attempt >= this.maxRetries) throw err;
        attempt += 1;
        this.stats.retries += 1;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        this.log.warn(`${method}: network error (${err.message}); retry ${attempt}/${this.maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (body.error) {
        const e = body.error;
        if (e.error_code === 14) {
          this.log.warn(`${method}: VK asks for a captcha`);
          const key = await this.captchaSolver(e.captcha_img, e.captcha_sid);
          extra = { captcha_sid: e.captcha_sid, captcha_key: key };
          continue;
        }
        if (RETRYABLE.has(e.error_code) && attempt < this.maxRetries) {
          attempt += 1;
          this.stats.retries += 1;
          const base = e.error_code === 9 || e.error_code === 29 ? 5000 : 700;
          const delay = Math.min(60000, base * 2 ** (attempt - 1));
          const say = e.error_code === 6 ? this.log.debug : this.log.warn;
          say.call(this.log, `${method}: VK says [${e.error_code}] ${e.error_msg}; waiting ${Math.round(delay / 1000)}s and retrying (${attempt}/${this.maxRetries})`);
          await sleep(delay);
          continue;
        }
        throw new VkApiError(method, e);
      }
      return body.response;
    }
  }

  async _request(method, params) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    form.set('access_token', this.token);
    form.set('v', this.version);
    if (this.lang) form.set('lang', this.lang);
    this.stats.calls += 1;
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.userAgent) headers['user-agent'] = this.userAgent;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${method}`, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: controller.signal,
        // Follow cross-host redirects ourselves: an automatic 301/302 would turn the POST into a GET and drop the token.
        redirect: 'manual',
      });
      const location = res.headers?.get?.('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const target = new URL(location, `${this.baseUrl}${method}`);
        const err = new Error(`HTTP ${res.status} redirect to ${target.origin}`);
        err.redirectBase = `${target.origin}/method/`;
        throw err;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}, non-JSON response: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function defaultCaptchaSolver(imgUrl) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`\nCaptcha required. Open this image in a browser and type the text:\n  ${imgUrl}\n> `, resolve);
  });
  rl.close();
  return answer.trim();
}
