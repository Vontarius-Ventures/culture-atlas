import type { Metadata } from 'next';
import { TastePicksView } from '@/components/onboarding/TastePicksView';

export const metadata: Metadata = { title: 'Pick what catches your eye' };

/** Screen 14 (spec amendment 2.2): the sign-up taste questionnaire. */
export default function WelcomeTastePage() {
  return <TastePicksView />;
}
