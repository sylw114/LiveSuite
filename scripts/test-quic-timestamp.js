const assert = require('assert');
const { wrapFlvTimestamp } = require('../tscdist/main/quicPull');

const modulus = 0x1_0000_0000;
assert.strictEqual(wrapFlvTimestamp(0), 0);
assert.strictEqual(wrapFlvTimestamp(modulus - 1), modulus - 1);
assert.strictEqual(wrapFlvTimestamp(modulus), 0);
assert.strictEqual(wrapFlvTimestamp(modulus + 1234), 1234);
assert.strictEqual(wrapFlvTimestamp(modulus * 2 + 77), 77);
console.log('QUIC/FLV timestamp wrap tests passed');
