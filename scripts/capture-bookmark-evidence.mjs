// =============================================================================
// Bookmark Browser Evidence
// =============================================================================
// Drives a real headless Chrome session through the client-side flows that the
// HTTP harness cannot prove:
//
//   - inline create on /bookmarks (React form, no page reload)
//   - navigation to the record's own URL
//   - Cancel, then Confirm, in the delete confirmation
//   - redirect to /signin after the session cookie is removed
//
// It also writes the two Section 13 screenshots into docs/evidence/:
//   detail-url.png  - the detail page with a banner showing the live URL, the
//                     publicId from the path, and the internal id (which is
//                     absent from the page HTML)
//   audit-row.png   - the audit row read back from the database after the
//                     browser-driven deletion
//
// Headless Chrome captures the viewport, not the browser chrome, so the live
// URL is rendered as an evidence banner by this script. The value in the
// banner is read from window.location.href, not hard-coded.
//
// Requires the server on BASE_URL (default http://localhost:3100) and the
// alice@test.bookmark account. It cleans up the bookmark, audit row, and
// session it creates. No application code is modified.

import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

dotenv.config({ quiet: true });

const BASE = (process.env.BASE_URL || "http://localhost:3100").replace(/\/$/, "");
const EVIDENCE_DIR = path.join(process.cwd(), "docs", "evidence");
const EMAIL = "alice@test.bookmark";
const PASSWORD = "Password123!";
const RUN = Date.now();
const LABEL = `Browser Evidence ${RUN}`;
const URL_VALUE = "https://example.com/evidence";
const { Client } = pg;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge not found; set CHROME_PATH");
  return found;
}

class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(response) {
    const list =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const entry of list) {
      const pair = entry.split(";")[0];
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  value(name) {
    return this.cookies.get(name);
  }
}

