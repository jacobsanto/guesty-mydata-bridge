'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { verifyCancelledInvoice } = require('../src/mydata-client');

const company = { aade_user_id: 'user', aade_subscription_key: 'key' };
const invoiceMark = '400000000000100';
const cancellationMark = '900000000000100';

function requestedDoc({ cancellations = [], continuation = null } = {}) {
  const cancellationXml = cancellations.length
    ? `<cancelledInvoicesDoc>${cancellations.map((row) => `<cancelledInvoice><invoiceMark>${row.invoiceMark}</invoiceMark><cancellationMark>${row.cancellationMark}</cancellationMark><cancellationDate>2026-07-31</cancellationDate></cancelledInvoice>`).join('')}</cancelledInvoicesDoc>`
    : '';
  const continuationXml = continuation
    ? `<continuationToken><nextPartitionKey>${continuation.nextPartitionKey}</nextPartitionKey><nextRowKey>${continuation.nextRowKey}</nextRowKey></continuationToken>`
    : '';
  return `<?xml version="1.0"?><RequestedDoc>${cancellationXml}${continuationXml}</RequestedDoc>`;
}

async function withAxiosGet(fake, operation) {
  const original = axios.get;
  axios.get = fake;
  try {
    return await operation();
  } finally {
    axios.get = original;
  }
}

test('known cancellation MARK uses its exact RequestTransmittedDocs interval', { concurrency: false }, async () => {
  const calls = [];
  const result = await withAxiosGet(async (url, config) => {
    calls.push({ url, config });
    return { status: 200, data: requestedDoc({ cancellations: [{ invoiceMark, cancellationMark }] }) };
  }, () => verifyCancelledInvoice(invoiceMark, company, { cancellationMark }));

  assert.equal(result.verified, true);
  assert.equal(result.invoiceMark, invoiceMark);
  assert.equal(result.cancellationMark, cancellationMark);
  assert.equal(result.pagesScanned, 1);
  assert.deepEqual(calls[0].config.params, {
    mark: (BigInt(cancellationMark) - 1n).toString(),
    maxMark: cancellationMark,
  });
});

test('unknown cancellation outcome follows continuation tokens and correlates original invoice MARK', { concurrency: false }, async () => {
  const calls = [];
  const result = await withAxiosGet(async (_url, config) => {
    calls.push(config.params);
    if (calls.length === 1) {
      return {
        status: 200,
        data: requestedDoc({
          cancellations: [{ invoiceMark: '400000000000099', cancellationMark: '800000000000099' }],
          continuation: { nextPartitionKey: 'partition-2', nextRowKey: 'row-2' },
        }),
      };
    }
    return { status: 200, data: requestedDoc({ cancellations: [{ invoiceMark, cancellationMark }] }) };
  }, () => verifyCancelledInvoice(invoiceMark, company, { maxPages: 3 }));

  assert.equal(result.verified, true);
  assert.equal(result.cancellationMark, cancellationMark);
  assert.equal(result.pagesScanned, 2);
  assert.deepEqual(calls, [
    { mark: invoiceMark },
    { mark: invoiceMark, nextPartitionKey: 'partition-2', nextRowKey: 'row-2' },
  ]);
});

test('bounded unknown scan never reports notFound while a continuation token remains', { concurrency: false }, async () => {
  await withAxiosGet(async () => ({
    status: 200,
    data: requestedDoc({ continuation: { nextPartitionKey: 'more', nextRowKey: 'more' } }),
  }), async () => {
    await assert.rejects(
      verifyCancelledInvoice(invoiceMark, company, { maxPages: 2 }),
      (error) => error.scanIncomplete === true && error.retryable === true,
    );
  });
});

test('timeout is retryable and cannot become an authoritative notFound result', { concurrency: false }, async () => {
  await withAxiosGet(async () => {
    const error = new Error('timeout of 15000ms exceeded');
    error.code = 'ECONNABORTED';
    throw error;
  }, async () => {
    await assert.rejects(
      verifyCancelledInvoice(invoiceMark, company, { maxPages: 1 }),
      (error) => error.retryable === true && error.message.includes('timeout'),
    );
  });
});

test('known cancellation MARK belonging to another invoice is rejected', { concurrency: false }, async () => {
  await withAxiosGet(async () => ({
    status: 200,
    data: requestedDoc({ cancellations: [{ invoiceMark: '400000000000999', cancellationMark }] }),
  }), async () => {
    await assert.rejects(
      verifyCancelledInvoice(invoiceMark, company, { cancellationMark }),
      (error) => error.status === 409 && error.correlationMismatch === true,
    );
  });
});

test('completed unknown scan returns authoritative notFound without false correlation', { concurrency: false }, async () => {
  const result = await withAxiosGet(async () => ({
    status: 200,
    data: requestedDoc({ cancellations: [{ invoiceMark: '400000000000999', cancellationMark }] }),
  }), () => verifyCancelledInvoice(invoiceMark, company, { maxPages: 2 }));
  assert.equal(result.verified, false);
  assert.equal(result.notFound, true);
  assert.equal(result.invoiceMark, invoiceMark);
});
