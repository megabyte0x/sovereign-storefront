import type {
  ExceptionRecord,
  Invoice,
  InvoiceSettlement,
  Observation,
  PaymentState,
  Policy,
  ScanHealth,
} from './types.ts';

function parseZat(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('amountZat must be an unsigned decimal integer string');
  }
  return BigInt(value);
}

function latestByOutputId(receipts: Observation[]): Observation[] {
  const byId = new Map<string, Observation>();
  for (const receipt of receipts) {
    const previous = byId.get(receipt.outputId);
    if (!previous || receipt.revision.height >= previous.revision.height) {
      byId.set(receipt.outputId, receipt);
    }
  }
  return [...byId.values()];
}

function exception(
  invoice: Invoice,
  code: ExceptionRecord['code'],
  now: number,
  detail: string,
): ExceptionRecord {
  return {
    id: `${invoice.orderId}:${code}:${detail}`,
    orderId: invoice.orderId,
    code,
    createdAt: now,
    detail,
  };
}

function healthAllowsRelease(
  health: ScanHealth,
  policy: Policy,
  now: number,
  receipt: Observation,
): boolean {
  if (!health.healthy || !health.caughtUp) return false;
  if (now - health.checkedAt > policy.maxHealthAgeMs) return false;
  if (health.revision.height < receipt.revision.height) return false;
  return true;
}

export function reduceInvoice(
  invoice: Invoice,
  receipts: Observation[],
  health: ScanHealth,
  policy: Policy,
  now: number,
): InvoiceSettlement {
  const exceptions: ExceptionRecord[] = [];
  const unique = latestByOutputId(receipts);
  const matched = unique.filter((receipt) => receipt.invoiceId === invoice.id);
  const unmatched = unique.filter(
    (receipt) => receipt.invoiceId !== invoice.id,
  );

  for (const receipt of unmatched) {
    exceptions.push(
      exception(invoice, 'unmatched', now, receipt.outputId),
    );
  }

  const expected = parseZat(invoice.amountZat);
  const sufficient: Observation[] = [];
  for (const receipt of matched) {
    if (receipt.receivedAt > invoice.expiresAt) {
      exceptions.push(exception(invoice, 'late', now, receipt.outputId));
      continue;
    }
    const amount = parseZat(receipt.amountZat);
    if (amount < expected) {
      exceptions.push(exception(invoice, 'underpayment', now, receipt.outputId));
      continue;
    }
    if (amount > expected) {
      exceptions.push(exception(invoice, 'overpayment', now, receipt.outputId));
    }
    sufficient.push(receipt);
  }

  const canonicalSufficient = sufficient.filter((receipt) => receipt.canonical);
  const confirmed = canonicalSufficient.filter(
    (receipt) =>
      receipt.confirmations >= policy.minConfirmations &&
      healthAllowsRelease(health, policy, now, receipt),
  );

  if (confirmed.length > 1) {
    for (const extra of confirmed.slice(1)) {
      exceptions.push(exception(invoice, 'duplicate', now, extra.outputId));
    }
  }

  const backing = confirmed[0] ?? null;
  let payment: PaymentState = 'awaiting';
  let releaseEligible = false;
  const backingOutputIds: string[] = [];

  if (backing) {
    payment = 'confirmed';
    releaseEligible = true;
    backingOutputIds.push(backing.outputId);
  } else {
    const reorged = sufficient.some(
      (receipt) => !receipt.canonical,
    ) && canonicalSufficient.length === 0;
    if (reorged) {
      payment = 'reorged';
    } else if (matched.some((receipt) => receipt.canonical && receipt.confirmations > 0)) {
      payment = 'confirming';
    } else if (matched.length > 0) {
      payment = 'detected';
    } else if (unmatched.length > 0 || exceptions.length > 0) {
      payment = 'review_required';
    }
  }

  return { payment, releaseEligible, backingOutputIds, exceptions };
}
