import type { Metadata } from 'next';
import { UnavailableState } from '@/components/ui';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="page">
      <UnavailableState
        title="This page isn’t here."
        body="The link may be old, or the page was moved. Everything you saved is still in your collections."
        secondary={{ href: '/collections', label: 'Your collections' }}
      />
    </div>
  );
}
