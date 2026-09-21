export function createSellerFulfillment({ expectedAuthorization } = {}) {
  const responsesByRequestId = new Map();
  const spentAuthorizations = new Set();
  let sequence = 0;

  return {
    handleRequest(request) {
      if (!request?.authorization || request.authorization !== expectedAuthorization) {
        return { ok: false, reason: "incorrect credentials" };
      }

      const existing = responsesByRequestId.get(request.requestId);
      if (existing) {
        return existing;
      }

      if (spentAuthorizations.has(request.authorization)) {
        return { ok: false, reason: "replayed authorization" };
      }

      spentAuthorizations.add(request.authorization);
      sequence += 1;
      const response = {
        ok: true,
        requestId: request.requestId,
        responseId: `resp-${sequence}`,
        logicalCount: 1
      };
      responsesByRequestId.set(request.requestId, response);
      return response;
    }
  };
}
