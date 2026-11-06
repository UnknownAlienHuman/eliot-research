import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Source } from "../shared/api";
import { apiJson } from "./api";

export function LibraryPicker({ projectId, onAttach, onClose }: {
  readonly projectId: string;
  readonly onAttach: (sourceId: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const client = useQueryClient();
  const queryKey = ["available-sources", projectId];
  const [busy, setBusy] = useState("");
  const [attached, setAttached] = useState<ReadonlySet<string>>(new Set());
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiJson<{ sources: Source[]; nextCursor: string | null }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/sources/available"
      + (pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""), { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: Infinity,
    gcTime: 0,
  });
  const sources = query.data?.pages.flatMap(page => page.sources);
  const more = () => { if (!query.isFetching) void query.fetchNextPage({ cancelRefetch: false }); };
  async function attach(id: string) {
    if (busy) return;
    setBusy(id);
    try { if (await onAttach(id)) setAttached(previous => new Set([...previous, id])); }
    finally { setBusy(""); }
  }
  return <section aria-label="From Library" aria-busy={query.isFetching}>
    <h3>From Library</h3>
    <p className="er-lib__hint">Reuse a saved source without uploading or analyzing it again. Refresh to include Library changes.</p>
    <button className="er-button er-button--text" type="button"
      onClick={() => void client.resetQueries({ queryKey, exact: true })}>Refresh Library</button>
    {query.error ? <p className="er-lib__error" role="alert">{query.error.message} <button className="er-button er-button--text" type="button"
      disabled={query.isFetching} onClick={() => query.isFetchNextPageError ? more() : void query.refetch()}>Retry Library</button></p> : null}
    {sources === undefined ? query.error ? null : <p className="er-lib__hint" role="status">Loading Library.</p>
      : sources.length === 0 ? <p className="er-lib__hint">No other active sources in the Library.</p>
      : <ul className="er-lib__list">{sources.map(source => <li className="er-lib__row" key={source.id}>
        <span className="er-lib__row-main"><span><span className="er-lib__row-title">{source.title}</span>
          <span className="er-lib__row-meta">{source.currentRevisionId ? "Readable" : "Not readable yet"}</span></span></span>
        {attached.has(source.id) ? <span className="er-lib__actions"><span role="status">Added to this project</span>
          <Link className="er-button er-button--text" onClick={onClose} aria-label={"Open " + source.title}
            to={"/p/" + encodeURIComponent(projectId) + "/source/" + encodeURIComponent(source.id) + "?revisionId=" + encodeURIComponent(source.currentRevisionId ?? source.revisionId)}>Open source</Link></span>
          : <button className="er-button er-button--tonal" type="button" aria-label={"Attach " + source.title}
            disabled={busy !== ""} onClick={() => void attach(source.id)}>{busy === source.id ? "Attaching…" : "Attach"}</button>}
      </li>)}</ul>}
    {query.hasNextPage ? <button className="er-button er-button--text" type="button" disabled={query.isFetching} onClick={more}>
      {query.isFetchingNextPage ? "Loading Library." : "Load more Library sources"}</button> : null}
  </section>;
}
