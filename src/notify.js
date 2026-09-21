import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// Client for the LAN notification gateway. It replaces the public push topic approverr used to post to:
// every publish is bearer-authenticated and stays on the LAN, so a card may now carry detail that the old
// path could not.
//
// Two rules shape this file:
//
//   1. A notification must never delay or fail an approval. `publish()` is fire-and-forget, one attempt
//      gets a short deadline, and nothing here ever throws or rejects.
//   2. A gateway restart must not eat the message. A failed send goes into a bounded in-memory queue and
//      is retried with exponential backoff. The queue is deliberately small: when it is full the oldest
//      message is dropped with a log line, because a stale approval notice is worth less than the newest
//      one and an unbounded queue is a memory leak in a process that runs for months.
//
// The token is never logged. Every log line goes through a redactor as a second line of defence, in case
// a fetch implementation ever puts a header into an error message.

const NOTIFY_PATH = "/v1/notify";

// Field limits from the gateway's publish API. Over-long values are refused there with a 400, so they are
// clamped here instead: a truncated notification beats a dropped one.
const MAX_TITLE = 120;
const MAX_BODY = 1000;
const MAX_DETAIL = 2000;

export const DEFAULTS = {
  timeoutMs: 3000,
  maxQueue: 50,
  maxAttempts: 6,
  baseDelayMs: 5000,
  maxDelayMs: 300000,
};

function clamp(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// The gateway accepts [a-z0-9._-] for `host`, so anything else is dropped rather than rejected there.
function sanitizeHost(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
  return cleaned || undefined;
}

function describe(error) {
  if (!error) return "unknown error";
  const name = error.name || error.constructor?.name || "Error";
  return error.message ? `${name}: ${error.message}` : name;
}

// A timeout, a refused connection and a gateway that is restarting are all worth retrying. Any other 4xx
// means the message itself is wrong, and retrying it just burns the rate limit.
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export default class NotifyClient {
  constructor(options = {}) {
    const env = options.env ?? process.env;

    this.url = String(options.url ?? env.NOTIFY_URL ?? "").trim().replace(/\/+$/, "");
    this.token = String(options.token ?? env.NOTIFY_TOKEN ?? "").trim();
    this.host = sanitizeHost(options.host ?? env.NOTIFY_HOST ?? hostname());
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxQueue = options.maxQueue ?? DEFAULTS.maxQueue;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? console;

    this.queue = [];
    this.timer = null;
    this.draining = false;
  }

  // Notifications are off, not broken, when either half of the configuration is missing.
  get enabled() {
    return Boolean(this.url && this.token);
  }

  get queueLength() {
    return this.queue.length;
  }

  // Fire-and-forget. The returned promise always resolves (true when the gateway accepted the message) and
  // callers on the approval path deliberately do not await it.
  publish(message) {
    if (!this.enabled) return Promise.resolve(false);

    let entry;
    try {
      entry = this.#entry(message);
    } catch (error) {
      this.#log("error", `notify: not sending an invalid notification (${describe(error)})`);
      return Promise.resolve(false);
    }

    return this.#attempt(entry);
  }

  // Drops the retry timer so a test or a shutdown does not keep the process alive.
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }

  #entry(message) {
    const title = clamp(message.title, MAX_TITLE);
    if (!title) throw new Error("a notification needs a title");

    const payload = {
      area: message.area ?? "media",
      severity: message.severity ?? "info",
      title,
    };

    const body = clamp(message.body, MAX_BODY);
    if (body) payload.body = body;

    const detail = clamp(message.detail, MAX_DETAIL);
    if (detail) payload.detail = detail;

    if (this.host) payload.host = this.host;

    // `state` only means something with a condition key, and the gateway rejects it without one.
    if (message.key) {
      payload.key = message.key;
      payload.state = message.state ?? "firing";
    }

    return {
      title,
      idempotencyKey: String(message.idempotencyKey ?? randomUUID()).slice(0, 128),
      body: JSON.stringify(payload),
      attempts: 0,
      nextAt: 0,
    };
  }

  async #attempt(entry) {
    entry.attempts += 1;

    let response;
    try {
      response = await this.fetch(`${this.url}${NOTIFY_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "Idempotency-Key": entry.idempotencyKey,
        },
        body: entry.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.#log("warn", `notify: "${entry.title}" did not reach the gateway (${describe(error)})`);
      this.#enqueue(entry);
      return false;
    }

    if (response.status >= 200 && response.status < 300) return true;

    if (isRetryableStatus(response.status)) {
      this.#log("warn", `notify: the gateway answered ${response.status} for "${entry.title}"`);
      this.#enqueue(entry);
      return false;
    }

    this.#log("error", `notify: the gateway refused "${entry.title}" with ${response.status}, dropping it`);
    return false;
  }

  #enqueue(entry) {
    if (entry.attempts >= this.maxAttempts) {
      this.#log("error", `notify: giving up on "${entry.title}" after ${entry.attempts} attempts`);
      return;
    }

    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (entry.attempts - 1));
    entry.nextAt = Date.now() + delay;

    while (this.queue.length >= this.maxQueue) {
      const dropped = this.queue.shift();
      this.#log("error", `notify: retry queue full at ${this.maxQueue}, dropped "${dropped.title}"`);
    }

    this.queue.push(entry);
    this.#schedule();
  }

  #schedule() {
    if (this.timer || this.draining || this.queue.length === 0) return;

    const due = Math.min(...this.queue.map((entry) => entry.nextAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#drain();
    }, Math.max(0, due - Date.now()));

    // A pending retry must not hold a shutdown open.
    this.timer.unref?.();
  }

  async #drain() {
    if (this.draining) return;
    this.draining = true;

    try {
      const now = Date.now();
      const due = this.queue.filter((entry) => entry.nextAt <= now);
      this.queue = this.queue.filter((entry) => entry.nextAt > now);

      for (const entry of due) {
        await this.#attempt(entry);
      }
    } finally {
      this.draining = false;
    }

    this.#schedule();
  }

  #log(level, text) {
    const line = this.#redact(text);
    if (level === "error") this.logger.error(line);
    else if (level === "warn") this.logger.warn(line);
    else this.logger.log(line);
  }

  #redact(text) {
    let out = String(text);
    if (this.token) out = out.split(this.token).join("<redacted>");
    return out.replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
  }
}
