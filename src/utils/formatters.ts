const LOVELACE_PER_ADA = 1_000_000n;

export function lovelaceToAda(lovelace: bigint | string | number): number {
  const value = typeof lovelace === 'bigint' ? lovelace : BigInt(lovelace);
  const whole = value / LOVELACE_PER_ADA;
  const fraction = value % LOVELACE_PER_ADA;
  return Number(whole) + Number(fraction) / Number(LOVELACE_PER_ADA);
}

export function formatAda(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  if (value === 0) return '0 ₳';
  if (Math.abs(value) < 0.0001) return `${value.toExponential(2)} ₳`;

  const digits = value < 1 ? 6 : fractionDigits;
  return `${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₳`;
}

export function formatNumber(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return value.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

export function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function hexToUtf8Safe(hex: string): string {
  try {
    const buf = Buffer.from(hex, 'hex');
    const decoded = buf.toString('utf8');
    if (/^[\x20-\x7E]*$/.test(decoded) && decoded.trim().length > 0) {
      return decoded;
    }
    return hex;
  } catch {
    return hex;
  }
}

export function formatDateIso(input: string | number | Date | null | undefined): string {
  if (!input) return 'N/A';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toISOString().replace('T', ' ').replace(/\..+/, ' UTC');
}
