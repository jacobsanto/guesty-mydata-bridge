'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { automaticCancellationState, processAutomaticCancellationWork } = require('../src/services/automatic-cancellation-service');

test('automatic Guesty cancellation classifies ready, late-MARK, ambiguous and settled states fail-closed', () => {
  assert.equal(automaticCancellationState({
    document_type: '11.2', status: 'sent', mydata_mark: '4001', cancellation_status: 'requested',
  }), 'ready');
  assert.equal(automaticCancellationState({
    document_type: '8.2', status: 'transmitting', mydata_mark: null, cancellation_status: 'requested',
  }), 'awaiting_mark');
  assert.equal(automaticCancellationState({
    document_type: '2.1', status: 'failed', mydata_mark: null, cancellation_status: 'requested', transmission_uncertain: true,
  }), 'ambiguous');
  assert.equal(automaticCancellationState({
    document_type: '8.2', status: 'cancelled', mydata_mark: '4002', cancellation_status: 'cancelled', cancellation_verification_status: 'verified',
  }), 'settled');
  assert.equal(automaticCancellationState({
    document_type: '5.1', status: 'sent', mydata_mark: '4003', cancellation_status: 'requested',
  }), 'irrelevant');
});

test('automatic cancellation processes each ready APY/TPY/TAKK in order and fails closed before later work', async () => {
  const calls = [];
  const documents = [
    { id: 1, reservation_id: 'r1', document_type: '11.2', status: 'sent', mydata_mark: '4001', cancellation_status: 'requested' },
    { id: 2, reservation_id: 'r1', document_type: '8.2', status: 'sent', mydata_mark: '4002', cancellation_status: 'requested' },
  ];
  await assert.rejects(processAutomaticCancellationWork(documents, {
    cancel: async (document) => { calls.push(`cancel:${document.id}`); if (document.id === 2) throw new Error('AADE unavailable'); },
    verify: async (document) => { calls.push(`verify:${document.id}`); },
    resolve: async (document) => { calls.push(`resolve:${document.id}`); },
  }), /AADE unavailable/);
  assert.deepEqual(calls, ['cancel:1', 'verify:1', 'resolve:1', 'cancel:2']);
});
