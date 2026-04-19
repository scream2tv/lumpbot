// Cardano Policy IDs are the Blake2b-224 hash of the minting script, hex-encoded.
// That works out to exactly 56 hexadecimal characters.
export const POLICY_ID_REGEX = /\b[a-f0-9]{56}\b/gi;

// Asset fingerprints follow CIP-14 and start with `asset1` followed by bech32 chars.
export const ASSET_FINGERPRINT_REGEX = /\basset1[a-z0-9]{38}\b/gi;

export function extractPolicyIds(message: string): string[] {
  const matches = message.match(POLICY_ID_REGEX);
  if (!matches) return [];
  const unique = new Set(matches.map((m) => m.toLowerCase()));
  return Array.from(unique);
}

export function extractAssetFingerprints(message: string): string[] {
  const matches = message.match(ASSET_FINGERPRINT_REGEX);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

export function isValidPolicyId(value: string): boolean {
  return /^[a-f0-9]{56}$/i.test(value.trim());
}
