import type { Metadata } from 'next';
import { AccountDeletionView } from '@/components/views/AccountDeletionView';

export const metadata: Metadata = { title: 'Delete account' };

/**
 * Settings → Your account → Delete account… (VAL-DELETE-001): the first-party
 * deletion entry. Owner-session authority (the web client adds the CSRF and
 * expected-account headers on the acceptance itself) and an honest
 * pending/failed/completed cleanup status afterwards.
 */
export default function AccountDeletionPage() {
  return <AccountDeletionView />;
}
