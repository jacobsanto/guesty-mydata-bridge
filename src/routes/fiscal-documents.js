'use strict';

const express = require('express');
const { listDocuments } = require('../repositories/fiscal-documents');
const { cancelFiscalDocument, reconcileFiscalDocumentCancellation } = require('../services/cancellation-service');
const { createCreditDocument } = require('../services/credit-service');
const { renderFiscalDocumentPdf } = require('../services/pdf-service');
const { reconcileUncertainTransmission } = require('../services/transmission-reconciliation-service');

const router = express.Router();

router.get('/fiscal-documents', async (req, res, next) => {
  try {
    res.json(await listDocuments({
      companyId: req.query.company_id ? Number(req.query.company_id) : undefined,
      status: req.query.status,
      businessDate: req.query.business_date,
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/fiscal-documents/:id/cancel', async (req, res, next) => {
  try {
    const documentId = Number(req.params.id);
    if (!Number.isInteger(documentId) || documentId <= 0) return res.status(400).json({ error: 'Invalid document id' });
    return res.json(await cancelFiscalDocument({ documentId }));
  } catch (error) {
    next(error);
  }
});

router.post('/fiscal-documents/:id/reconcile-cancellation', async (req, res, next) => {
  try {
    const documentId = Number(req.params.id);
    if (!Number.isInteger(documentId) || documentId <= 0) return res.status(400).json({ error: 'Invalid document id' });
    return res.json(await reconcileFiscalDocumentCancellation({ documentId }));
  } catch (error) { next(error); }
});

router.post('/fiscal-documents/:id/credit', async (req, res, next) => {
  try {
    const documentId = Number(req.params.id);
    if (!Number.isInteger(documentId) || documentId <= 0) return res.status(400).json({ error: 'Invalid document id' });
    const result = await createCreditDocument({
      documentId,
      grossValue: req.body.gross_value,
      issueDate: req.body.issue_date,
      reference: req.body.reference || 'default',
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/fiscal-documents/:id/reconcile-mark', async (req, res, next) => {
  try {
    const documentId = Number(req.params.id);
    if (!Number.isInteger(documentId) || documentId <= 0) return res.status(400).json({ error: 'Invalid document id' });
    return res.json(await reconcileUncertainTransmission({ documentId, mark: req.body.mark }));
  } catch (error) {
    next(error);
  }
});

router.get('/fiscal-documents/:id/pdf', async (req, res, next) => {
  try {
    const documentId = Number(req.params.id);
    if (!Number.isInteger(documentId) || documentId <= 0) return res.status(400).json({ error: 'Invalid document id' });
    const pdf = await renderFiscalDocumentPdf(documentId);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="fiscal-document-${documentId}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
