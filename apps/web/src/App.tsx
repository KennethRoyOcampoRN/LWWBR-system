import { useEffect, useState } from 'react';

interface HealthResponse {
  status: string;
  region: string;
  adapters: { realtime: string; storage: string };
}

// M0 scaffold only — confirms the web app can reach the api. Role-scoped
// dashboards and the Command Center land in M2+ per spec §11.
export function App() {
  const [health, setHealth] = useState<HealthResponse | 'loading' | 'error'>('loading');

  useEffect(() => {
    fetch('/api/v1/health')
      .then((res) => res.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch(() => setHealth('error'));
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Lucky Waku-Waku Resort — Command Center</h1>
      {health === 'loading' && <p>Checking API…</p>}
      {health === 'error' && <p role="alert">Could not reach the API.</p>}
      {typeof health === 'object' && (
        <dl className="text-sm">
          <dt className="font-medium">Status</dt>
          <dd data-testid="health-status">{health.status}</dd>
          <dt className="mt-2 font-medium">Region</dt>
          <dd>{health.region}</dd>
          <dt className="mt-2 font-medium">Adapters</dt>
          <dd>
            realtime: {health.adapters.realtime}, storage: {health.adapters.storage}
          </dd>
        </dl>
      )}
    </main>
  );
}
