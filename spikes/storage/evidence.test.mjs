import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateProbeStatus,
  listenPortFromInit,
  requireOriginalNodeStopped,
} from "./evidence.mjs";

const fixtureRun = {
  label: "fixture",
  plaintextBytes: 41,
  ciphertextBytes: 73,
  originUploadAccepted: true,
  independentReplicaAfterStop: true,
  browserDecrypt: true,
};

test("requireOriginalNodeStopped fails the probe when storageStop did not complete", () => {
  assert.throws(
    () => requireOriginalNodeStopped(false),
    (err) => {
      assert.match(String(err.message), /storageStop failed or timed out/);
      return true;
    },
  );
});

test("requireOriginalNodeStopped allows continuation only after a successful stop", () => {
  assert.doesNotThrow(() => requireOriginalNodeStopped(true));
});

test("evaluateProbeStatus is partial with pass false when only the 73-byte path was proven", () => {
  const out = evaluateProbeStatus({
    originalNodeStopped: true,
    replicaDigestMatchAfterStop: true,
    browserMatchesFixture: true,
    localAesGcmMaxPlaintextBytes: 8 * 1024 * 1024,
    sizeRuns: [fixtureRun],
  });
  assert.equal(out.pass, false);
  assert.equal(out.status, "partial");
  assert.equal(out.provenMaxBytes, 73);
  assert.equal(out.firstReleaseMaxBytes, 73);
  assert.equal(out.sizeNotes.independentRetrievalAndBrowserProvenBytes, 73);
  assert.equal("largerOriginUploadsAcceptedBytes" in out.sizeNotes, false);
  assert.deepEqual(out.sizeNotes.exercisedCiphertextBytes, [73]);
});

test("evaluateProbeStatus cannot pass when originalNodeStopped is false", () => {
  const out = evaluateProbeStatus({
    originalNodeStopped: false,
    replicaDigestMatchAfterStop: true,
    browserMatchesFixture: true,
    localAesGcmMaxPlaintextBytes: 8 * 1024 * 1024,
    sizeRuns: [fixtureRun],
  });
  assert.equal(out.pass, false);
  assert.notEqual(out.status, "pass");
});

test("evaluateProbeStatus does not treat origin-only larger uploads as proven replica sizes", () => {
  const out = evaluateProbeStatus({
    originalNodeStopped: true,
    replicaDigestMatchAfterStop: true,
    browserMatchesFixture: true,
    localAesGcmMaxPlaintextBytes: 8 * 1024 * 1024,
    sizeRuns: [
      fixtureRun,
      {
        label: "4KiB",
        plaintextBytes: 4096,
        ciphertextBytes: 4128,
        originUploadAccepted: true,
        independentReplicaAfterStop: false,
        browserDecrypt: false,
      },
    ],
  });
  assert.equal(out.pass, false);
  assert.equal(out.status, "partial");
  assert.equal(out.provenMaxBytes, 73);
  assert.deepEqual(out.sizeNotes.largerOriginUploadsAcceptedBytes, [4128]);
});

test("evaluateProbeStatus pass is true only when a larger replica retrieve after origin stop is proven", () => {
  const out = evaluateProbeStatus({
    originalNodeStopped: true,
    replicaDigestMatchAfterStop: true,
    browserMatchesFixture: true,
    localAesGcmMaxPlaintextBytes: 8 * 1024 * 1024,
    sizeRuns: [
      fixtureRun,
      {
        label: "4KiB",
        plaintextBytes: 4096,
        ciphertextBytes: 4128,
        originUploadAccepted: true,
        independentReplicaAfterStop: true,
        browserDecrypt: true,
      },
    ],
  });
  assert.equal(out.pass, true);
  assert.equal(out.status, "pass");
  assert.equal(out.provenMaxBytes, 4128);
  assert.equal(out.firstReleaseMaxBytes, 4128);
});

test("listenPortFromInit reads listen-port from init JSON and does not default to 18091", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssf-init-"));
  try {
    const initPath = path.join(dir, "storage-init.json");
    writeFileSync(initPath, JSON.stringify({ "listen-port": 19001, "data-dir": "/tmp/x" }));
    assert.equal(listenPortFromInit(initPath), 19001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listenPortFromInit throws when listen-port is missing rather than inventing a port", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssf-init-"));
  try {
    const initPath = path.join(dir, "storage-init.json");
    writeFileSync(initPath, JSON.stringify({ "data-dir": "/tmp/x" }));
    assert.throws(() => listenPortFromInit(initPath), /listen-port/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed storage.json does not claim pass without progressive sizes", () => {
  const jsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results", "storage.json");
  const json = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(json.pass, false);
  assert.equal(json.status, "partial");
  assert.equal(json.provenMaxBytes, 73);
  assert.equal(json.firstReleaseMaxBytes, 73);
  assert.equal("largerOriginUploadsAcceptedBytes" in (json.sizeNotes ?? {}), false);
  assert.equal(json.nodes.a.listenPortSource, "storage-init.json");
  assert.equal(json.nodes.b.listenPortSource, "storage-init.json");
});
