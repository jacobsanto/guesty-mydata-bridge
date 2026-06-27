'use strict';

const axios = require('axios');
const xml2js = require('xml2js');

// -------------------------------------------------------------------
// Endpoints ΑΑΔΕ myDATA REST API
// Sandbox: https://mydataapidev.aade.gr
// Production: https://mydatapi.aade.gr/myDATA
// -------------------------------------------------------------------
const MYDATA_ENDPOINTS = {
  sandbox: 'https://mydataapidev.aade.gr/SendInvoices',
  production: 'https://mydatapi.aade.gr/myDATA/SendInvoices',
};

function getEndpoint() {
  const env = process.env.MYDATA_ENV || 'sandbox';
  const url = MYDATA_ENDPOINTS[env];
  if (!url) throw new Error(`Άγνωστο MYDATA_ENV: "${env}". Χρησιμοποίησε "sandbox" ή "production".`);
  return url;
}

// -------------------------------------------------------------------
// Αποστολή XML στην ΑΑΔΕ με company credentials
// -------------------------------------------------------------------
async function sendToMyData(xmlPayload, companyContext) {
  const url = getEndpoint();

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
    throw new Error(`Network error κατά αποστολή στο myDATA: ${networkErr.message}`);
  }

  // -------------------------------------------------------------------
  // Parse XML response
  // -------------------------------------------------------------------
  let parsed;
  try {
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    parsed = await parser.parseStringPromise(response.data);
  } catch (parseErr) {
    throw new Error(
      `Αδυναμία parse απάντησης ΑΑΔΕ (HTTP ${response.status}): ${String(response.data).substring(0, 200)}`
    );
  }

  // -------------------------------------------------------------------
  // Έλεγχος για σφάλματα στο response της ΑΑΔΕ
  // Δομή: ResponseDoc > response > statusCode / errors / invoiceMark
  // -------------------------------------------------------------------
  const responseDoc = parsed?.ResponseDoc?.response;
  if (!responseDoc) {
    throw new Error(`Μη αναμενόμενη δομή response από ΑΑΔΕ: ${JSON.stringify(parsed).substring(0, 300)}`);
  }

  // HTTP errors
  if (response.status >= 400) {
    const errDetails = extractAadeErrors(responseDoc);
    throw new Error(`ΑΑΔΕ HTTP ${response.status}: ${errDetails}`);
  }

  // ΑΑΔΕ application-level errors (HTTP 200 αλλά με errors στο XML)
  if (responseDoc.statusCode === 'ValidationError' || responseDoc.errors) {
    const errDetails = extractAadeErrors(responseDoc);
    throw new Error(`ΑΑΔΕ Validation Error: ${errDetails}`);
  }

  // -------------------------------------------------------------------
  // Επιτυχία — εξαγωγή MARK και UID
  // -------------------------------------------------------------------
  const mark = responseDoc.invoiceMark;
  const uid = responseDoc.invoiceUid || null;

  if (!mark) {
    throw new Error(`Δεν επιστράφηκε MARK από ΑΑΔΕ. Response: ${JSON.stringify(responseDoc)}`);
  }

  console.log(`📨 myDATA OK | ΑΦΜ: ${companyContext.vat_number} | MARK: ${mark} | UID: ${uid || 'N/A'}`);

  return { success: true, mark: String(mark), uid: uid ? String(uid) : null };
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

module.exports = { sendToMyData };
