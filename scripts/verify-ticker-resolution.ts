import assert from 'node:assert/strict';
import { WalletWatchService } from '../src/services/walletWatchService';

// Stubs — only the methods resolveTicker actually calls.
const snekMiss = {
  getAssetMeta: async () => null,
};

const snekHit = {
  getAssetMeta: async () => ({ ticker: 'LUMP', logoCid: 'bafkLUMP' }),
};

const dhHit = {
  getStatsByPolicyId: async (_policy: string) => ({
    policyId: 'abc123',
    unit: 'abc123deadbeef',
    ticker: 'MOO',
    name: 'Moo Cow',
    priceAda: 0.5,
    priceChange24hPct: null,
    volume24hAda: 1000,
    liquidityAda: 2000,
    pairs: [],
  }),
};

const dhMiss = { getStatsByPolicyId: async () => null };

const dummyStorage: any = {};
const dummyClient: any = {};

async function run(): Promise<void> {
  // Case 1: Snek hit → use Snek ticker + logo.
  {
    const svc = new WalletWatchService(
      dummyStorage,
      {} as any,
      snekHit as any,
      dhHit as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    const result = await (svc as any).resolveTicker('abc123deadbeef');
    assert.equal(result.ticker, 'LUMP');
    assert.equal(result.logoCid, 'bafkLUMP');
    assert.equal(result.dhUnit, null);
  }

  // Case 2: Snek miss + DH hit with matching unit → use DH ticker, no logo.
  {
    const svc = new WalletWatchService(
      dummyStorage,
      {} as any,
      snekMiss as any,
      dhHit as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    const result = await (svc as any).resolveTicker('abc123deadbeef');
    assert.equal(result.ticker, 'MOO');
    assert.equal(result.logoCid, null);
    assert.equal(result.dhUnit, 'abc123deadbeef');
  }

  // Case 3: Snek miss + DH hit with NON-matching unit → fall through to hex decode.
  {
    const dhWrongUnit = {
      getStatsByPolicyId: async () => ({
        policyId: 'abc123',
        unit: 'abc123cafebabe',   // different from queried unit
        ticker: 'WRONG',
        name: 'Wrong Token',
        priceAda: 0, priceChange24hPct: null, volume24hAda: 0, liquidityAda: 0, pairs: [],
      }),
    };
    const svc = new WalletWatchService(
      dummyStorage,
      {} as any,
      snekMiss as any,
      dhWrongUnit as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    // unit: policy='abc123deadbeef' length <56, so splitCardanoUnit returns full as policy, '' as name — we need a realistic unit.
    // Use a proper 56-char policy + hex name.
    const POLICY = 'a'.repeat(56);
    const NAME_HEX = '4d4f4f'; // "MOO" in hex — printable
    const UNIT = POLICY + NAME_HEX;
    const dhWithOtherUnit = {
      getStatsByPolicyId: async () => ({
        policyId: POLICY,
        unit: POLICY + '5a5a5a', // different name
        ticker: 'WRONG',
        name: 'Wrong Token',
        priceAda: 0, priceChange24hPct: null, volume24hAda: 0, liquidityAda: 0, pairs: [],
      }),
    };
    const svc2 = new WalletWatchService(
      dummyStorage,
      {} as any,
      snekMiss as any,
      dhWithOtherUnit as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    const result = await (svc2 as any).resolveTicker(UNIT);
    assert.equal(result.ticker, 'MOO', 'should hex-decode when DH unit mismatches');
  }

  // Case 4: Everything misses → NFT fallback.
  // Use a policy-only unit (no asset name hex) so hexToUtf8Safe returns '' and
  // the empty-string check fails, triggering the NFT fallback.
  {
    const POLICY = 'b'.repeat(56);
    const UNIT = POLICY; // no asset name suffix → assetNameHex = ''
    const svc = new WalletWatchService(
      dummyStorage,
      {} as any,
      snekMiss as any,
      dhMiss as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    const result = await (svc as any).resolveTicker(UNIT);
    assert.ok(result.ticker.startsWith('NFT '), `expected NFT fallback, got ${result.ticker}`);
  }

  // Case 5: Snek throws → treated as miss; DH hit used.
  {
    const snekThrow = {
      getAssetMeta: async () => { throw new Error('snek flaky'); },
    };
    const svc = new WalletWatchService(
      dummyStorage,
      {} as any,
      snekThrow as any,
      dhHit as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    const result = await (svc as any).resolveTicker('abc123deadbeef');
    assert.equal(result.ticker, 'MOO');
  }

  // Case 6: Cache hit → second call with same unit doesn't re-invoke snek/dh.
  {
    let snekCalls = 0;
    let dhCalls = 0;
    const countingSnek = { getAssetMeta: async () => { snekCalls++; return { ticker: 'CACHE', logoCid: null }; } };
    const countingDh = { getStatsByPolicyId: async () => { dhCalls++; return null; } };
    const svc = new WalletWatchService(
      dummyStorage,
      {} as any,
      countingSnek as any,
      countingDh as any,
      dummyClient,
      'https://cardanoscan.io',
    );
    await (svc as any).resolveTicker('abc123deadbeef');
    await (svc as any).resolveTicker('abc123deadbeef');
    assert.equal(snekCalls, 1, 'snek should only be called once due to cache');
    assert.equal(dhCalls, 0, 'dh should not be called when snek hits');
  }

  console.log('ticker resolution OK');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
