#!/usr/bin/env node
// cdp-cookies.mjs — export a domain's cookies from a scope's live logged-in Chrome into a
// Netscape jar the Python side (yt-dlp, http.cookiejar) reads.
//
//   node skills/lib/cdp-cookies.mjs <scope> <domain> [--out <path>]
//
// JavaScript because BUILD-7 fixed CDP-over-Node as the cockpit's browser mechanism: Node
// >=22 ships a WebSocket client, so GET /json/version plus a socket to the browser target is
// the whole dependency list, and Python has no stdlib WebSocket. Zero npm, no Playwright.
//
// This replaces the hand export through a browser extension: the scope's lane is already
// logged in, so the session is right here and never has to be moved by hand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Scope -> CDP port. provision/browser-lane.sh's scope_port() is the source of truth;
// it is a bash case statement with no importable form, so the map is duplicated here.
// Adding a scope means editing both.
const PORTS = { personal: 9222, studio: 9223 };

const COOKIE_DIR = process.env.COCKPIT_COOKIES_DIR || path.join(os.homedir(), ".config", "cockpit", "cookies");

function die(msg) {
  console.error(`cdp-cookies: ${msg}`);
  process.exit(1);
}

// ---------- CDP ----------
async function browserSocket(port) {
  let version;
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch (e) {
    die(`no browser lane on port ${port} (${e.message}). Start it: provision/browser-lane.sh <scope>`);
  }
  const url = version.webSocketDebuggerUrl;
  if (!url) die(`port ${port} answered /json/version without a webSocketDebuggerUrl`);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket refused")), { once: true });
  });
  return ws;
}

function call(ws, method) {
  // Storage.getCookies on the browser-level target returns every cookie in the profile,
  // so no page target and no navigation are needed.
  const id = 1;
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method }));
  });
}

// ---------- Netscape jar ----------
// A cookie's domain C is relevant to a requested site D when C is D itself, a subdomain of
// D (so a jar exported for linkedin.com also carries www.linkedin.com's cookies), or a
// parent of D (a dot-prefixed cookie means "include subdomains", so .linkedin.com covers
// www.linkedin.com). The dot boundary on both endsWith checks is load-bearing: without it
// evil-linkedin.com or linkedin.com.attacker.net would match linkedin.com by bare suffix.
export function matches(cookieDomain, domain) {
  const c = cookieDomain.toLowerCase().replace(/^\./, "");
  const d = domain.toLowerCase();
  return c === d || c.endsWith(`.${d}`) || d.endsWith(`.${c}`);
}

function netscape(cookies) {
  // Field order and TRUE/FALSE casing are what make the file readable by both yt-dlp and
  // Python's http.cookiejar; a jar only one of them parses is a failed export.
  // A leading-dot domain is the wire form of "include subdomains", so that flag mirrors it.
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Written by cockpit cdp-cookies.mjs. Account credentials: never commit, never print.",
  ];
  for (const c of cookies) {
    const includeSub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    // A session cookie has no expiry on the wire; 0 is the format's way of saying so.
    const expires = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
    lines.push([c.domain, includeSub, c.path || "/", secure, expires, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

// ---------- main ----------
// Guarded so test-cdp-cookies.mjs can `import { matches } from "./cdp-cookies.mjs"`
// without triggering a live CDP connection.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

async function main() {

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
let out = null;
if (outIdx !== -1) {
  out = argv[outIdx + 1];
  if (!out) die("--out needs a path");
  argv.splice(outIdx, 2);
}
const [scope, domain] = argv;
if (!scope || !domain) die("usage: cdp-cookies.mjs <scope> <domain> [--out <path>]");
if (argv.length > 2) die("cookie values are never arguments; only <scope> and <domain> are accepted");

const port = PORTS[scope];
if (!port) die(`no CDP port for scope '${scope}' (known: ${Object.keys(PORTS).join(", ")}); add it here and in provision/browser-lane.sh`);

const ws = await browserSocket(port);
const { cookies } = await call(ws, "Storage.getCookies");
ws.close();

const wanted = cookies.filter((c) => matches(c.domain, domain));
if (wanted.length === 0) {
  // An empty jar is worse than no jar: the caller's next fetch would go out
  // uncredentialed and read as the site refusing us.
  die(`no cookies for '${domain}' in the ${scope} lane. Log in to it in that browser first.`);
}

const target = out || path.join(COOKIE_DIR, `${domain}.txt`);
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  // Never destroy a working session with a bad export.
  fs.renameSync(target, `${target}.bak`);
  console.log(`moved existing jar aside: ${path.basename(target)}.bak`);
}
fs.writeFileSync(target, netscape(wanted), { mode: 0o600 });
fs.chmodSync(target, 0o600);

console.log(`port: ${port} | domain: ${domain} | wrote: ${wanted.length} cookies -> ${target}`);
console.log(`names: ${wanted.map((c) => c.name).join(", ")}`);

// The per-domain breakdown is the only way to see a partial export: a jar that looks fine
// in count and names can still be missing the one subdomain that carries the session
// cookie. Domains and counts only, never a value.
const byDomain = new Map();
for (const c of wanted) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
const breakdown = [...byDomain.entries()].map(([d, n]) => `${d} (${n})`).join(", ");
console.log(`domains: ${breakdown}`);
}
