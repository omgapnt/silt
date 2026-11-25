export type Turn = {
  role: string;
  text: string;
};

export type Capture = {
  id: string;
  at: string;
  provider: string;
  host: string;
  method: string;
  path: string;
  status: number;
  model: string | null;
  latencyMs: number;
  streaming: boolean;
  requestMessages: Turn[];
  responseText: string;
  usage: { input: number | null; output: number | null } | null;
  bytesIn: number;
  bytesOut: number;
  secretsStripped: boolean;
};
