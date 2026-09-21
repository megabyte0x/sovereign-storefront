import { readFileSync } from "node:fs";

export function requireOriginalNodeStopped(originalNodeStopped) {
  if (originalNodeStopped !== true) {
    throw new Error("storageStop failed or timed out; refusing afterOriginalStopped");
  }
}

export function listenPortFromInit(initPath) {
  const cfg = JSON.parse(readFileSync(initPath, "utf8"));
  const port = cfg["listen-port"];
  if (!Number.isInteger(port)) {
    throw new Error(`missing listen-port in ${initPath}`);
  }
  return port;
}

export function evaluateProbeStatus({
  originalNodeStopped,
  replicaDigestMatchAfterStop,
  browserMatchesFixture,
  localAesGcmMaxPlaintextBytes,
  sizeRuns = [],
}) {
  const provenRuns = sizeRuns.filter(
    (run) =>
      run.originUploadAccepted &&
      run.independentReplicaAfterStop &&
      run.browserDecrypt,
  );
  const provenBytes = provenRuns.map((run) => run.ciphertextBytes);
  const provenMaxBytes = provenBytes.length ? Math.max(...provenBytes) : 0;
  const smallestProven = provenBytes.length ? Math.min(...provenBytes) : 0;
  const progressiveProven = provenRuns.length >= 2 && provenMaxBytes > smallestProven;

  const originOnlyLarger = sizeRuns
    .filter(
      (run) =>
        run.originUploadAccepted &&
        !run.independentReplicaAfterStop &&
        run.ciphertextBytes > provenMaxBytes,
    )
    .map((run) => run.ciphertextBytes);

  const pass = Boolean(
    originalNodeStopped &&
      replicaDigestMatchAfterStop &&
      browserMatchesFixture &&
      progressiveProven,
  );

  const sizeNotes = {
    independentRetrievalAndBrowserProvenBytes: provenMaxBytes,
    localAesGcmMaxPlaintextBytes,
    streaming: false,
    exercisedCiphertextBytes: sizeRuns.map((run) => run.ciphertextBytes),
  };
  if (originOnlyLarger.length) {
    sizeNotes.largerOriginUploadsAcceptedBytes = originOnlyLarger;
  }

  return {
    pass,
    status: pass ? "pass" : "partial",
    provenMaxBytes,
    firstReleaseMaxBytes: provenMaxBytes,
    sizeNotes,
  };
}
