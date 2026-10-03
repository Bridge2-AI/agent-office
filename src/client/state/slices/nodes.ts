import type { NodeView } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Teammates' machines lending the office their compute, the same on every floor (see docs/nodes.md). */
    nodes: NodeView[];
  }
  interface Topics {
    nodes: true;
  }
}

export const nodes: Slice = {
  init(s) {
    s.nodes = [];
  },
  on: {
    nodes(s, m) {
      s.nodes = m.nodes;
      return ['nodes'];
    },
  },
  enter(s, v) {
    s.nodes = v.nodes ?? [];
    return ['nodes'];
  },
};
