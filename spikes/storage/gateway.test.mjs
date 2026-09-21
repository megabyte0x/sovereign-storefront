import assert from "node:assert/strict";
import https from "node:https";
import { test } from "node:test";
import { startGateway } from "./gateway.mjs";

function request(baseUrl, path) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: base.hostname,
          port: base.port,
          path,
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              arrayBuffer: async () =>
                body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
            });
          });
        },
      )
      .on("error", reject);
  });
}

test("gateway rejects filename and path abuse without serving files", async (t) => {
  const { url, close } = await startGateway({
    objects: new Map([["good-id", Buffer.from("SSF1ciphertext")]]),
    host: "127.0.0.1",
  });
  t.after(close);

  const abuses = [
    "/ciphertext/../good-id",
    "/ciphertext/%2e%2e/good-id",
    "/ciphertext/good-id/../../etc/passwd",
    "/ciphertext/foo/bar",
    "/ciphertext/good-id%2f..%2fsecret",
    "/etc/passwd",
    "/ciphertext/./good-id",
  ];
  for (const path of abuses) {
    const res = await request(url, path);
    assert.equal(res.status, 400, path);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.includes(Buffer.from("SSF1ciphertext")), false, path);
  }
});

test("gateway rejects unknown identifiers", async (t) => {
  const { url, close } = await startGateway({
    objects: new Map([["good-id", Buffer.from("SSF1ciphertext")]]),
    host: "127.0.0.1",
  });
  t.after(close);

  const res = await request(url, "/ciphertext/unknown-id");
  assert.equal(res.status, 404);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.includes(Buffer.from("SSF1ciphertext")), false);
});

test("gateway serves only the registered ciphertext for a valid id", async (t) => {
  const payload = Buffer.from("SSF1ciphertext");
  const { url, close } = await startGateway({
    objects: new Map([["good-id", payload]]),
    host: "127.0.0.1",
  });
  t.after(close);

  const res = await request(url, "/ciphertext/good-id");
  assert.equal(res.status, 200);
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, payload);
});
