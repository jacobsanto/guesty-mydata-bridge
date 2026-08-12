'use strict';

function insertedId(result) {
  const first = result?.[0];
  return first && typeof first === 'object' ? first.id : first;
}

module.exports = { insertedId };
