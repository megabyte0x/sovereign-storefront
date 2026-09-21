function isDecryptedSignedMessage(candidate) {
  return Boolean(
    candidate &&
      typeof candidate.verifySignature === "function" &&
      typeof candidate.version === "number" &&
      candidate.version >= 1 &&
      candidate.payload instanceof Uint8Array
  );
}

function decodeApplicationJson(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

/**
 * Accept only a decrypted, seller-authenticated application response.
 * Light Push delivery acks and unencrypted version-0 payloads are rejected.
 */
export function acceptApplicationResponse(candidate, expectedSellerPublicKey) {
  if (!isDecryptedSignedMessage(candidate)) {
    return {
      ok: false,
      reason: "not a decrypted application response"
    };
  }

  if (!expectedSellerPublicKey || !candidate.verifySignature(expectedSellerPublicKey)) {
    return {
      ok: false,
      reason: "seller identity mismatch"
    };
  }

  const body = decodeApplicationJson(candidate.payload);
  if (!body || body.type !== "order-response") {
    return {
      ok: false,
      reason: "not a decrypted application response"
    };
  }

  return { ok: true, payload: body };
}
