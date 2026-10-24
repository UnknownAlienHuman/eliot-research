import { useQuery } from "@tanstack/react-query";

interface HealthResponse {
  service: string;
  status: "ok";
  architecture: string;
}

async function readHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Health request failed with ${response.status}.`);
  }
  return response.json<HealthResponse>();
}

const capabilities = [
  ["Library", "Projects, immutable source revisions and exact evidence"],
  ["Research", "Bounded chat, comparisons, audits and durable investigations"],
  ["Knowledge", "Distillation, Wiki history, Corpus Map and targeted revision"],
  ["Connections", "Explicit model and MCP status without hidden authority"],
] as const;

export function App(): React.JSX.Element {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: readHealth,
    retry: false,
    staleTime: 30_000,
  });

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Eliot Research · replacement</p>
        <h1>Research workspace</h1>
        <p className="lede">
          One Worker, one React application and explicit Cloudflare boundaries.
        </p>
        <div className="status" aria-live="polite">
          <span className={`status-dot status-dot--${health.data?.status ?? "pending"}`} />
          {health.isPending && "Checking Worker…"}
          {health.isError && "Worker unavailable"}
          {health.data && `${health.data.service} · ${health.data.architecture}`}
        </div>
      </header>

      <section className="capability-grid" aria-label="Replacement capabilities">
        {capabilities.map(([title, description]) => (
          <article className="capability" key={title}>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className="boundary">
        <h2>Stage 0 boundary</h2>
        <p>
          This shell proves the new root build and private Worker entrypoint. It does not read predecessor data,
          call models, mutate Cloudflare resources or claim migration completion.
        </p>
      </section>
    </main>
  );
}
