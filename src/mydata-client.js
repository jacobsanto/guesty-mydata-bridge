'use strict';

const axios = require('axios');
const xml2js = require('xml2js');
const { assertSameFiscalIdentity } = require('./validation/mydata-identity');

// -------------------------------------------------------------------
// Endpoints ΑΑΔΕ myDATA REST API
// Sandbox: https://mydataapidev.aade.gr
// Production: https://mydatapi.aade.gr/myDATA
// -------------------------------------------------------------------
const MYDATA_ENDPOINTS = {
  sandbox: 'https://mydataapidev.aade.gr',
  production: 'https://mydatapi.aade.gr/myDATA',
};

function getEndpoint(path) {
  const env = process.env.MYDATA_ENV || 'sandbox';
  const baseUrl = MYDATA_ENDPOINTS[env];
  if (!baseUrl) throw new Error(`Άγνωστο MYDATA_ENV: "${env}". Χρησιμοποίησε "sandbox" ή "production".`);
  return `${baseUrl}/${path}`;
}

function numericMark(value, label = 'MARK') {
  const mark = String(value || '');
  if (!/^\d+$/.test(mark)) throw new Error(`Η ΑΑΔΕ επέστρεψε μη έγκυρο αριθμητικό ${label}`);
  return mark;
}

function transmissionError(message, { uncertain = false, retryable = false } = {}) {
  const error = new Error(message);
  error.transmissionUncertain = Boolean(uncertain);
  error.retryable = Boolean(retryable);
  return error;
}

function buildCancelInvoiceRequest(mark, companyContext) {
  if (!/^\d+$/.test(String(mark || ''))) throw new Error('A numeric myDATA MARK is required for cancellation');
  return {
    url: getEndpoint('CancelInvoice'),
    data: null,
    config: {
      headers: {
        'aade-user-id': companyContext.aade_user_id,
        'ocp-apim-subscription-key': companyContext.aade_subscription_key,
        Accept: 'application/xml',
      },
      params: { mark: String(mark) },
      timeout: parseInt(process.env.MYDATA_TIMEOUT_MS || '15000', 10),
      validateStatus: () => true,
    },
  };
}

function buildConnectionTestRequest(companyContext) {
  return {
    url: getEndpoint('RequestTransmittedDocs'),
    config: {
      headers: {
        'aade-user-id': companyContext.aade_user_id,
        'ocp-apim-subscription-key': companyContext.aade_subscription_key,
        Accept: 'application/xml',
      },
      // mark is the sole mandatory filter. Omitting dates also avoids depending
      // on a date format that AADE does not define in this method's contract.
      params: { mark: '0' },
      timeout: parseInt(process.env.MYDATA_TIMEOUT_MS || '15000', 10),
      validateStatus: () => true,
    },
  };
}

