'use strict';

const express = require('express');
const router = express.Router();
const { listInvoices, getInvoiceById } = require('../repositories/invoices');

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/invoices', async (req, res, next) => {
  try {
    const filters = {};
    if (['pending', 'sent', 'failed'].includes(req.query.status)) filters.status = req.query.status;
    if (req.query.company_id) {
      const companyId = parseId(req.query.company_id);
      if (!companyId) return res.status(400).json({ error: 'Invalid company_id' });
      filters.companyId = companyId;
    }
    return res.json({ data: await listInvoices(filters) });
  } catch (error) { return next(error); }
});

router.get('/invoices/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice id' });
    const invoice = await getInvoiceById(id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    return res.json({ data: invoice });
  } catch (error) { return next(error); }
});

router.get('/invoices/:id/xml', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invoice id' });
    const invoice = await getInvoiceById(id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    return res.type('application/xml').send(invoice.xml_payload || '');
  } catch (error) { return next(error); }
});

module.exports = router;
