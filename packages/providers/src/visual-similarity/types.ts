import type { GatewayOptions } from '../model-gateway/types';

/** Normalized coordinates in the auto-oriented source image. */
export interface VisualSimilarityRegion { x: number; y: number; w: number; h: number }
export interface VisualSimilarityRequest {
  sourceImage: Uint8Array;
  candidateImage: Uint8Array;
  sourceRegion: VisualSimilarityRegion;
  subjectLabel: string;
  candidateLabel: string;
}
export interface VisualSimilarityResult {
  sameObjectType: boolean;
  similarity: 'strong' | 'moderate' | 'weak' | 'none';
  matchedFeatures: string[];
  differences: string[];
  sourceImageSha256: string;
  candidateImageSha256: string;
  contactSheetSha256: string;
  sourceRegion: VisualSimilarityRegion;
  model: string;
  profileVersion: string;
  schemaVersion: string;
  experimental: boolean;
}
export interface VisualSimilarityProvider {
  isConfigured(): boolean;
  compare(input: VisualSimilarityRequest, options: GatewayOptions): Promise<VisualSimilarityResult>;
}
