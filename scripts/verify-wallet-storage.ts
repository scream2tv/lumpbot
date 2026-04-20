import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StorageService } from '../src/services/storage';

const dbPath = path.join(__dirname, 'tmp-wallet-watch.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const storage = new StorageService(dbPath);

const a = storage.addWalletWatch({
  userId: 'user1', stakeKey: 'stake1abc', displayAddress: 'addr1qxyz',
  isEnterprise: false, baselineTxHash: null,
});
assert.equal(a.discordUserId, 'user1');
assert.equal(a.stakeKey, 'stake1abc');

let threw = false;
try {
  storage.addWalletWatch({
    userId: 'user1', stakeKey: 'stake1abc', displayAddress: 'addr1qxyz',
    isEnterprise: false, baselineTxHash: null,
  });
} catch (err: any) {
  threw = true;
  assert.equal(err.code, 'SQLITE_CONSTRAINT_UNIQUE');
}
assert.equal(threw, true, 'expected UNIQUE violation');

storage.addWalletWatch({
  userId: 'user2', stakeKey: 'stake1abc', displayAddress: 'addr1qxyz',
  isEnterprise: false, baselineTxHash: null,
});

assert.equal(storage.countWalletWatches('user1'), 1);
assert.equal(storage.listWalletWatches('user2').length, 1);
assert.deepEqual(storage.distinctWatchedStakeKeys(), ['stake1abc']);
assert.equal(storage.getWatchesForStakeKey('stake1abc').length, 2);

storage.updateWatchAfterNotify(a.id, 'hash123', Date.now());
storage.setWatchDmCooldown(a.id, Date.now() + 3600_000);
const after = storage.listWalletWatches('user1')[0];
assert.equal(after.lastNotifiedTxHash, 'hash123');
assert.notEqual(after.dmDisabledUntil, null);

assert.equal(storage.removeWalletWatch('user1', 'stake1abc'), true);
assert.equal(storage.countWalletWatches('user1'), 0);
assert.equal(storage.removeWalletWatch('user1', 'stake1abc'), false);

storage.addWalletWatch({
  userId: 'user3', stakeKey: 'stake1def', displayAddress: 'addr1qdef',
  isEnterprise: false, baselineTxHash: null,
});
assert.equal(storage.removeWalletWatch('user3', 'addr1qdef'), true);

storage.recordWatchAction('user1', 'add');
storage.recordWatchAction('user1', 'add');
storage.recordWatchAction('user1', 'remove');
assert.equal(storage.countRecentWatchActions('user1', 'add', 60_000), 2);
assert.equal(storage.countRecentWatchActions('user1', 'remove', 60_000), 1);

storage.close();
fs.unlinkSync(dbPath);
console.log('wallet storage OK');
