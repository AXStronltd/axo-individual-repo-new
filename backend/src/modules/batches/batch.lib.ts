// Pure helpers for bulk payments — no DB, fully unit-testable.

export interface Recipient {
  recipient: string;
  destination: string;
  amountMinor: bigint;
}

export interface ValidationResult {
  valid: Recipient[];
  errors: { line: number; reason: string }[];
  duplicates: { destination: string; count: number }[];
}

/**
 * Parse a CSV of recipients. Expected columns: recipient,destination,amountMinor
 * A header row is detected and skipped. Amounts are strings so no float enters.
 */
export function parseRecipientCsv(csv: string): { rows: (Partial<Recipient> & { line: number })[]; } {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: (Partial<Recipient> & { line: number })[] = [];
  lines.forEach((line, i) => {
    const cols = line.split(',').map((c) => c.trim());
    // skip a header row
    if (i === 0 && /recipient/i.test(cols[0] ?? '')) return;
    const [recipient, destination, amount] = cols;
    let amountMinor: bigint | undefined;
    try {
      amountMinor = amount !== undefined && amount !== '' ? BigInt(amount) : undefined;
    } catch {
      amountMinor = undefined;
    }
    rows.push({ line: i + 1, recipient, destination, amountMinor });
  });
  return { rows };
}

/** Validate recipients: required fields, positive amounts; flag duplicate destinations. */
export function validateRecipients(rows: (Partial<Recipient> & { line: number })[]): ValidationResult {
  const valid: Recipient[] = [];
  const errors: { line: number; reason: string }[] = [];
  const destCount = new Map<string, number>();

  for (const r of rows) {
    if (!r.recipient) {
      errors.push({ line: r.line, reason: 'missing recipient' });
      continue;
    }
    if (!r.destination) {
      errors.push({ line: r.line, reason: 'missing destination' });
      continue;
    }
    if (r.amountMinor === undefined || r.amountMinor <= 0n) {
      errors.push({ line: r.line, reason: 'invalid amount' });
      continue;
    }
    destCount.set(r.destination, (destCount.get(r.destination) ?? 0) + 1);
    valid.push({ recipient: r.recipient, destination: r.destination, amountMinor: r.amountMinor });
  }

  const duplicates = [...destCount.entries()]
    .filter(([, c]) => c > 1)
    .map(([destination, count]) => ({ destination, count }));

  return { valid, errors, duplicates };
}

/** Sum a batch's valid recipients. */
export function batchTotalMinor(recipients: Recipient[]): bigint {
  return recipients.reduce((s, r) => s + r.amountMinor, 0n);
}
