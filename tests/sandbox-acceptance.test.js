'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, requiredCapabilityKeys } = require('../src/services/sandbox-acceptance-service');

test('APY-only company requires only APY stay, 11.4 credit and cancellation verification', () => {
  assert.deepEqual(requiredCapabilityKeys({ listingTypes: ['11.2'] }), [
    CAPABILITIES.STAY_APY, CAPABILITIES.CREDIT_APY, CAPABILITIES.CANCEL,
  ]);
});

test('TPY-only company requires only TPY stay, 5.1 credit and cancellation verification', () => {
  assert.deepEqual(requiredCapabilityKeys({ listingTypes: ['2.1'] }), [
    CAPABILITIES.STAY_TPY, CAPABILITIES.CREDIT_TPY, CAPABILITIES.CANCEL,
  ]);
});

test('mixed defaults, rules and overrides require both primary and matching credit families', () => {
  assert.deepEqual(requiredCapabilityKeys({
    listingTypes: ['11.2'], ruleTypes: ['2.1'], overrideTypes: ['11.2'],
  }), [
    CAPABILITIES.STAY_TPY, CAPABILITIES.CREDIT_TPY,
    CAPABILITIES.STAY_APY, CAPABILITIES.CREDIT_APY,
    CAPABILITIES.CANCEL,
  ]);
});

test('queued credit or old creditable original keeps only its matching family required', () => {
  assert.deepEqual(requiredCapabilityKeys({ documentTypes: ['5.1'] }), [
    CAPABILITIES.STAY_TPY, CAPABILITIES.CREDIT_TPY, CAPABILITIES.CANCEL,
  ]);
  assert.deepEqual(requiredCapabilityKeys({ creditableProductionTypes: ['11.2'] }), [
    CAPABILITIES.STAY_APY, CAPABILITIES.CREDIT_APY, CAPABILITIES.CANCEL,
  ]);
});
