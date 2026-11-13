// Usage: node frontend-console-proxy.js TARGET_URL
//
// A dev-only reverse proxy that Emacs puts in front of any dev server
// (see my/frontend-preview in config.org). It uses only Node built-ins, so
// projects need nothing installed.
//
//  - Every request is forwarded to TARGET_URL unchanged, except that HTML
//    responses get <script src="/__emacs_console.js"> right after <head>.
//  - That script POSTs the page's console output to /__emacs_console, and
//    the proxy prints each entry as "[level] text" on stdout, which Emacs
//    shows in *frontend-console*.
//  - WebSocket upgrades are piped through raw, so live reload and HMR
//    clients that connect back to the page's own origin keep working.
//  - Each line on stdin replaces the target, so Emacs can repoint the
//    proxy when the dev server restarts on a new port. The browser keeps
//    talking to the same proxy URL throughout.
//
// The first stdout line is "Proxy for TARGET at URL"; Emacs waits for it
// before opening the preview.

"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CLIENT_URL = "/__emacs_console.js";
const LOG_URL = "/__emacs_console";
const CLIENT_FILE = path.join(__dirname, "frontend-console-client.js");
const SCRIPT_TAG = `<script src="${CLIENT_URL}"></script>`;

let target = new URL(process.argv[2]);
let origin = null; // the proxy's own origin, known once it listens

function log(level, text) {
  for (const line of String(text).split("\n")) {
    process.stdout.write(`[${level}] ${line}\n`);
  }
}

// Requests must look as if the browser had sent them to the dev server
// directly: some servers (Vite, Next.js) reject unknown Host or Origin
// values, and redirects should name the server's origin.
function upstreamHeaders(headers) {
  const out = { ...headers, host: target.host };
  if (out.origin === origin) out.origin = target.origin;
  if (out.referer && out.referer.startsWith(origin)) {
    out.referer = target.origin + out.referer.slice(origin.length);
  }
  return out;
}

// Insert the script as the first thing in <head>. Without a <head> tag it
// goes after the doctype, never before it, since anything ahead of the
// doctype drops the page into quirks mode.
function inject(html) {
  const anchor = /<head(\s[^>]*)?>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
  if (!anchor) return SCRIPT_TAG + html;
  const at = anchor.index + anchor[0].length;
  return html.slice(0, at) + SCRIPT_TAG + html.slice(at);
}

function serveClient(res) {
  fs.readFile(CLIENT_FILE, (err, js) => {
    if (err) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(js);
  });
}

function receiveLogs(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 1 << 20) req.destroy(); // a runaway page should not eat memory
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const entries = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      for (const { level, text } of entries) {
        log(String(level).replace(/[^a-z]/g, "") || "log", text);
      }
    } catch {
      // A malformed beacon is not worth reporting.
    }
    res.writeHead(204).end();
  });
}

function forward(req, res) {
  const secure = target.protocol === "https:";
  const headers = upstreamHeaders(req.headers);
  // Ask for an uncompressed body, so HTML arrives as text we can edit.
  // Over loopback compression buys nothing anyway.
  headers["accept-encoding"] = "identity";

  const upstream = (secure ? https : http).request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      rejectUnauthorized: false, // dev servers use self signed certificates
    },
    (upRes) => {
      const out = { ...upRes.headers };
      if (out.location && out.location.startsWith(target.origin)) {
        out.location = origin + out.location.slice(target.origin.length);
      }
      const isHtml =
        /^text\/html/i.test(out["content-type"] || "") &&
        req.method !== "HEAD" &&
        upRes.statusCode !== 204 &&
        upRes.statusCode !== 304;

      if (!isHtml) {
        res.writeHead(upRes.statusCode, upRes.statusMessage, out);
        upRes.pipe(res);
        return;
      }
      // HTML is buffered whole, because the injection changes its length.
      const chunks = [];
      upRes.on("data", (chunk) => chunks.push(chunk));
      upRes.on("end", () => {
        const body = Buffer.from(inject(Buffer.concat(chunks).toString("utf8")));
        delete out["transfer-encoding"];
        out["content-length"] = body.length;
        res.writeHead(upRes.statusCode, upRes.statusMessage, out);
        res.end(body);
      });
    },
  );

  upstream.on("error", (err) => {
    // Connecting to "localhost" tries IPv6 and IPv4, and when both fail
    // Node raises an AggregateError whose message is empty but whose code
    // (ECONNREFUSED and the like) says what happened.
    const reason = err.message || err.code || String(err);
    log("proxy", `${req.method} ${req.url} failed: ${reason}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Could not reach ${target.origin}: ${reason}\n`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === CLIENT_URL) serveClient(res);
  else if (req.method === "POST" && req.url === LOG_URL) receiveLogs(req, res);
  else forward(req, res);
});

// A WebSocket starts as an HTTP request asking to upgrade. Node hands us
// the raw socket, so we replay that request to the dev server over a new
// connection and then splice the two sockets together byte for byte.
server.on("upgrade", (req, socket, head) => {
  const secure = target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: false })
    : net.connect(port, target.hostname);

  upstream.once(secure ? "secureConnect" : "connect", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [name, value] of Object.entries(upstreamHeaders(req.headers))) {
      for (const v of [].concat(value)) raw += `${name}: ${v}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  for (const s of [upstream, socket]) {
    s.on("error", close);
    s.on("close", close);
  }
});

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    try {
      target = new URL(line.trim());
      log("proxy", `now forwarding to ${target.origin}`);
    } catch {
      log("proxy", `ignoring invalid target: ${line}`);
    }
  })
  // stdin closes when Emacs goes away, so never outlive it.
  .on("close", () => process.exit(0));

server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`Proxy for ${target.origin} at ${origin}\n`);
});
