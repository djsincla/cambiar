import { db } from '../db/index.js';
import { parseJsonOr } from "../db/json.js";

const VALID_FIELD_TYPES = ['string', 'text', 'number', 'select', 'boolean'];

/**
 * Validate a fields-schema array (the shape stored in change_types.fields_json).
 * Returns null if valid, otherwise an error string.
 */
export function validateFieldSchema(fields) {
  if (!Array.isArray(fields)) return 'fields must be an array';
  const seenKeys = new Set();
  for (const [i, f] of fields.entries()) {
    if (!f || typeof f !== 'object') return `fields[${i}] must be an object`;
    if (typeof f.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(f.key)) {
      return `fields[${i}].key must match /^[a-z][a-z0-9_]*$/`;
    }
    if (seenKeys.has(f.key)) return `duplicate field key: ${f.key}`;
    seenKeys.add(f.key);
    if (typeof f.label !== 'string' || !f.label) return `fields[${i}].label is required`;
    if (!VALID_FIELD_TYPES.includes(f.type)) {
      return `fields[${i}].type must be one of ${VALID_FIELD_TYPES.join(', ')}`;
    }
    if (f.type === 'select') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        return `fields[${i}].options is required for select`;
      }
    }
  }
  return null;
}

function rowToType(r, includeApproverGroups = true) {
  const t = {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    icon: r.icon,
    fields: parseJsonOr(r.fields_json, []),
    active: Boolean(r.active),
    autoApprove: Boolean(r.auto_approve),
    approvalSlaMinutes: r.approval_sla_minutes ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (includeApproverGroups) {
    t.approverGroups = db.prepare(`
      SELECT g.id, g.name FROM change_type_approver_groups ctg
      JOIN groups g ON g.id = ctg.group_id
      WHERE ctg.change_type_id = ?
      ORDER BY g.name
    `).all(r.id);
  }
  return t;
}

export function listChangeTypes({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM change_types WHERE active = 1 ORDER BY name'
    : 'SELECT * FROM change_types ORDER BY name';
  return db.prepare(sql).all().map(r => rowToType(r));
}

export function getChangeTypeByKey(key, { activeOnly = false } = {}) {
  const r = activeOnly
    ? db.prepare('SELECT * FROM change_types WHERE key = ? AND active = 1').get(key)
    : db.prepare('SELECT * FROM change_types WHERE key = ?').get(key);
  return r ? rowToType(r) : null;
}

export function getChangeTypeById(id) {
  const r = db.prepare('SELECT * FROM change_types WHERE id = ?').get(id);
  return r ? rowToType(r) : null;
}

export function createChangeType({ key, name, description, icon, fields, approverGroupIds, autoApprove, approvalSlaMinutes }) {
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO change_types (key, name, description, icon, fields_json, active, auto_approve, approval_sla_minutes)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(key, name, description ?? null, icon ?? null, JSON.stringify(fields ?? []), autoApprove ? 1 : 0, approvalSlaMinutes ?? null);
    if (Array.isArray(approverGroupIds) && approverGroupIds.length) {
      const ins = db.prepare('INSERT INTO change_type_approver_groups (change_type_id, group_id) VALUES (?, ?)');
      for (const gid of approverGroupIds) ins.run(info.lastInsertRowid, gid);
    }
    return info.lastInsertRowid;
  });
  return getChangeTypeById(Number(tx()));
}

export function updateChangeType(id, patch) {
  const existing = db.prepare('SELECT id FROM change_types WHERE id = ?').get(id);
  if (!existing) return null;

  const tx = db.transaction(() => {
    const sets = [];
    const params = [];
    for (const [k, col] of [['key','key'], ['name','name'], ['description','description'], ['icon','icon'], ['active','active']]) {
      if (k in patch) { sets.push(`${col} = ?`); params.push(k === 'active' ? (patch[k] ? 1 : 0) : patch[k]); }
    }
    if ('autoApprove' in patch) { sets.push('auto_approve = ?'); params.push(patch.autoApprove ? 1 : 0); }
    if ('approvalSlaMinutes' in patch) { sets.push('approval_sla_minutes = ?'); params.push(patch.approvalSlaMinutes); }
    if ('fields' in patch) {
      sets.push('fields_json = ?');
      params.push(JSON.stringify(patch.fields));
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      params.push(id);
      db.prepare(`UPDATE change_types SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    if ('approverGroupIds' in patch) {
      db.prepare('DELETE FROM change_type_approver_groups WHERE change_type_id = ?').run(id);
      if (Array.isArray(patch.approverGroupIds) && patch.approverGroupIds.length) {
        const ins = db.prepare('INSERT INTO change_type_approver_groups (change_type_id, group_id) VALUES (?, ?)');
        for (const gid of patch.approverGroupIds) ins.run(id, gid);
      }
    }
  });
  tx();
  return getChangeTypeById(id);
}

export function softDeleteChangeType(id) {
  const info = db.prepare(`UPDATE change_types SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
  return info.changes > 0;
}

/**
 * Validate user-supplied `fields` object against a change type's field schema.
 * Returns { ok: true, fields } or { ok: false, error }.
 */
export function validateFields(typeKey, fields) {
  const type = getChangeTypeByKey(typeKey, { activeOnly: false });
  if (!type) return { ok: false, error: `unknown change type: ${typeKey}` };
  if (fields && typeof fields !== 'object') return { ok: false, error: 'fields must be an object' };

  const result = {};
  const errors = [];
  const provided = fields ?? {};

  for (const def of type.fields ?? []) {
    const v = provided[def.key];
    if (v == null || v === '') {
      if (def.required) errors.push(`${def.label || def.key} is required`);
      continue;
    }
    switch (def.type) {
      case 'string':
      case 'text':
        if (typeof v !== 'string') errors.push(`${def.key} must be a string`);
        else result[def.key] = v;
        break;
      case 'number': {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isNaN(n)) errors.push(`${def.key} must be a number`);
        else result[def.key] = n;
        break;
      }
      case 'select':
        if (!def.options?.includes(v)) errors.push(`${def.key} must be one of ${def.options?.join(', ')}`);
        else result[def.key] = v;
        break;
      case 'boolean':
        result[def.key] = Boolean(v);
        break;
      default:
        result[def.key] = v;
    }
  }

  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, fields: result };
}
