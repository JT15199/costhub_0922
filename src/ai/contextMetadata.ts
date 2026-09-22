export type DataSensitivity = 'public' | 'internal' | 'sensitive' | 'restricted' | 'unknown';
export type ContextPriority = 'critical' | 'high' | 'normal' | 'low';

export interface ContextMetadata {
  sourceType: string;
  sensitivity: DataSensitivity;
  cloudSafe: boolean;
  priority: ContextPriority;
  sourceIds: string[];
  /** Only trusted provenance or an explicit content review may set this. */
  verified?: boolean;
}
