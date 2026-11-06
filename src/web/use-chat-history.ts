import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from './api';

export interface ChatRow { readonly id: string; readonly title: string; readonly updatedAt: number; }

export function useChatHistory(projectId: string) {
  const [chats, setChats] = useState<ChatRow[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loading = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (nextCursor: string | null): Promise<void> => {
    if (loading.current) return;
    loading.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError('');
    try {
      const data = await apiJson<{ chats: ChatRow[]; nextCursor: string | null }>(
        '/api/projects/' + encodeURIComponent(projectId) + '/chats' + (nextCursor ? '?cursor=' + encodeURIComponent(nextCursor) : ''),
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      // Creation can complete while the first page is in flight. Retain that row
      // ahead of the older snapshot, just as later pages retain loaded history.
      setChats((current) => [...(current ?? []), ...data.chats.filter((chat) => !current?.some((known) => known.id === chat.id))]);
      setCursor(data.nextCursor);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Could not load chat history.');
    } finally {
      if (!abort.signal.aborted) { loading.current = false; setBusy(false); }
    }
  }, [projectId]);

  useEffect(() => {
    setChats(undefined); setCursor(null); setError('');
    void load(null);
    return () => { loading.current = false; controller.current?.abort(); };
  }, [load]);

  return { chats, cursor, busy, error, loadMore: () => load(cursor),
    addChat: (chat: ChatRow) => setChats((current) => [chat, ...(current ?? []).filter((known) => known.id !== chat.id)]) };
}