// -------------------------------------------------------------------
// Αποστολή XML στην ΑΑΔΕ με company credentials
// -------------------------------------------------------------------
async function sendToMyData(xmlPayload, companyContext) {
  const url = getEndpoint('SendInvoices');

  const config = {
    headers: {
      'aade-user-id': companyContext.aade_user_id,
      'ocp-apim-subscription-key': companyContext.aade_subscription_key,
      'Content-Type': 'text/xml;charset=UTF-8',
      'Accept': 'application/xml',
    },
    timeout: parseInt(process.env.MYDATA_TIMEOUT_MS || '15000'), // 15s default
    // Αποφυγή axios να πετάει error για HTTP 4xx/5xx — τα χειριζόμαστε εμείς
    validateStatus: () => true,
  };

  let response;
  try {
    response = await axios.post(url, xmlPayload, config);
  } catch (networkErr) {
    // Network-level failure (DNS, timeout, connection refused)
    throw transmissionError(`Network error κατά αποστολή στο myDATA: ${networkErr.message}`, { uncertain: true });
  }

  // -------------------------------------------------------------------
  // Parse XML response
  // -------------------------------------------------------------------
  let parsed;
  try {
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    parsed = await parser.parseStringPromise(response.data);
  } catch (parseErr) {
    throw transmissionError(
      `Αδυναμία parse απάντησης ΑΑΔΕ (HTTP ${response.status}): ${String(response.data).substring(0, 200)}`,
      { uncertain: response.status < 400 },
    );
  }

  // -------------------------------------------------------------------
  // Έλεγχος για σφάλματα στο response της ΑΑΔΕ
  // Δομή: ResponseDoc > response > statusCode / errors / invoiceMark
  // -------------------------------------------------------------------
  const responseValue = parsed?.ResponseDoc?.response;
  const responseDoc = Array.isArray(responseValue) ? responseValue[0] : responseValue;
  if (!responseDoc) {
    throw transmissionError(`Μη αναμενόμενη δομή response από ΑΑΔΕ: ${JSON.stringify(parsed).substring(0, 300)}`, {
      uncertain: response.status < 400 || response.status >= 500,
    });
  }

  // HTTP errors
  if (response.status >= 400) {
    const errDetails = extractAadeErrors(responseDoc);
    throw transmissionError(`ΑΑΔΕ HTTP ${response.status}: ${errDetails}`, {
      uncertain: response.status >= 500,
      retryable: response.status === 429,
    });
  }

  // ΑΑΔΕ application-level errors (HTTP 200 αλλά με errors στο XML)
  if (responseDoc.statusCode !== 'Success' || responseDoc.errors) {
    const errDetails = extractAadeErrors(responseDoc);
    throw transmissionError(`ΑΑΔΕ Validation Error: ${errDetails}`);
  }

  // -------------------------------------------------------------------
  // Επιτυχία — εξαγωγή MARK και UID
  // -------------------------------------------------------------------
  const mark = responseDoc.invoiceMark;
  const uid = responseDoc.invoiceUid || null;
  const qrUrl = responseDoc.qrUrl || null;

  if (!mark) {
    throw transmissionError(`Δεν επιστράφηκε MARK από ΑΑΔΕ. Response: ${JSON.stringify(responseDoc)}`, { uncertain: true });
  }
  const validatedMark = numericMark(mark);

  console.log(`📨 myDATA OK | ΑΦΜ: ${companyContext.vat_number} | MARK: ${validatedMark} | UID: ${uid || 'N/A'}`);

  return {
    success: true,
    mark: validatedMark,
    uid: uid ? String(uid) : null,
    qrUrl: qrUrl ? String(qrUrl) : null,
    raw: responseDoc,
  };
}

async function cancelMyDataInvoice(mark, companyContext) {
  const request = buildCancelInvoiceRequest(mark, companyContext);
  let response;
  try {
    response = await axios.post(request.url, request.data, request.config);
  } catch (error) {
    throw transmissionError(`Network error κατά την ακύρωση στο myDATA: ${error.message}`, { uncertain: true });
  }
  let parsed;
  try {
    parsed = await new xml2js.Parser({ explicitArray: false, ignoreAttrs: true }).parseStringPromise(response.data);
  } catch {
    throw transmissionError(`Αδυναμία parse απάντησης ακύρωσης ΑΑΔΕ (HTTP ${response.status})`, { uncertain: response.status < 400 });
  }
  const value = parsed?.ResponseDoc?.response;
  const responseDoc = Array.isArray(value) ? value[0] : value;
  if (!responseDoc || response.status >= 400 || responseDoc.statusCode !== 'Success' || !responseDoc.cancellationMark) {
    throw transmissionError(`ΑΑΔΕ ακύρωση απέτυχε: ${extractAadeErrors(responseDoc || {})}`, {
      uncertain: response.status >= 500,
      retryable: response.status === 429,
    });
  }
  return { cancellationMark: numericMark(responseDoc.cancellationMark, 'cancellation MARK'), raw: responseDoc };
}

async function verifyTransmittedDocument(mark, companyContext, expectedDocument = null) {
  if (!/^\d+$/.test(String(mark || ''))) throw new Error('A numeric myDATA MARK is required for verification');
  const lowerMark = (BigInt(String(mark)) - 1n).toString();
  let response;
  try {
    response = await axios.get(getEndpoint('RequestTransmittedDocs'), {
      headers: {
        'aade-user-id': companyContext.aade_user_id,
        'ocp-apim-subscription-key': companyContext.aade_subscription_key,
        Accept: 'application/xml',
      },
      params: { mark: lowerMark, maxMark: String(mark) },
      timeout: parseInt(process.env.MYDATA_TIMEOUT_MS || '15000', 10),
      validateStatus: () => true,
    });
  } catch (error) {
    throw new Error(`Network error κατά την επαλήθευση myDATA: ${error.message}`);
  }
  if (response.status >= 400) throw new Error(`ΑΑΔΕ verification HTTP ${response.status}`);
  let parsed;
  try {
    parsed = await new xml2js.Parser({ explicitArray: false, ignoreAttrs: true }).parseStringPromise(response.data);
  } catch {
    throw new Error('Αδυναμία parse της απάντησης RequestTransmittedDocs');
  }
  const invoiceValue = parsed?.RequestedDoc?.invoicesDoc?.invoice;
  const invoices = invoiceValue ? (Array.isArray(invoiceValue) ? invoiceValue : [invoiceValue]) : [];
  const invoice = invoices.find((item) => String(item.mark) === String(mark));
  if (!invoice) throw new Error(`Το MARK ${mark} δεν επιβεβαιώθηκε από RequestTransmittedDocs`);
  if (companyContext.vat_number && String(invoice.issuer?.vatNumber) !== String(companyContext.vat_number)) {
    throw new Error(`Το MARK ${mark} επέστρεψε διαφορετικό ΑΦΜ εκδότη`);
  }
  if (expectedDocument) assertSameFiscalIdentity(expectedDocument, invoice, invoice.uid ? String(invoice.uid) : null);
  return { verified: true, mark: String(mark), uid: invoice.uid ? String(invoice.uid) : null, raw: invoice };
}

