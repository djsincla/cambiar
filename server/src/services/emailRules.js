import { db } from '../db/index.js';
import { parseJsonOr } from "../db/json.js";

const VALID_ACTIONS = ['create_change', 'transition', 'add_note'];

function rowToRule(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    enabled: Boolean(r.enabled),
    priority: r.priority,
    fromPattern: r.from_pattern,
    subjectPattern: r.subject_pattern,
    actionType: r.action_type,
    actionConfig: parseJsonOr(r.action_config, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRules() {
  return db.prepare('SELECT * FROM email_rules ORDER BY priority ASC, id ASC').all().map(rowToRule);
}

export function getRule(id) {
  return rowToRule(db.prepare('SELECT * FROM email_rules WHERE id = ?').get(id));
}

export function listEnabledRulesByPriority() {
  return db.prepare('SELECT * FROM email_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC').all().map(rowToRule);
}

export function validateRuleInput(input, { partial = false } = {}) {
  if ('name' in input || !partial) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) return 'name is required';
  }
  if ('actionType' in input || !partial) {
    if (!VALID_ACTIONS.includes(input.actionType)) return `actionType must be one of ${VALID_ACTIONS.join(', ')}`;
  }
  for (const field of ['fromPattern', 'subjectPattern']) {
    if (input[field] != null && input[field] !== '') {
      try { new RegExp(input[field], 'i'); }
      catch (e) { return `${field} is not a valid regex: ${e.message}`; }
    }
  }
  if ('priority' in input) {
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) {
      return 'priority must be an integer between 0 and 1000';
    }
  }
  if ('actionConfig' in input && input.actionConfig != null) {
    if (typeof input.actionConfig !== 'object' || Array.isArray(input.actionConfig)) {
      return 'actionConfig must be an object';
    }
  }
  return null;
}

export function createRule(input) {
  const info = db.prepare(`
    INSERT INTO email_rules (name, enabled, priority, from_pattern, subject_pattern, action_type, action_config)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.enabled === false ? 0 : 1,
    input.priority ?? 100,
    input.fromPattern ?? null,
    input.subjectPattern ?? null,
    input.actionType,
    JSON.stringify(input.actionConfig ?? {}),
  );
  return getRule(Number(info.lastInsertRowid));
}

export function updateRule(id, patch) {
  const sets = [];
  const params = [];
  if ('name' in patch)           { sets.push('name = ?'); params.push(patch.name); }
  if ('enabled' in patch)        { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if ('priority' in patch)       { sets.push('priority = ?'); params.push(patch.priority); }
  if ('fromPattern' in patch)    { sets.push('from_pattern = ?'); params.push(patch.fromPattern); }
  if ('subjectPattern' in patch) { sets.push('subject_pattern = ?'); params.push(patch.subjectPattern); }
  if ('actionType' in patch)     { sets.push('action_type = ?'); params.push(patch.actionType); }
  if ('actionConfig' in patch)   { sets.push('action_config = ?'); params.push(JSON.stringify(patch.actionConfig ?? {})); }

  if (!sets.length) return getRule(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE email_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getRule(id);
}

export function deleteRule(id) {
  return db.prepare('DELETE FROM email_rules WHERE id = ?').run(id).changes > 0;
}

/**
 * Find the first enabled rule whose from_pattern AND subject_pattern (if set)
 * match the given email. Patterns are case-insensitive regex.
 *
 * @param {{from: string, subject: string}} email
 * @returns {object|null} the matched rule or null
 */
export function matchRule(email) {
  const rules = listEnabledRulesByPriority();
  for (const r of rules) {
    if (r.fromPattern) {
      try {
        if (!new RegExp(r.fromPattern, 'i').test(email.from ?? '')) continue;
      } catch { continue; }
    }
    if (r.subjectPattern) {
      try {
        if (!new RegExp(r.subjectPattern, 'i').test(email.subject ?? '')) continue;
      } catch { continue; }
    }
    return r;
  }
  return null;
}
