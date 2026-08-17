#!/usr/bin/env node
// cdp-fetch — render one URL in the scope's live logged-in Chrome and print its text.
//
//   node skills/lib/cdp-fetch.mjs <scope> <url>
//
// Mechanism is the one BUILD-7 fixed: GET http://127.0.0.1:<port>/json for a page target,
// then a WebSocket to it using Node's built-in client. Zero dependencies, no Playwright.
//
// This attaches to the human's real session. It never starts Chrome:
// provision/browser-lane.sh owns that, and a read must never launch a browser as a side
// effect. A lane that is not running is an error here, not something to fix silently.
//
// Nothing from the session is logged: no cookies, no tokens, and no query strings, since a
// query string can carry a token. Errors name the host and path only.

// Source of truth for the map is provision/browser-lane.sh's scope_port(); this mirrors
// it. Add a scope there first, then here.
const PORTS = { personal: 9222, studio: 9223 };

const LOAD_TIMEOUT_MS = 45000;
const SETTLE_MS = 1500; // after load, client-rendered pages need a beat before innerText

function die(msg) {
  process.stderr.write(`cdp-fetch: ${msg}\n`);
  process.exit(1);
}

function safeUrl(url) {
  // Query strings can carry tokens, so only origin plus path is ever printed.
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "(unparseable url)";
  }
}

const [scope, url] = process.argv.slice(2);
if (!scope || !url) die("usage: cdp-fetch.mjs <scope> <url>");
if (!/^https?:\/\//.test(url)) die("url must be http(s)");
const port = PORTS[scope];
if (!port) die(`no port assigned for scope '${scope}' (add one to provision/browser-lane.sh, then here)`);

async function pageTargetWs() {
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    list = await res.json();
  } catch {
    die(`browser lane for scope '${scope}' is not running on port ${port}. Start it with: provision/browser-lane.sh ${scope}`);
  }
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) die(`no page target on port ${port}: the lane is up but has no open tab`);
  return page.webSocketDebuggerUrl;
}

// One connection, one id counter, promises resolved by id. Events are dispatched to
// whatever handler is waiting on that method name.
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (this.events.has(msg.method)) {
        this.events.get(msg.method)(msg.params);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    this.ws.send(JSON.stringify(frame));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method) {
    return new Promise((resolve) => this.events.set(method, resolve));
  }
}

function open(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const ws = await open(await pageTargetWs());
  const cdp = new Cdp(ws);
  let targetId = null;
  try {
    // A new tab rather than navigating the human's current one, so a read never takes
    // over a page they were using.
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    await cdp.send("Page.enable", {}, sessionId);
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url }, sessionId);

    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      loaded,
      sleep(LOAD_TIMEOUT_MS).then(() => timedOut),
    ]);
    if (outcome === timedOut) {
      // An error, never a silent empty string: a caller cannot tell an empty page from a
      // page that never loaded.
      throw new Error(`page did not fire load within ${LOAD_TIMEOUT_MS}ms: ${safeUrl(url)}`);
    }
    await sleep(SETTLE_MS);

    const res = await cdp.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    }, sessionId);
    const text = (res.result && res.result.value) || "";
    if (!text.trim()) throw new Error(`page rendered no text: ${safeUrl(url)}`);
    process.stdout.write(text);
  } finally {
    // Always close, so a failure never leaves tabs accumulating in the human's session.
    if (targetId) {
      try {
        await cdp.send("Target.closeTarget", { targetId });
      } catch {
        // Nothing useful to do: the tab is either gone or the connection is.
      }
    }
    ws.close();
  }
}

main().catch((e) => die(e.message));