async function verifyCancelledInvoice(mark, companyContext) {
  if (!/^\d+$/.test(String(mark || ''))) throw new Error('A numeric invoice MARK is required for cancellation verification');
  const lowerMark = (BigInt(String(mark)) - 1n).toString();
  let response;
  try {
    response = await axios.get(getEndpoint('RequestTransmittedDocs'), {
      headers: {
        'aade-user-id': companyContext.aade_user_id,
        'ocp-apim-subscription-key': companyContext.aade_subscription_key,
        Accept: 'application/xml',
      },
      params: { mark: lowerMark, maxMark: String(mark) },
      timeout: parseInt(process.env.MYDATA_TIMEOUT_MS || '15000', 10),
      validateStatus: () => true,
    });
  } catch (error) {
    throw new Error(`Network error κατά την επαλήθευση ακύρωσης myDATA: ${error.message}`);
  }
  if (response.status >= 400) throw new Error(`ΑΑΔΕ cancellation verification HTTP ${response.status}`);
  let parsed;
  try {
    parsed = await new xml2js.Parser({ explicitArray: false, ignoreAttrs: true }).parseStringPromise(response.data);
  } catch {
    throw new Error('Αδυναμία parse απάντησης ακυρωμένων RequestTransmittedDocs');
  }
  const value = parsed?.RequestedDoc?.cancelledInvoicesDoc?.cancelledInvoice;
  const rows = value ? (Array.isArray(value) ? value : [value]) : [];
  const cancellation = rows.find((row) => String(row.invoiceMark) === String(mark));
  if (!cancellation?.cancellationMark) {
    return { verified: false, notFound: true, invoiceMark: String(mark), raw: rows };
  }
  return {
    verified: true,
    invoiceMark: String(mark),
    cancellationMark: numericMark(cancellation.cancellationMark, 'cancellation MARK'),
    raw: cancellation,
  };
}

async function testMyDataConnection(companyContext) {
  const request = buildConnectionTestRequest(companyContext);
  let response;
  try {
    response = await axios.get(request.url, request.config);
  } catch (error) {
    throw new Error(`Network error κατά τον έλεγχο σύνδεσης myDATA: ${error.message}`);
  }
  if (response.status >= 400) throw new Error(`ΑΑΔΕ connection test HTTP ${response.status}`);
  let parsed;
  try {
    parsed = await new xml2js.Parser({ explicitArray: false, ignoreAttrs: true }).parseStringPromise(response.data);
  } catch {
    throw new Error('Η ΑΑΔΕ δεν επέστρεψε έγκυρο XML στον έλεγχο σύνδεσης');
  }
  if (!parsed?.RequestedDoc) throw new Error(`Μη αναμενόμενη απάντηση ΑΑΔΕ: ${JSON.stringify(parsed).slice(0, 200)}`);
  return { success: true, environment: process.env.MYDATA_ENV || 'sandbox', checkedAt: new Date().toISOString() };
}

// -------------------------------------------------------------------
// Helper: εξαγωγή error messages από ΑΑΔΕ response
// -------------------------------------------------------------------
function extractAadeErrors(responseDoc) {
  try {
    const errors = responseDoc.errors?.error;
    if (!errors) return 'Άγνωστο σφάλμα ΑΑΔΕ';
    const errList = Array.isArray(errors) ? errors : [errors];
    return errList
      .map((e) => `[${e.code || '?'}] ${e.message || e}`)
      .join('; ');
  } catch {
    return 'Αδυναμία εξαγωγής λεπτομερειών σφάλματος';
  }
}

module.exports = {
  sendToMyData,
  cancelMyDataInvoice,
  verifyTransmittedDocument,
  verifyCancelledInvoice,
  testMyDataConnection,
  buildCancelInvoiceRequest,
  buildConnectionTestRequest,
};
