import type { Metadata } from 'next';
import { TasteSettingsView } from '@/components/onboarding/TasteSettingsView';

export const metadata: Metadata = { title: 'Taste' };

/** Screen 18 (spec amendment 2.2): Settings → Taste. */
export default function TasteSettingsPage() {
  return <TasteSettingsView />;
}
