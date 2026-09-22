export type AiNetworkChannel = 'main_model' | 'cloud_tool';
export type AiNetworkStatus = 'attempted' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export type AiNetworkTransport = 'not_sent' | 'confirmed' | 'unknown';

export interface AiNetworkTraceEvent {
  type: 'network_request';
  channel: AiNetworkChannel;
  route: 'local' | 'cloud';
  provider: string;
  model?: string;
  requestId: string;
  status: AiNetworkStatus;
  outbound: boolean;
  /** Explicit terminal transport state; unknown is not equivalent to not sent. */
  transport?: AiNetworkTransport;
  /** @deprecated Use transport. Kept for persisted traces and older sessions. */
  transported?: boolean;
  target?: string;
  auditRecorded?: boolean;
  error?: string;
}

export type AiNetworkTraceSink = (event: AiNetworkTraceEvent) => void;
