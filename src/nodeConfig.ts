export type IdentityRole = 'writer' | 'confirmer-b' | 'confirmer-c';

export interface NodeConfig {
  port: number;
  /**
   * A local file path, or a `gs://bucket/object.jsonl` URI — see src/log.ts and
   * src/gcsLogStore.ts. Each node is expected to own its own path/object; pointing two
   * nodes at the same one turns this from "N independently-verified replicas" into a
   * single shared store with N API fronts, which is a different trust model.
   */
  logPath: string;
  /** Base URLs of other nodes to sync with, e.g. "http://localhost:4002". */
  peers: string[];
  /**
   * The signing identity this node acts as. Omit for a read-only relay node —
   * it still validates, stores, and forwards lines, but can't produce new ones.
   */
  identityRole?: IdentityRole;
  /** How often to pull from peers, in ms. Defaults to 2000. */
  syncIntervalMs?: number;
}
