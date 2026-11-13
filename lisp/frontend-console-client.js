// Served by frontend-console-proxy.js and loaded as the first script in
// <head>. Forwards the page's console output and uncaught errors to the
// proxy, which prints them for Emacs's *frontend-console* buffer.
// Being first means it is installed before any page script runs, so it
// also catches errors thrown while the page loads.
(() => {
  if (window.__emacsConsole) return;
  window.__emacsConsole = true;

  const ENDPOINT = "/__emacs_console";
  const queue = [];
  let timer = null;

  // Turn one console argument into readable text. Errors keep their stack,
  // objects become JSON, with a fallback for cycles and host objects.
  function show(value) {
    if (value instanceof Error) return value.stack || String(value);
    if (typeof value === "string") return value;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value !== "object" || value === null) return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  // Entries are batched, so a console.log inside a render loop costs one
  // request per flush rather than one per frame.
  function send(level, args) {
    queue.push({ level, text: args.map(show).join(" ") });
    if (timer === null) timer = setTimeout(flush, 100);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (queue.length === 0) return;
    // sendBeacon is fire and forget and still delivers while the page
    // unloads, which matters because live reload tears pages down constantly.
    navigator.sendBeacon(ENDPOINT, JSON.stringify(queue.splice(0)));
  }

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      send(level, args);
    };
  }

  // Capture phase, so failed <script>/<link>/<img> loads are seen too.
  // Those fire on the element and carry no message, so name them by URL.
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      send("error", [`Failed to load ${target.src || target.href}`]);
      return;
    }
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    send("error", [event.error ?? `${event.message}${where}`]);
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    send("error", ["Unhandled promise rejection:", event.reason]);
  });

  window.addEventListener("pagehide", flush);

  send("page", [`loaded ${location.href}`]);
})();
