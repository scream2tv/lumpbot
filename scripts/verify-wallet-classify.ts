import assert from 'node:assert/strict';
import { classifyTx } from '../src/services/walletWatchService';

const mine = new Set(['addr1qmine']);

const out = classifyTx({
  hash: 'h1',
  inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
  outputs: [{ address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '4500000' }] }],
}, mine);
assert.equal(out.direction, 'OUT');
assert.equal(out.lovelaceDelta, -5000000n);

const inc = classifyTx({
  hash: 'h2',
  inputs: [{ address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '3000000' }] }],
  outputs: [{ address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '3000000' }] }],
}, mine);
assert.equal(inc.direction, 'IN');
assert.equal(inc.lovelaceDelta, 3000000n);

const self = classifyTx({
  hash: 'h3',
  inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '10000000' }] }],
  outputs: [
    { address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '4000000' }] },
    { address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '5800000' }] },
  ],
}, mine);
assert.equal(self.direction, 'SELF');
assert.equal(self.lovelaceDelta, -4200000n);

const tok = classifyTx({
  hash: 'h4',
  inputs: [{ address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '2000000' }] }],
  outputs: [{
    address: 'addr1qmine',
    amount: [
      { unit: 'lovelace', quantity: '2000000' },
      { unit: 'abc123.534e454b', quantity: '1000000' },
    ],
  }],
}, mine);
assert.equal(tok.direction, 'IN');
assert.equal(tok.assetDeltas.length, 1);
assert.equal(tok.assetDeltas[0].unit, 'abc123.534e454b');
assert.equal(tok.assetDeltas[0].quantity, 1000000n);

console.log('classifyTx OK');
