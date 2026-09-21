export const ROUTING_MARKERS = ["ORDER_MARK", "BUYER_MARK", "PRODUCT_MARK"];

export function probeContentTopic(runId) {
  return `/ssf-probe/1/${runId}/proto`;
}

function collectPublicStrings(envelope) {
  const values = [
    envelope.contentTopic,
    envelope.pubsubTopic,
    envelope.version,
    envelope.timestamp,
    envelope.ephemeral,
    envelope.meta,
    envelope.rateLimitProof
  ];
  return values.flatMap((value) => stringifyPublic(value));
}

function stringifyPublic(value) {
  if (value == null) {
    return [];
  }
  if (value instanceof Uint8Array) {
    return [new TextDecoder("utf-8", { fatal: false }).decode(value)];
  }
  if (typeof value === "object") {
    return [JSON.stringify(value)];
  }
  return [String(value)];
}

export function inspectPublicRouting(envelope) {
  const haystack = collectPublicStrings(envelope).join("\n");
  const found = ROUTING_MARKERS.filter((marker) => haystack.includes(marker));
  return { ok: found.length === 0, found };
}
