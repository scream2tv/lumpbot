const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CHARSET.length; i++) m[CHARSET[i]] = i;
  return m;
})();

const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod(hrpExpand(hrp).concat(data)) === 1;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((mod >>> (5 * (5 - i))) & 31);
  return ret;
}

function convertBits(data: number[] | Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const v of Array.from(data)) {
    if (v < 0 || v >> fromBits !== 0) return null;
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

export interface DecodedBech32 {
  hrp: string;
  words: number[];
  bytes: Uint8Array;
}

/** Decodes a bech32 string (no bech32m support — all Cardano addresses are bech32). */
export function bech32Decode(input: string, limit = 200): DecodedBech32 | null {
  if (input.length < 8 || input.length > limit) return null;
  const lower = input.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const dataPart = lower.slice(pos + 1);
  const data: number[] = [];
  for (const c of dataPart) {
    const v = CHARSET_MAP[c];
    if (v === undefined) return null;
    data.push(v);
  }
  if (!verifyChecksum(hrp, data)) return null;
  const words = data.slice(0, data.length - 6);
  const bytes = convertBits(words, 5, 8, false);
  if (!bytes) return null;
  return { hrp, words, bytes: new Uint8Array(bytes) };
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words = convertBits(bytes, 8, 5, true);
  if (!words) throw new Error('bech32Encode: convertBits failed');
  const combined = words.concat(createChecksum(hrp, words));
  let out = hrp + '1';
  for (const w of combined) out += CHARSET[w];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hexToBytes: odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
