import assert from 'node:assert/strict';
import { classifyTx, groupMoves } from '../src/services/walletWatchService';

const mine = new Set(['addr1qmine']);

// Fixture: the exact shape from the user's screenshot — two SELF txs in the same block.
// Tx A: −0.178173 ADA, no native assets (router fee).
// Tx B: −11.10 ADA, +482,598 LUMP (the actual snek.fun swap).
const txA = classifyTx(
  {
    hash: 'hashA',
    inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '2000000' }] }],
    outputs: [
      { address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '178173' }] },
      { address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '1821827' }] },
    ],
  },
  mine,
);
txA.blockTime = 1000;

const LUMP = '73797786382c0832b5787a5b306f5308488f14571b7061f79396ad2c4c756d70';
const txB = classifyTx(
  {
    hash: 'hashB',
    inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '15000000' }] }],
    outputs: [
      { address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '11100000' }] },
      { address: 'addr1qmine',  amount: [
        { unit: 'lovelace', quantity: '3900000' },
        { unit: LUMP, quantity: '482598' },
      ] },
    ],
  },
  mine,
);
txB.blockTime = 1000;

const groups = groupMoves([txA, txB]);
assert.equal(groups.length, 1, 'expected one merged group');
const g = groups[0];
assert.equal(g.direction, 'SELF');
assert.equal(g.txHashes.length, 2);
assert.equal(g.primaryTxHash, 'hashB', 'primary should be the tx with asset delta');
assert.equal(g.lovelaceDelta, -11278173n);
assert.equal(g.assetDeltas.length, 1);
assert.equal(g.assetDeltas[0].unit, LUMP);
assert.equal(g.assetDeltas[0].quantity, 482598n);

// Negative case: two pure-ADA SELF txs → stay separate.
const pureA = classifyTx(
  {
    hash: 'pureA',
    inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
    outputs: [
      { address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '2000000' }] },
      { address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '2800000' }] },
    ],
  },
  mine,
);
pureA.blockTime = 2000;
const pureB = classifyTx(
  {
    hash: 'pureB',
    inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '3000000' }] }],
    outputs: [
      { address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '1000000' }] },
      { address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '1800000' }] },
    ],
  },
  mine,
);
pureB.blockTime = 2000;

const sepGroups = groupMoves([pureA, pureB]);
assert.equal(sepGroups.length, 2, 'pure-ADA SELF pair should not merge (swap heuristic)');

// Negative case: same direction but > 3 seconds apart → separate.
const apartA = { ...txA, txHash: 'apartA', blockTime: 3000 };
const apartB = { ...txB, txHash: 'apartB', blockTime: 3010 };
const apartGroups = groupMoves([apartA as any, apartB as any]);
assert.equal(apartGroups.length, 2, '>3 second gap should not merge');

// Negative case: different directions → separate.
const dirA = { ...txA, direction: 'OUT' as const, txHash: 'dirA', blockTime: 4000 };
const dirB = { ...txB, direction: 'SELF' as const, txHash: 'dirB', blockTime: 4000 };
const dirGroups = groupMoves([dirA as any, dirB as any]);
assert.equal(dirGroups.length, 2, 'different directions should not merge');

console.log('grouping OK');
