// Nodes: teammates' machines that lend the office their compute (see docs/nodes.md).

export interface NodeStats {
  cores: number;
  /** One-minute load average. */
  load: number;
  memTotal: number;
  memFree: number;
  /** Workers running there now. */
  workers: number;
  /** The most it takes (agent-office node --max-workers), if it set one. */
  maxWorkers?: number;
}

export interface NodeView {
  name: string;
  online: boolean;
  stats?: NodeStats;
}

export type NodesServerMsg = { t: 'nodes'; nodes: NodeView[] };
