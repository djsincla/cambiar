export default function FieldInput({ field, value, onChange }) {
  const v = value ?? '';
  const aria = field.label;
  switch (field.type) {
    case 'text':
      return <textarea aria-label={aria} value={v} onChange={e => onChange(e.target.value)} required={field.required} />;
    case 'number':
      return <input aria-label={aria} type="number" value={v} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} required={field.required} />;
    case 'select':
      return (
        <select aria-label={aria} value={v} onChange={e => onChange(e.target.value)} required={field.required}>
          <option value="">— select —</option>
          {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'boolean':
      return <input aria-label={aria} type="checkbox" checked={Boolean(v)} onChange={e => onChange(e.target.checked)} style={{ width: 'auto' }} />;
    case 'string':
    default:
      return <input aria-label={aria} value={v} onChange={e => onChange(e.target.value)} required={field.required} />;
  }
}
