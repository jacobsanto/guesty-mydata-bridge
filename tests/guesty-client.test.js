'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchConsistentReservationSnapshot } = require('../src/guesty/client');

function response(data) { return Promise.resolve({ data }); }
function folioResult(reservationId, extra) { return { results: [{ reservationId, currency: 'EUR', ...extra }] }; }

test('Guesty fiscal fetch retries an alteration and returns only a bracketed stable snapshot', async () => {
  const reservationId = 'res-consistent';
  let reservationReads = 0;
  let overviewReads = 0;
  let itemReads = 0;
  const get = (url) => {
    if (url.endsWith('/reservations-v3')) {
      reservationReads += 1;
      const version = reservationReads === 1 ? 1 : 2;
      return response([{ _id: reservationId, listingId: 'listing-1', lastUpdatedAt: `2026-07-31T00:00:0${version}Z` }]);
    }
    if (url.endsWith('/guest-folio/overview')) {
      overviewReads += 1;
      const version = overviewReads === 1 ? 1 : 2;
      return response(folioResult(reservationId, { listingId: 'listing-1', platform: 'airbnb2', source: 'airbnb2', updatedAt: `2026-07-31T00:00:0${version}Z` }));
    }
    itemReads += 1;
    const version = itemReads <= 2 ? 1 : 2;
    return response(folioResult(reservationId, { invoiceItems: [{ id: `line-${version}`, normalType: 'AF', totalPrice: 113 }] }));
  };
  const snapshot = await fetchConsistentReservationSnapshot(reservationId, { get });
  assert.equal(snapshot.lastUpdatedAt, '2026-07-31T00:00:02Z');
  assert.equal(snapshot.fiscalFolioOverview.updatedAt, '2026-07-31T00:00:02Z');
  assert.equal(snapshot.fiscalInvoiceItems[0].id, 'line-2');
  assert.equal(itemReads, 4);
});

test('Guesty fiscal fetch retries when only invoice items change between the two reads', async () => {
  const reservationId = 'res-folio-only-change';
  let itemReads = 0;
  const get = (url) => {
    if (url.endsWith('/reservations-v3')) return response([{ _id: reservationId, lastUpdatedAt: 'stable' }]);
    if (url.endsWith('/guest-folio/overview')) return response(folioResult(reservationId, { updatedAt: 'stable' }));
    itemReads += 1;
    const version = itemReads === 1 ? 1 : 2;
    return response(folioResult(reservationId, { invoiceItems: [{ id: `line-${version}`, normalType: 'AF', totalPrice: 113 }] }));
  };
  const snapshot = await fetchConsistentReservationSnapshot(reservationId, { get });
  assert.equal(snapshot.fiscalInvoiceItems[0].id, 'line-2');
  assert.equal(itemReads, 4);
});

test('Guesty fiscal fetch fails closed when the reservation keeps changing', async () => {
  const reservationId = 'res-unstable';
  let version = 0;
  const get = (url) => {
    version += 1;
    if (url.endsWith('/reservations-v3')) return response([{ _id: reservationId, lastUpdatedAt: String(version) }]);
    if (url.endsWith('/guest-folio/overview')) return response(folioResult(reservationId, { updatedAt: String(version) }));
    return response(folioResult(reservationId, { invoiceItems: [{ id: `line-${version}`, normalType: 'AF', totalPrice: 113 }] }));
  };
  await assert.rejects(
    fetchConsistentReservationSnapshot(reservationId, { get, maxAttempts: 3 }),
    /changed while its fiscal folio was being read/,
  );
});

test('Guesty cancellation ingestion uses only a stable authoritative reservation and never requires Guest Folio', async () => {
  const reservationId = 'res-cancelled-without-folio';
  let reservationReads = 0;
  let folioReads = 0;
  const get = (url) => {
    if (url.endsWith('/reservations-v3')) {
      reservationReads += 1;
      return response([{
        _id: reservationId,
        listingId: 'listing-1',
        status: 'cancelled',
        checkInDateLocalized: '2026-07-30',
        checkOutDateLocalized: '2026-07-31',
        lastUpdatedAt: '2026-07-31T12:00:00Z',
      }]);
    }
    folioReads += 1;
    throw new Error('Guest Folio no longer exists');
  };
  const snapshot = await fetchConsistentReservationSnapshot(reservationId, { get });
  assert.equal(snapshot.status, 'cancelled');
  assert.equal(snapshot.authoritativeCancellation, true);
  assert.equal(reservationReads, 2);
  assert.equal(folioReads, 0);
});