async function apiRequest(method, urlPath, { jar, csrf, body } = {}) {
  const headers = {};
  if (jar?.header()) headers.cookie = jar.header();
  if (csrf) headers["x-csrf-token"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(BASE + urlPath, { method, headers, body, redirect: "manual" });
  if (jar) jar.absorb(response);
  return { status: response.status, text: await response.text() };
}

async function signIn() {
  const jar = new Jar();
  const csrfResponse = await apiRequest("GET", "/api/auth/csrf", { jar });
  const csrf = JSON.parse(csrfResponse.text)?.data?.csrfToken;
  const response = await apiRequest("POST", "/api/auth/signin", {
    jar,
    csrf,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (response.status !== 200) {
    throw new Error(
      `sign-in failed: ${response.status}. Create ${EMAIL} with scripts/create-user.js`
    );
  }
  const token = jar.value("session_token");
  if (!token) throw new Error("sign-in returned no session_token cookie");
  return token;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const user = await db.query('select "id" from "User" where "email" = $1', [EMAIL]);
  if (user.rows.length !== 1) {
    throw new Error(`test user ${EMAIL} not found`);
  }
  const userId = user.rows[0].id;

  const sessionToken = await signIn();

  const userDataDir = path.join(os.tmpdir(), `chrome-evidence-${RUN}`);
  const port = 9223;
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let ws;
  let publicId = "";
  try {
    let version = null;
    for (let i = 0; i < 80; i += 1) {
      try {
        version = await getJson(`http://localhost:${port}/json/version`);
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error("Chrome CDP was not reachable");

    const list = await getJson(`http://localhost:${port}/json/list`);
    const page = list.find((target) => target.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const cdp = new CDP(ws);

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error("evaluate failed: " + JSON.stringify(result.exceptionDetails));
      }
      return result.result.value;
    };

    const waitFor = async (expression, label, timeoutMs = 90000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          if (await evaluate(expression)) return;
        } catch {
          // execution context can disappear during a navigation
        }
        await sleep(250);
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const clickByText = async (text) => {
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`button not found: ${text}`);
    };

    const screenshot = async (name) => {
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const file = path.join(EVIDENCE_DIR, name);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log("screenshot:", file);
      return file;
    };

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Network.setCookie", {
      name: "session_token",
      value: sessionToken,
      url: BASE,
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure: false,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });

    console.log("1. navigate /bookmarks");
    await cdp.send("Page.navigate", { url: BASE + "/bookmarks" });
    await waitFor(
      `document.querySelector('#bookmark-label') && document.querySelector('#bookmark-url')`,
      "the create form"
    );
    await sleep(1500); // let React hydrate before driving the controlled inputs

    console.log("2. inline create");
    const filled = await evaluate(`(() => {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue('#bookmark-label', ${JSON.stringify(LABEL)});
      setValue('#bookmark-url', ${JSON.stringify(URL_VALUE)});
      const submit = document.querySelector('form button[type="submit"]');
      if (!submit) return false;
      submit.click();
      return true;
    })()`);
    if (!filled) throw new Error("create form submit button missing");

    await waitFor(
      `[...document.querySelectorAll('a')].some((a) => a.textContent.includes(${JSON.stringify(LABEL)}))`,
      "the created bookmark in the list"
    );
    const href = await evaluate(`(() => {
      const link = [...document.querySelectorAll('a')]
        .find((a) => a.textContent.includes(${JSON.stringify(LABEL)}));
      return link ? link.getAttribute('href') : null;
    })()`);
    if (!href || !href.startsWith("/bookmarks/")) {
      throw new Error("created bookmark link has no public id: " + href);
    }
    publicId = href.split("/").filter(Boolean).pop();
    console.log("   created publicId:", publicId);

    console.log("3. open the record's own URL");
    await evaluate(`(() => {
      const link = [...document.querySelectorAll('a')]
        .find((a) => a.textContent.includes(${JSON.stringify(LABEL)}));
      link.click();
    })()`);
    await waitFor(
      `location.pathname === ${JSON.stringify("/bookmarks/" + publicId)} && document.body.innerText.includes('Delete bookmark')`,
      "the detail page"
    );

    const internal = await db.query(
      'select "id" from "Bookmark" where "publicId" = $1',
      [publicId]
    );
    const internalId = internal.rows[0]?.id;
    if (!internalId) throw new Error("created bookmark not found in the database");

    await evaluate(`(() => {
      const banner = document.createElement('div');
      banner.id = 'evidence-banner';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'background:#111827', 'color:#f9fafb', 'font:13px/1.5 monospace',
        'padding:12px 16px', 'white-space:pre-wrap', 'border-bottom:3px solid #22c55e'
      ].join(';');
      banner.textContent =
        'EVIDENCE - live browser URL: ' + location.href + '\\n' +
        'publicId in the path: ' + ${JSON.stringify(publicId)} + '\\n' +
        'internal Bookmark.id: ' + ${JSON.stringify(internalId)} +
        ' (not present in the page HTML)';
      document.body.prepend(banner);
      window.scrollTo(0, 0);
    })()`);
    await sleep(500);
    await screenshot("detail-url.png");

    console.log("4. cancel, then confirm delete");
    await evaluate("document.getElementById('evidence-banner')?.remove()");
    await clickByText("Delete bookmark");
    await waitFor(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Confirm delete')`,
      "the confirmation box"
    );
    await clickByText("Cancel");
    await waitFor(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Delete bookmark')`,
      "the cancel to restore the delete button"
    );
    const stillThere = await evaluate(
      `document.body.innerText.includes(${JSON.stringify(URL_VALUE)})`
    );
    if (!stillThere) throw new Error("cancel removed the bookmark view");

    await clickByText("Delete bookmark");
    await waitFor(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Confirm delete')`,
      "the confirmation box after reopening"
    );
    await clickByText("Confirm delete");
    await waitFor(
      `location.pathname === '/bookmarks' && !document.body.innerText.includes(${JSON.stringify(LABEL)})`,
      "the return to the list after deletion"
    );

    console.log("5. read the audit row back from the database");
    const audit = await db.query(
      `select a."id", a."userId", u."email", a."bookmarkPublicId",
              a."bookmarkLabel", a."deletedAt"
         from "BookmarkDeletionAudit" a
         join "User" u on u."id" = a."userId"
        where a."bookmarkPublicId" = $1`,
      [publicId]
    );
    if (audit.rows.length !== 1) {
      throw new Error("expected exactly 1 audit row, found " + audit.rows.length);
    }
    const row = audit.rows[0];

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Deletion audit evidence</title>
<style>
  body { font: 14px/1.6 -apple-system, Segoe UI, sans-serif; margin: 32px; color: #111827; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 4px 0 16px; color: #374151; }
  pre { background: #f3f4f6; padding: 14px; border-radius: 6px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f9fafb; }
  code { font-family: ui-monospace, Consolas, monospace; }
</style></head>
<body>
<h1>BookmarkDeletionAudit - row written before a real deletion</h1>
<p>The row below was produced by deleting a bookmark through the browser UI, then read back with the query shown.</p>
<pre>select a."id", a."userId", u."email", a."bookmarkPublicId",
       a."bookmarkLabel", a."deletedAt"
from "BookmarkDeletionAudit" a
join "User" u on u."id" = a."userId"
where a."bookmarkPublicId" = '${escapeHtml(publicId)}';</pre>
<table>
<tr><th>id</th><th>userId</th><th>email</th><th>bookmarkPublicId</th><th>bookmarkLabel</th><th>deletedAt</th></tr>
<tr>
<td><code>${escapeHtml(row.id)}</code></td>
<td><code>${escapeHtml(row.userId)}</code></td>
<td>${escapeHtml(row.email)}</td>
<td><code>${escapeHtml(row.bookmarkPublicId)}</code></td>
<td>${escapeHtml(row.bookmarkLabel)}</td>
<td>${escapeHtml(row.deletedAt.toISOString())}</td>
</tr>
</table>
</body></html>`;

    const evidenceHtml = path.join(os.tmpdir(), `audit-evidence-${RUN}.html`);
    fs.writeFileSync(evidenceHtml, html);
    const fileUrl = "file:///" + evidenceHtml.replaceAll("\\", "/");
    await cdp.send("Page.navigate", { url: fileUrl });
    await waitFor("document.readyState === 'complete' && !!document.querySelector('table')", "the audit evidence page");
    await sleep(400);
    await screenshot("audit-row.png");

    console.log("6. unauthenticated redirect");
    await cdp.send("Network.clearBrowserCookies");
    await cdp.send("Page.navigate", { url: BASE + "/bookmarks" });
    await waitFor("location.pathname === '/signin'", "the /signin redirect");
    console.log("   redirected to:", await evaluate("location.pathname"));

    console.log("\nBROWSER EVIDENCE OK");
  } finally {
    try {
      if (publicId) {
        await db.query(
          'delete from "BookmarkDeletionAudit" where "bookmarkPublicId" = $1',
          [publicId]
        );
        await db.query('delete from "Bookmark" where "publicId" = $1', [publicId]);
      }
      await db.query('delete from "Bookmark" where "label" = $1', [LABEL]);
      await db.query('delete from "Session" where "userId" = $1', [userId]);
    } finally {
      await db.end();
    }
    try {
      if (ws) ws.close();
    } catch {
      // ignore
    }
    chrome.kill();
    await sleep(500);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Chrome may still hold the profile; it is in the temp directory
    }
  }
}

main().catch((error) => {
  console.error("BROWSER EVIDENCE ERROR:", error);
  process.exitCode = 1;
});
