import type { Metadata } from 'next';
import { BuildingFeedView } from '@/components/onboarding/BuildingFeedView';

export const metadata: Metadata = { title: 'Building your feed' };

/** Screen 15 (spec amendment 2.2): progressive taste seed, then Discover. */
export default function WelcomeBuildingPage() {
  return <BuildingFeedView />;
}
