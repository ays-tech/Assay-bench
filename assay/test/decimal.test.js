import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimal, tryParseDecimal, formatDecimal, decimalPlaces, resolutionOf, ratio, scaleBy, toNumber, ONE } from '../src/decimal.js';

test('parses plain, signed, leading-dot and exponent forms exactly', () => {
  assert.equal(parseDecimal('12.34'), 12340000000000000000n);
  assert.equal(parseDecimal('-0.5'), -500000000000000000n);
  assert.equal(parseDecimal('.5'), 500000000000000000n);
  assert.equal(parseDecimal('1.5e-7'), 150000000000n);
  assert.equal(parseDecimal(0.0000005), 500000000000n);
  assert.equal(parseDecimal('3'), 3n * ONE);
});

test('rejects garbage instead of guessing', () => {
  for (const bad of ['', '.', 'abc', '1.2.3', '1e999', null, undefined, {}, NaN, Infinity]) {
    assert.equal(tryParseDecimal(bad), null, `should reject ${String(bad)}`);
  }
  assert.throws(() => parseDecimal('nope'), TypeError);
});

test('has no floating-point drift on sums that break IEEE doubles', () => {
  const sum = parseDecimal('0.1') + parseDecimal('0.2');
  assert.equal(sum, parseDecimal('0.3'));
  assert.notEqual(0.1 + 0.2, 0.3); // the failure mode this module exists to avoid
});

test('formats with round-half-up and fixed places', () => {
  assert.equal(formatDecimal(parseDecimal('0.0142'), 6), '0.014200');
  assert.equal(formatDecimal(parseDecimal('1.2345675'), 6), '1.234568');
  assert.equal(formatDecimal(parseDecimal('-2.5'), 0), '-3');
  assert.equal(formatDecimal(0n, 2), '0.00');
});

test('detects balance precision from strings', () => {
  assert.equal(decimalPlaces('12.3400'), 4);
  assert.equal(decimalPlaces('12'), 0);
  assert.equal(decimalPlaces(null), 0);
  assert.equal(resolutionOf(['1.25', '3.123456']), parseDecimal('0.000001'));
  assert.equal(resolutionOf([null, '10']), parseDecimal('1'));
});

test('ratio, scaleBy and toNumber behave', () => {
  assert.equal(ratio(parseDecimal('3'), parseDecimal('2')), 1.5);
  assert.equal(ratio(1n, 0n), null);
  assert.equal(scaleBy(parseDecimal('100'), 0.02), parseDecimal('2'));
  assert.equal(toNumber(parseDecimal('0.25')), 0.25);
});
