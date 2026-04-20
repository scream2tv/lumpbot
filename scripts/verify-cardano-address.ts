import assert from 'node:assert/strict';
import { parseCardanoAddress, shortenAddress } from '../src/utils/cardanoAddress';

const mp = parseCardanoAddress('addr1qy0acdefghjklmnpqrstuvwxyz023456789acdefghjklmnpqrs');
assert.equal(mp?.kind, 'payment');
assert.equal(mp?.network, 'mainnet');

const ms = parseCardanoAddress('stake1u9acdefghjklmnpqrstuvwxyz023456789acdefghjklmnpqrs');
assert.equal(ms?.kind, 'stake');
assert.equal(ms?.network, 'mainnet');

const tp = parseCardanoAddress('addr_test1qp0acdefghjklmnpqrstuvwxyz023456');
assert.equal(tp?.kind, 'payment');
assert.equal(tp?.network, 'testnet');

const ts = parseCardanoAddress('stake_test1u9acdefghjklmnpqrstuvwxyz023456789acdefghjklmnpqrs');
assert.equal(ts?.kind, 'stake');
assert.equal(ts?.network, 'testnet');

assert.equal(parseCardanoAddress('xyz1abc'), null);
assert.equal(parseCardanoAddress('noseparator'), null);
assert.equal(parseCardanoAddress('addr1Babc'), null);
assert.equal(parseCardanoAddress(''), null);

assert.equal(shortenAddress('addr1qy0223456789longaddressstring987654zzz'), 'addr1qy022…654zzz');
assert.equal(shortenAddress('short'), 'short');

console.log('cardanoAddress OK');
