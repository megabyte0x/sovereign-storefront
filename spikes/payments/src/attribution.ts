import type { Invoice, Observation } from './types.ts';

export type DecryptedOutput = {
  outputId: string;
  amountZat: string;
  confirmations: number;
  canonical: boolean;
  receivedAt: number;
  revision: Observation['revision'];
  memoText: string | null;
};

function memoMatches(memoText: string | null, attributionRef: string): boolean {
  if (memoText === null) return false;
  const trimmed = memoText.replace(/\0+$/g, '');
  return trimmed === attributionRef;
}

/** Match by random memo attributionRef only. Never by amount. */
export function attributeOutput(
  output: DecryptedOutput,
  invoices: Invoice[],
): Observation {
  const matches = invoices.filter((invoice) =>
    memoMatches(output.memoText, invoice.attributionRef),
  );
  return {
    outputId: output.outputId,
    invoiceId: matches.length === 1 ? matches[0].id : null,
    amountZat: output.amountZat,
    confirmations: output.confirmations,
    canonical: output.canonical,
    receivedAt: output.receivedAt,
    revision: output.revision,
  };
}

export function claimOutput(
  claimed: Map<string, string>,
  outputId: string,
  invoiceId: string,
): boolean {
  const existing = claimed.get(outputId);
  if (existing === undefined) {
    claimed.set(outputId, invoiceId);
    return true;
  }
  return existing === invoiceId;
}
