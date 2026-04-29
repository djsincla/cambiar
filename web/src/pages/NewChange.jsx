import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import FieldInput from '../components/FieldInput.jsx';

export default function NewChange() {
  const nav = useNavigate();
  const { data: typesData } = useQuery({ queryKey: ['types'], queryFn: () => api.get('/api/change-types') });
  const types = typesData?.types ?? [];

  const [typeKey, setTypeKey] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [fields, setFields] = useState({});
  const [err, setErr] = useState(null);

  const type = types.find(t => t.key === typeKey);

  const create = useMutation({
    mutationFn: (body) => api.post('/api/changes', body),
    onSuccess: (d) => nav(`/changes/${d.change.id}`),
    onError: (e) => setErr(e.message),
  });

  const onSubmit = (e) => {
    e.preventDefault();
    setErr(null);
    create.mutate({
      typeKey,
      title,
      description: description || null,
      fields,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    });
  };

  return (
    <>
      <h1>New change</h1>
      <form className="panel" onSubmit={onSubmit}>
        <label>Change type<span className="req"> *</span></label>
        <select aria-label="Change type" value={typeKey} onChange={e => { setTypeKey(e.target.value); setFields({}); }} required>
          <option value="">— select —</option>
          {types.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
        {type && <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{type.description}</div>}

        <label>Title<span className="req"> *</span></label>
        <input aria-label="Title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={255} />

        <label>Description</label>
        <textarea aria-label="Description" value={description} onChange={e => setDescription(e.target.value)} />

        <label>Scheduled at</label>
        <input aria-label="Scheduled at" type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />

        {type && (
          <>
            <h2>{type.name} details</h2>
            {type.fields.map(f => (
              <div key={f.key}>
                <label>{f.label}{f.required && <span className="req"> *</span>}</label>
                <FieldInput field={f} value={fields[f.key]} onChange={(v) => setFields(s => ({ ...s, [f.key]: v }))} />
              </div>
            ))}
          </>
        )}

        {err && <div className="error">{err}</div>}
        <div style={{ marginTop: 16 }} className="row">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save as draft'}
          </button>
          <button type="button" className="secondary" onClick={() => nav(-1)}>Cancel</button>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Saved as draft. Submit for approval from the change page.
        </div>
      </form>
    </>
  );
}
