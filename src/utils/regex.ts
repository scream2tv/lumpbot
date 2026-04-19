// Cardano Policy IDs are the Blake2b-224 hash of the minting script, hex-encoded
// (exactly 56 hex chars). A full asset ID is the policy concatenated with up to
// 64 hex chars of asset name, so we match 56–120 and slice the policy portion.
export const POLICY_ID_REGEX = /\b[a-f0-9]{56}(?:[a-f0-9]{2}){0,32}\b/gi;

// Asset fingerprints follow CIP-14 and start with `asset1` followed by bech32 chars.
export const ASSET_FINGERPRINT_REGEX = /\basset1[a-z0-9]{38}\b/gi;

export function extractPolicyIds(message: string): string[] {
  const matches = message.match(POLICY_ID_REGEX);
  if (!matches) return [];
  const unique = new Set(matches.map((m) => m.slice(0, 56).toLowerCase()));
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
