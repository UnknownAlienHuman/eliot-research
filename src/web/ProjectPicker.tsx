import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import type { Project } from '../shared/api';
import { apiJson } from './api';

export function ProjectPicker({ projectId }: { readonly projectId: string }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const location = useLocation();
  useEffect(() => { setOpen(false); dialog.current?.close(); }, [location.key]);
  function close() { setOpen(false); dialog.current?.close(); }
  return <>
    <button className='er-button er-button--text' type='button' aria-haspopup='dialog'
      onClick={() => { dialog.current?.showModal(); setOpen(true); }}>Switch project</button>
    <dialog ref={dialog} className='er-dialog' aria-labelledby={heading} onCancel={() => setOpen(false)}
      onClose={() => { if (!dialog.current?.open) setOpen(false); }}>
      <h2 className='er-dialog__title' id={heading}>Switch project</h2>
      <div className='er-dialog__body'>
        <button className='er-button er-button--text' type='button' autoFocus onClick={close}>Close project list</button>
        {open ? <ProjectList projectId={projectId} onSelect={close} /> : null}
      </div>
    </dialog>
  </>;
}

function ProjectList({ projectId, onSelect }: { readonly projectId: string; readonly onSelect: () => void }) {
  const client = useQueryClient();
  const queryKey = ['project-picker'];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiJson<{ projects: Project[]; nextCursor: string | null }>(
      '/api/projects' + (pageParam ? '?cursor=' + encodeURIComponent(pageParam) : ''), { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    gcTime: 0,
  });
  const projects = query.data?.pages.flatMap(page => page.projects);
  const more = () => { if (!query.isFetching) void query.fetchNextPage({ cancelRefetch: false }); };
  return <nav aria-label='Project list' aria-busy={query.isFetching}>
    <button className='er-button er-button--text' type='button' disabled={query.isFetching}
      onClick={() => void client.resetQueries({ queryKey, exact: true })}>Refresh projects</button>
    {query.error ? <p className='er-lib__error' role='alert'>{query.error.message}{' '}
      <button className='er-button er-button--text' type='button' disabled={query.isFetching}
        onClick={() => query.isFetchNextPageError ? more() : void query.refetch()}>Retry projects</button></p> : null}
    {projects === undefined ? query.error ? null : <p role='status'>Loading projects.</p>
      : projects.length === 0 ? <p>No active projects.</p>
      : <ul className='er-lib__list'>{projects.map(project => <li className='er-lib__row' key={project.id}>
        <Link className='er-lib__row-main er-lib__row-title' aria-current={project.id === projectId ? 'true' : undefined}
          to={'/p/' + encodeURIComponent(project.id) + '/chat'} onClick={onSelect}>{project.title}</Link>
        {project.id === projectId ? <span className='er-chip'>Current project</span> : null}
      </li>)}</ul>}
    {query.hasNextPage ? <button className='er-button er-button--text' type='button' disabled={query.isFetching} onClick={more}>
      {query.isFetchingNextPage ? 'Loading projects.' : 'Load more projects'}</button> : null}
  </nav>;
}
