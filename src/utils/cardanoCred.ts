import { bech32Decode, bech32Encode, bytesToHex, hexToBytes } from './bech32';

export type AddressKind = 'base' | 'pointer' | 'enterprise' | 'reward';
export type CredentialKind = 'key' | 'script';
export type CardanoNetwork = 'mainnet' | 'testnet';

export interface ParsedCardanoAddress {
  raw: string;
  kind: AddressKind;
  network: CardanoNetwork;
  paymentCredHex: string | null;
  paymentCredKind: CredentialKind | null;
  stakeCredHex: string | null;
  stakeCredKind: CredentialKind | null;
}

const NETWORK_MAINNET = 1;

function networkOfByte(b: number): CardanoNetwork {
  return (b & 0x0f) === NETWORK_MAINNET ? 'mainnet' : 'testnet';
}

/**
 * Parses a Cardano bech32 address per CIP-19 and extracts its payment/stake
 * credentials. Returns null for junk or unsupported HRPs.
 */
export function parseCardanoAddress(input: string): ParsedCardanoAddress | null {
  if (!input) return null;
  const decoded = bech32Decode(input.trim().toLowerCase());
  if (!decoded) return null;
  const { hrp, bytes } = decoded;

  const isStakeHrp = hrp === 'stake' || hrp === 'stake_test';
  const isAddrHrp = hrp === 'addr' || hrp === 'addr_test';
  if (!isStakeHrp && !isAddrHrp) return null;
  if (bytes.length < 1) return null;

  const header = bytes[0];
  const type = header >> 4;
  const network = networkOfByte(header);

  const slice = (from: number, to: number) =>
    bytesToHex(bytes.slice(from, to));

  let parsed: Omit<ParsedCardanoAddress, 'raw' | 'network'> | null = null;

  switch (type) {
    case 0:
      if (bytes.length !== 57) return null;
      parsed = {
        kind: 'base',
        paymentCredHex: slice(1, 29),
        paymentCredKind: 'key',
        stakeCredHex: slice(29, 57),
        stakeCredKind: 'key',
      };
      break;
    case 1:
      if (bytes.length !== 57) return null;
      parsed = {
        kind: 'base',
        paymentCredHex: slice(1, 29),
        paymentCredKind: 'script',
        stakeCredHex: slice(29, 57),
        stakeCredKind: 'key',
      };
      break;
    case 2:
      if (bytes.length !== 57) return null;
      parsed = {
        kind: 'base',
        paymentCredHex: slice(1, 29),
        paymentCredKind: 'key',
        stakeCredHex: slice(29, 57),
        stakeCredKind: 'script',
      };
      break;
    case 3:
      if (bytes.length !== 57) return null;
      parsed = {
        kind: 'base',
        paymentCredHex: slice(1, 29),
        paymentCredKind: 'script',
        stakeCredHex: slice(29, 57),
        stakeCredKind: 'script',
      };
      break;
    case 4:
    case 5:
      parsed = {
        kind: 'pointer',
        paymentCredHex: slice(1, 29),
        paymentCredKind: type === 4 ? 'key' : 'script',
        stakeCredHex: null,
        stakeCredKind: null,
      };
      break;
    case 6:
      if (bytes.length !== 29) return null;
      parsed = {
        kind: 'enterprise',
        paymentCredHex: slice(1, 29),
        paymentCredKind: 'key',
        stakeCredHex: null,
        stakeCredKind: null,
      };
      break;
    case 7:
      if (bytes.length !== 29) return null;
      parsed = {
        kind: 'enterprise',
        paymentCredHex: slice(1, 29),
        paymentCredKind: 'script',
        stakeCredHex: null,
        stakeCredKind: null,
      };
      break;
    case 14:
      if (bytes.length !== 29) return null;
      parsed = {
        kind: 'reward',
        paymentCredHex: null,
        paymentCredKind: null,
        stakeCredHex: slice(1, 29),
        stakeCredKind: 'key',
      };
      break;
    case 15:
      if (bytes.length !== 29) return null;
      parsed = {
        kind: 'reward',
        paymentCredHex: null,
        paymentCredKind: null,
        stakeCredHex: slice(1, 29),
        stakeCredKind: 'script',
      };
      break;
    default:
      return null;
  }

  return { raw: input.trim().toLowerCase(), network, ...parsed };
}

/**
 * Given a payment (base or enterprise) address, returns the bech32 stake
 * address for its stake credential — or null for enterprise/pointer addresses
 * that have none.
 */
export function deriveStakeAddress(addr: ParsedCardanoAddress): string | null {
  if (!addr.stakeCredHex || !addr.stakeCredKind) return null;
  const network = addr.network === 'mainnet' ? 1 : 0;
  const typeNibble = addr.stakeCredKind === 'script' ? 0xf0 : 0xe0;
  const header = typeNibble | network;
  const hex = addr.stakeCredHex;
  const full = new Uint8Array(1 + hex.length / 2);
  full[0] = header;
  full.set(hexToBytes(hex), 1);
  const hrp = addr.network === 'mainnet' ? 'stake' : 'stake_test';
  return bech32Encode(hrp, full);
}

/** Returns the 28-byte stake credential (hex) of a bech32 stake address. */
export function stakeAddressToCredHex(stakeAddr: string): string | null {
  const parsed = parseCardanoAddress(stakeAddr);
  if (!parsed || parsed.kind !== 'reward') return null;
  return parsed.stakeCredHex;
}

/** Truncates a bech32 address for display. */
export function shortenAddress(bech32: string): string {
  if (bech32.length <= 18) return bech32;
  return `${bech32.slice(0, 10)}…${bech32.slice(-6)}`;
}

/**
 * Splits a Cardano asset unit into its policy/asset-name halves.
 * Handles both `{policyId}.{hex}` and `{policyId}{hex}` forms.
 */
export function splitCardanoUnit(unit: string): { policyId: string; assetNameHex: string } {
  const dot = unit.indexOf('.');
  if (dot >= 0) return { policyId: unit.slice(0, dot), assetNameHex: unit.slice(dot + 1) };
  if (unit.length >= 56) return { policyId: unit.slice(0, 56), assetNameHex: unit.slice(56) };
  return { policyId: unit, assetNameHex: '' };
}
