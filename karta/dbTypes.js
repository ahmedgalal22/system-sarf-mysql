/**
 * dbTypes.js — Database Type Normalization
 * ─────────────────────────────────────────────────────────────────────────────
 * MySQL TINYINT(1) boolean fields are returned by PHP/PDO as:
 *   - integer 0 or 1         (PDO::ATTR_EMULATE_PREPARES = false)
 *   - string  "0" or "1"     (PDO::ATTR_EMULATE_PREPARES = true)
 *
 * JavaScript strict comparison (=== true / === false) fails for all of these:
 *   0 === false  → false
 *   1 === true   → false
 *   "0" === false → false
 *   "1" === true  → false
 *
 * This module provides a single normalizer used across all frontend modules
 * to safely interpret MySQL boolean fields.
 *
 * Usage:
 *   import { dbBool } from './dbTypes.js';
 *
 *   // Active (non-reversed) entries:
 *   entries.filter(e => !dbBool(e.is_reversed))
 *
 *   // Archived entries:
 *   entries.filter(e => dbBool(e.is_archived))
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Normalize a MySQL TINYINT(1) value to a JavaScript boolean.
 *
 * Truthy:  true, 1, "1"
 * Falsy:   false, 0, "0", null, undefined, ""
 *
 * @param {*} value — raw value from API response
 * @returns {boolean}
 */
function dbBool(value) {
  return value === true || value === 1 || value === '1';
}

export { dbBool };
export default dbBool;
