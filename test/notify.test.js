import assert from "node:assert/strict";
import test from "node:test";

import NotifyClient from "../src/notify.js";

const TOKEN = "test-token-never-logged";

function capture() {
  const lines = [];
  const sink = (...args) => lines.push(args.join(" "));
  return { lines, logger: { log: sink, warn: sink, error: sink } };
}

function client(options = {}) {
  return new NotifyClient({
    url: "http://gateway.test:9160",
    token: TOKEN,
    baseDelayMs: 50,
    maxDelayMs: 50,
    ...options,
  });
}

test("a publish carries the bearer token, the idempotency key and a JSON body", async () => {
  const calls = [];
  const notify = client({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 202 };
    },
  });

  const ok = await notify.publish({
    area: "media",
    severity: "info",
    title: "Seerr request approved: Example",
    body: "Request 1 by someone",
    idempotencyKey: "approverr:request:1",
  });
  notify.stop();

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test:9160/v1/notify");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["Idempotency-Key"], "approverr:request:1");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.area, "media");
  assert.equal(payload.severity, "info");
  assert.equal(payload.title, "Seerr request approved: Example");
  assert.equal(payload.body, "Request 1 by someone");
  assert.equal(payload.key, undefined);
  assert.equal(payload.state, undefined);
});

test("a condition key carries a state, and detail is capped", async () => {
  const calls = [];
  const notify = client({ fetch: async (url, init) => (calls.push(init), { status: 202 }) });

  await notify.publish({
    severity: "warn",
    title: "approverr poll loop failing",
    detail: "x".repeat(5000),
    key: "approverr:error",
    state: "firing",
  });
  notify.stop();

  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.key, "approverr:error");
  assert.equal(payload.state, "firing");
  assert.equal(payload.detail.length, 2000);
});

test("no configuration means no notifications and no throw", async () => {
  const notify = new NotifyClient({ env: {}, fetch: async () => assert.fail("must not call the gateway") });

  assert.equal(notify.enabled, false);
  assert.equal(await notify.publish({ title: "anything" }), false);
  notify.stop();
});

test("a timeout does not block the caller and the message is queued for retry", async () => {
  const notify = client({
    timeoutMs: 20,
    // A fetch that never settles until its abort signal fires, which is what a dead gateway looks like.
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  });

  const started = Date.now();
  const pending = notify.publish({ title: "Seerr request approved: Example" });
  const returnedAfter = Date.now() - started;

  assert.ok(returnedAfter < 10, `publish() returned in ${returnedAfter} ms without awaiting the gateway`);
  assert.equal(await pending, false);
  assert.equal(notify.queueLength, 1);
  notify.stop();
});

test("a refused message is dropped rather than retried", async () => {
  const { lines, logger } = capture();
  const notify = client({ logger, fetch: async () => ({ status: 401 }) });

  assert.equal(await notify.publish({ title: "Seerr request approved: Example" }), false);
  assert.equal(notify.queueLength, 0);
  assert.ok(lines.some((line) => line.includes("401")));
  notify.stop();
});

test("the retry queue is bounded and drops the oldest first", async () => {
  const { lines, logger } = capture();
  const notify = client({ logger, maxQueue: 3, fetch: async () => ({ status: 503 }) });

  for (let i = 1; i <= 5; i++) {
    await notify.publish({ title: `message ${i}` });
  }

  assert.equal(notify.queueLength, 3);
  assert.deepEqual(
    notify.queue.map((entry) => entry.title),
    ["message 3", "message 4", "message 5"],
  );
  assert.ok(lines.some((line) => line.includes('dropped "message 1"')));
  assert.ok(lines.some((line) => line.includes('dropped "message 2"')));
  notify.stop();
});

test("a queued message is retried and leaves the queue once it lands", async () => {
  let attempts = 0;
  const notify = client({
    fetch: async () => {
      attempts += 1;
      return { status: attempts === 1 ? 503 : 202 };
    },
  });

  await notify.publish({ title: "Seerr request approved: Example" });
  assert.equal(notify.queueLength, 1);

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(attempts, 2);
  assert.equal(notify.queueLength, 0);
  notify.stop();
});

test("a message that keeps failing is given up on rather than retried forever", async () => {
  const { lines, logger } = capture();
  const notify = client({ logger, maxAttempts: 2, fetch: async () => ({ status: 503 }) });

  await notify.publish({ title: "Seerr request approved: Example" });
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(notify.queueLength, 0);
  assert.ok(lines.some((line) => line.includes("giving up")));
  notify.stop();
});

test("the token never reaches a log line", async () => {
  const { lines, logger } = capture();
  const notify = client({
    logger,
    fetch: async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${TOKEN}`);
    },
  });

  await notify.publish({ title: "Seerr request approved: Example" });
  notify.stop();

  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(!line.includes(TOKEN), `a log line leaked the token: ${line}`);
  }
  assert.ok(lines.some((line) => line.includes("<redacted>")));
});
