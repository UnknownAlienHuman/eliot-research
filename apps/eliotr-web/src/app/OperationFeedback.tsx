import { OperationAnnouncement } from '@eliotr/ui';
import { usePaneAnnouncement } from './usePaneAnnouncement';

/** Mount only while the operation surface is exposed. Cached facts start quiet on reopen. */
export function OperationFeedback({ message }: { readonly message: string }) {
  const announcement = usePaneAnnouncement(message);
  return <OperationAnnouncement>{announcement}</OperationAnnouncement>;
}
