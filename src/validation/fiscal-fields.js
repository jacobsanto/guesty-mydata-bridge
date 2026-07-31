'use strict';

// CountryType enumeration from AADE SimpleTypes v2.0.1/v2.0.2.
const AADE_COUNTRY_CODES = new Set('AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OC OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR ST SV SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const ACCOMMODATION_CLIMATE_CATEGORIES = {
  apartment: { high: 24, low: 10 },
  villa: { high: 27, low: 30 },
};

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeCountryCode(value, fieldName = 'country') {
  const country = String(value || '').trim().toUpperCase();
  if (country && !AADE_COUNTRY_CODES.has(country)) {
    throw bad(`${fieldName} must be a country code accepted by AADE`);
  }
  return country || null;
}

function normalizeGreekVat(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^EL/, '')
    .replace(/[\s.-]/g, '');
}

function hasValidGreekVatChecksum(value) {
  if (!/^\d{9}$/.test(value)) return false;
  const sum = value.slice(0, 8).split('').reduce(
    (total, digit, index) => total + Number(digit) * (2 ** (8 - index)),
    0,
  );
  return (sum % 11) % 10 === Number(value[8]);
}

function normalizeAndValidateGreekVat(value, fieldName = 'vat_number') {
  const vat = normalizeGreekVat(value);
  if (!/^\d{9}$/.test(vat)) throw bad(`${fieldName} must be exactly 9 digits`);
  if (!hasValidGreekVatChecksum(vat)) throw bad(`${fieldName} has an invalid Greek VAT checksum`);
  return vat;
}

function normalizeBranch(value, fieldName = 'branch') {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw bad(`${fieldName} must be a non-negative base-10 integer`);
  }
  const branch = Number(text);
  if (!Number.isInteger(branch) || branch < 0 || branch > 2147483647) {
    throw bad(`${fieldName} must be a non-negative 32-bit integer`);
  }
  return branch;
}

function normalizeCounterpart({ vatNumber, country, name, branch } = {}, { required = false, label = 'counterpart' } = {}) {
  const normalizedCountry = normalizeCountryCode(country, `${label}_country`);
  let normalizedVat = String(vatNumber || '').trim().toUpperCase().replace(/\s/g, '');
  const normalizedName = String(name || '').trim() || null;
  const hasAny = Boolean(normalizedVat || normalizedCountry || normalizedName);

  if ((required || hasAny) && (!normalizedVat || !normalizedCountry)) {
    throw bad(`${label} VAT number and country are required together`);
  }
  if (normalizedVat.length > 30) throw bad(`${label}_vat_number must be <= 30 chars`);
  if (normalizedName && normalizedName.length > 200) throw bad(`${label}_name must be <= 200 chars`);
  if (normalizedCountry === 'GR' && normalizedVat) {
    normalizedVat = normalizeAndValidateGreekVat(normalizedVat, `${label}_vat_number`);
  }

  return {
    vatNumber: normalizedVat || null,
    country: normalizedCountry,
    name: normalizedName,
    branch: normalizeBranch(branch, `${label}_branch`),
  };
}

function normalizeSeries(value, { fieldName = 'series', required = false } = {}) {
  const series = String(value || '').trim();
  if (required && !series) throw bad(`${fieldName} is required`);
  if (series.length > 50) throw bad(`${fieldName} must be <= 50 chars`);
  return series || null;
}

function normalizeAccommodationClimateCategory(value, season, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const category = Number(value);
  const allowed = new Set(Object.values(ACCOMMODATION_CLIMATE_CATEGORIES).map((pair) => pair[season]));
  if (!Number.isInteger(category) || !allowed.has(category)) {
    throw bad(`${fieldName} must be an AADE ${season}-season category for rented rooms/apartments or tourist furnished villas (${[...allowed].join(' or ')})`);
  }
  return category;
}

function validateAccommodationClimatePair(propertyType, highCategory, lowCategory) {
  const expected = ACCOMMODATION_CLIMATE_CATEGORIES[propertyType];
  if (!expected) throw bad('property_type must be apartment or villa');
  if (Number(highCategory) !== expected.high || Number(lowCategory) !== expected.low) {
    throw bad(`property_type ${propertyType} requires AADE climate categories ${expected.high} (high) and ${expected.low} (low); short-term-rental categories are not allowed`);
  }
  return { high: expected.high, low: expected.low };
}

module.exports = {
  hasValidGreekVatChecksum,
  normalizeAndValidateGreekVat,
  normalizeAccommodationClimateCategory,
  normalizeCounterpart,
  normalizeBranch,
  normalizeCountryCode,
  normalizeGreekVat,
  normalizeSeries,
  validateAccommodationClimatePair,
};
