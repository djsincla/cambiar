import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import Markdown from '../components/Markdown.jsx';

export default function ReleaseNotes() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['release-notes'],
    queryFn: () => api.get('/api/release-notes'),
  });

  return (
    <>
      <h1>Release notes</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        What shipped recently. Sourced from <code>CHANGELOG.md</code> in the deployment.
      </div>
      {isLoading && <div className="muted">Loading…</div>}
      {error && <div className="error">{error.message}</div>}
      {data && (
        <div className="panel">
          <Markdown source={data.content} />
        </div>
      )}
    </>
  );
}
