import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(HERE, "roundtrip.html"));
const JS = readFileSync(path.join(HERE, "runtime/roundtrip.js"));

export function serveRoundtrip(port) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/roundtrip.js")) {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      res.end(JS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(HTML);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export async function chromiumRoundtrip({ peers, count, contentTopic, peerTimeoutMs, recvTimeoutMs, port }) {
  const server = await serveRoundtrip(port);
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") logs.push(`console: ${msg.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/roundtrip.html`, { waitUntil: "load", timeout: 30_000 });
    await page.waitForFunction(() => typeof window.runRoundtrip === "function", null, { timeout: 15_000 });
    const result = await page.evaluate(
      async (req) => window.runRoundtrip(req),
      { peers, count, contentTopic, peerTimeoutMs, recvTimeoutMs },
    );
    return { result, logs };
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = JSON.parse(process.argv[2]);
  const out = await chromiumRoundtrip(spec);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
