// Defensive JSON.parse for DB-loaded values.
//
// Most rows in the schema store structured payloads (fields_json,
// details_json, action_config, status_filter, etc.) and the read paths
// historically called bare JSON.parse. If a row gets corrupted — manual
// SQL edit, partial write, schema drift — bare parse throws and the
// request returns 500 with a stack trace in the logs.
//
// Use parseJsonOr(text, fallback) at every read site instead. Treats null
// and empty string as the fallback so callers don't have to guard those.

import { logger } from '../logger.js';

export function parseJsonOr(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.warn({ err: err.message, sample: String(text).slice(0, 80) }, 'parseJsonOr: invalid JSON in DB row, using fallback');
    return fallback;
  }
}
