export type CardanoNetwork = 'mainnet' | 'testnet';
export type AddressKind = 'payment' | 'stake';

export interface ParsedAddress {
  raw: string;
  kind: AddressKind;
  network: CardanoNetwork;
}

const BECH32_CHARSET = /^[ac-hj-np-z02-9]+$/;

/**
 * Minimal bech32 prefix + charset validation for Cardano addresses.
 * We do not verify the checksum — Blockfrost will reject junk on the
 * first API call during /watch add, which is a sufficient gate.
 */
export function parseCardanoAddress(input: string): ParsedAddress | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  const sepIdx = trimmed.lastIndexOf('1');
  if (sepIdx < 1) return null;

  const hrp = trimmed.slice(0, sepIdx);
  const data = trimmed.slice(sepIdx + 1);
  if (data.length < 6 || !BECH32_CHARSET.test(data)) return null;

  let kind: AddressKind;
  let network: CardanoNetwork;
  if (hrp === 'addr') { kind = 'payment'; network = 'mainnet'; }
  else if (hrp === 'addr_test') { kind = 'payment'; network = 'testnet'; }
  else if (hrp === 'stake') { kind = 'stake'; network = 'mainnet'; }
  else if (hrp === 'stake_test') { kind = 'stake'; network = 'testnet'; }
  else return null;

  return { raw: trimmed, kind, network };
}

export function shortenAddress(bech32: string): string {
  if (bech32.length <= 18) return bech32;
  return `${bech32.slice(0, 10)}…${bech32.slice(-6)}`;
}

/**
 * Splits a Blockfrost/Cardano asset unit into its constituent parts.
 * Blockfrost uses both dotted format (`{policyId}.{assetNameHex}`) and
 * contiguous format (`{policyId}{assetNameHex}` — 56 hex chars for policy ID).
 */
export function splitCardanoUnit(unit: string): { policyId: string; assetNameHex: string } {
  const dot = unit.indexOf('.');
  if (dot >= 0) return { policyId: unit.slice(0, dot), assetNameHex: unit.slice(dot + 1) };
  if (unit.length >= 56) return { policyId: unit.slice(0, 56), assetNameHex: unit.slice(56) };
  return { policyId: unit, assetNameHex: '' };
}
