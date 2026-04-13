import { useMemo, useRef, useState } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';

type GraphNode = {
  id: string;
  label?: string;
  type?: string;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation?: string;
};

type GraphPayload = {
  graph_id?: string;
  graph: {
    subgraph: {
      nodes: GraphNode[];
      edges: GraphEdge[];
    };
    meta?: {
      node_count?: number;
      edge_count?: number;
    };
  };
  count?: number;
  controls?: {
    top_k?: number;
    min_score?: number;
    max_nodes?: number;
    auto_tuned?: boolean;
  };
};

export const CHAT_GRAPH_PAYLOAD_KEY = 'graphrag:chat:latestPayload';
export const CHAT_GRAPH_PAYLOAD_BY_ID_KEY = 'graphrag:chat:payloadById';

const DEFAULT_HIDDEN_RELATIONS = new Set(['contains', 'mentions']);

function isGraphPayload(raw: unknown): raw is GraphPayload {
  if (!raw || typeof raw !== 'object') {
    return false;
  }

  const payload = raw as GraphPayload;
  return (
    Array.isArray(payload.graph?.subgraph?.nodes) &&
    Array.isArray(payload.graph?.subgraph?.edges)
  );
}

function hashInput(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function getGraphPayloadCacheKey(input: string, toolName?: string): string {
  const tool = (toolName || 'unknown').trim();
  const normalizedInput = (input || '').trim();
  return `graphrag:chat:payload:${tool}:${hashInput(normalizedInput)}`;
}

export function saveGraphPayloadToCache(payload: GraphPayload, input: string, toolName?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const key = getGraphPayloadCacheKey(input, toolName);
  try {
    const serialized = JSON.stringify(payload);
    localStorage.setItem(key, serialized);
    localStorage.setItem(CHAT_GRAPH_PAYLOAD_KEY, serialized);
    if (payload.graph_id) {
      localStorage.setItem(`${CHAT_GRAPH_PAYLOAD_BY_ID_KEY}:${payload.graph_id}`, serialized);
    }
  } catch {
    return;
  }
}

export function loadGraphPayloadByGraphId(graphId: string): GraphPayload | null {
  if (typeof window === 'undefined' || !graphId) {
    return null;
  }

  try {
    const raw = localStorage.getItem(`${CHAT_GRAPH_PAYLOAD_BY_ID_KEY}:${graphId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return isGraphPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isSummarizedOutput(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('conversation summarized') || normalized.includes('summarized');
}

export function extractGraphIdFromText(text: string): string | null {
  if (!text) {
    return null;
  }

  const match = text.match(/\bgraph_id\s*[:=]\s*([a-z0-9_-]{8,64})\b/i);
  return match?.[1] ?? null;
}

export function loadGraphPayloadFromCache(
  input: string,
  toolName?: string,
  options?: { allowLatestFallback?: boolean },
): GraphPayload | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const tryParse = (raw: string | null): GraphPayload | null => {
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return isGraphPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const byInput = tryParse(localStorage.getItem(getGraphPayloadCacheKey(input, toolName)));
  if (byInput) {
    return byInput;
  }

  if (!options?.allowLatestFallback) {
    return null;
  }

  return tryParse(localStorage.getItem(CHAT_GRAPH_PAYLOAD_KEY));
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
  return trimmed;
}

function extractJsonCandidate(raw: unknown): unknown {
  if (raw == null) {
    return null;
  }

  if (typeof raw === 'string') {
    const cleaned = stripCodeFence(raw);
    try {
      return JSON.parse(cleaned);
    } catch {
      return raw;
    }
  }

  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first == null) {
      return null;
    }
    if (typeof first === 'object' && first !== null && 'text' in (first as Record<string, unknown>)) {
      return extractJsonCandidate((first as { text?: unknown }).text);
    }
    return extractJsonCandidate(first);
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.graph && typeof obj.graph === 'object') {
      return obj;
    }
    if (obj.result !== undefined) {
      return extractJsonCandidate(obj.result);
    }
    if (obj.kwargs !== undefined) {
      return extractJsonCandidate(obj.kwargs);
    }
    if (obj.content !== undefined) {
      return extractJsonCandidate(obj.content);
    }
    if (obj.data !== undefined) {
      return extractJsonCandidate(obj.data);
    }
  }

  return raw;
}

function extractObjectAfterKey(text: string, key: string): string | null {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex < 0) {
    return null;
  }

  const firstBrace = text.indexOf('{', keyIndex);
  if (firstBrace < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
}

export function extractGraphPayloadFromText(text: string): GraphPayload | null {
  if (!text || !text.trim()) {
    return null;
  }

  const parseObject = (raw: unknown): GraphPayload | null => {
    if (isGraphPayload(raw)) {
      return raw;
    }

    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const obj = raw as Record<string, unknown>;

    // Some tool outputs may return the graph object directly at top level.
    if (
      Array.isArray((obj as { subgraph?: { nodes?: unknown[]; edges?: unknown[] } }).subgraph?.nodes) &&
      Array.isArray((obj as { subgraph?: { nodes?: unknown[]; edges?: unknown[] } }).subgraph?.edges)
    ) {
      return {
        graph: obj as GraphPayload['graph'],
        controls: undefined,
      };
    }

    return null;
  };

  const candidate = extractJsonCandidate(text);
  const parsedCandidate = parseObject(candidate);
  if (parsedCandidate) {
    return parsedCandidate;
  }

  // Recovery path for malformed payloads where the overall JSON is broken,
  // but the graph object itself is still complete.
  const graphObjectText = extractObjectAfterKey(text, 'graph');
  if (graphObjectText) {
    try {
      const recoveredGraph = JSON.parse(graphObjectText) as GraphPayload['graph'];
      if (
        Array.isArray(recoveredGraph?.subgraph?.nodes) &&
        Array.isArray(recoveredGraph?.subgraph?.edges)
      ) {
        let controls: GraphPayload['controls'];
        const controlsText = extractObjectAfterKey(text, 'controls');
        if (controlsText) {
          try {
            controls = JSON.parse(controlsText) as GraphPayload['controls'];
          } catch {
            controls = undefined;
          }
        }

        return {
          graph: recoveredGraph,
          controls,
        };
      }
    } catch {
      // fallthrough
    }
  }

  // Fallback: recover JSON object from wrapped plain text.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybeJson = text.slice(firstBrace, lastBrace + 1);
    try {
      const recovered = JSON.parse(maybeJson);
      return parseObject(recovered);
    } catch {
      return null;
    }
  }

  return null;
}

function getVisibleGraph(payload: GraphPayload): GraphPayload['graph']['subgraph'] {
  const visibleEdges = payload.graph.subgraph.edges.filter(
    (edge) => !DEFAULT_HIDDEN_RELATIONS.has((edge.relation ?? '').toLowerCase()),
  );

  const connectedNodeIds = new Set<string>();
  for (const edge of visibleEdges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  const visibleNodes = payload.graph.subgraph.nodes.filter(
    (node) => connectedNodeIds.has(node.id) || node.type === 'document',
  );

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
  };
}

export default function GraphRAGOutput({ payload }: { payload: GraphPayload }) {
  const cyRef = useRef<unknown>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const visibleGraph = useMemo(() => getVisibleGraph(payload), [payload]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of visibleGraph.nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [visibleGraph.nodes]);

  const edgeMap = useMemo(() => {
    const map = new Map<string, GraphEdge>();
    for (const edge of visibleGraph.edges) {
      map.set(edge.id, edge);
    }
    return map;
  }, [visibleGraph.edges]);

  const adjacentNodeIds = useMemo(() => {
    if (!selectedNodeId) {
      return new Set<string>();
    }
    const ids = new Set<string>([selectedNodeId]);
    for (const edge of visibleGraph.edges) {
      if (edge.source === selectedNodeId) {
        ids.add(edge.target);
      }
      if (edge.target === selectedNodeId) {
        ids.add(edge.source);
      }
    }
    return ids;
  }, [selectedNodeId, visibleGraph.edges]);

  const adjacentEdgeIds = useMemo(() => {
    if (!selectedNodeId) {
      return new Set<string>();
    }
    const ids = new Set<string>();
    for (const edge of visibleGraph.edges) {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        ids.add(edge.id);
      }
    }
    return ids;
  }, [selectedNodeId, visibleGraph.edges]);

  const elements = useMemo(() => {
    const nodes = visibleGraph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label ?? node.id,
      },
      classes: [
        node.type ?? 'entity',
        selectedNodeId === node.id ? 'selected-node' : '',
        selectedNodeId && adjacentNodeIds.has(node.id) ? 'adjacent-node' : '',
      ]
        .filter(Boolean)
        .join(' '),
    }));

    const edges = visibleGraph.edges.map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.relation ?? '',
      },
      classes: [
        selectedEdgeId === edge.id ? 'selected-edge' : '',
        selectedNodeId && adjacentEdgeIds.has(edge.id) ? 'adjacent-edge' : '',
      ]
        .filter(Boolean)
        .join(' '),
    }));

    return [...nodes, ...edges];
  }, [
    adjacentEdgeIds,
    adjacentNodeIds,
    selectedEdgeId,
    selectedNodeId,
    visibleGraph.edges,
    visibleGraph.nodes,
  ]);

  const nodeCount = visibleGraph.nodes.length;
  const edgeCount = visibleGraph.edges.length;

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? edgeMap.get(selectedEdgeId) ?? null : null;

  const openFullGraph = () => {
    try {
      localStorage.setItem(CHAT_GRAPH_PAYLOAD_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage failures; page will still open without preloaded payload.
    }
    window.location.href = '/graphrag/progress?source=chat';
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border-light bg-surface-primary">
      <div className="flex items-center justify-between border-b border-border-light bg-surface-secondary px-3 py-2">
        <div className="text-xs font-semibold text-text-primary">Knowledge Graph</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-border-medium px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-tertiary"
            onClick={openFullGraph}
          >
            Open full graph
          </button>
          <span className="text-[11px] text-text-secondary">
            {nodeCount} nodes | {edgeCount} edges
          </span>
          <button
            type="button"
            className="rounded border border-border-medium px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-tertiary"
            onClick={() => (cyRef.current as { fit: (eles?: unknown, padding?: number) => void } | null)?.fit(undefined, 36)}
          >
            Fit
          </button>
        </div>
      </div>
      <div className="grid md:grid-cols-[minmax(0,1fr)_250px]">
        <div className="h-[360px]" style={{ background: '#1a1527' }}>
          <CytoscapeComponent
            elements={elements as never[]}
            style={{ width: '100%', height: '100%' }}
            cy={(cy) => {
              cyRef.current = cy;
              cy.on('tap', 'node', (event) => {
                const id = event.target.id();
                setSelectedNodeId(id);
                setSelectedEdgeId(null);
              });
              cy.on('tap', 'edge', (event) => {
                const id = event.target.id();
                setSelectedEdgeId(id);
                setSelectedNodeId(null);
              });
              cy.on('tap', (event) => {
                if (event.target === cy) {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(null);
                }
              });
            }}
            stylesheet={[
              {
                selector: 'node',
                style: {
                  label: 'data(label)',
                  'font-size': 10,
                  color: '#ffffff',
                  'text-wrap': 'ellipsis',
                  'text-max-width': 76,
                  'text-valign': 'center',
                  'text-halign': 'center',
                  'background-color': '#F0A840',
                  width: 54,
                  height: 54,
                  shape: 'ellipse',
                },
              },
              {
                selector: 'node.document',
                style: {
                  'background-color': '#4C8EDA',
                  width: 76,
                  height: 76,
                },
              },
              {
                selector: 'node.chunk',
                style: {
                  'background-color': '#C879A0',
                  width: 62,
                  height: 62,
                },
              },
              {
                selector: 'edge',
                style: {
                  width: 1.4,
                  'line-color': '#6e7f8d',
                  'target-arrow-color': '#6e7f8d',
                  'target-arrow-shape': 'triangle',
                  'curve-style': 'bezier',
                  label: 'data(label)',
                  'font-size': 8,
                  color: '#a8b8c4',
                  'text-background-color': '#1a1527',
                  'text-background-opacity': 0.85,
                  'text-background-padding': 2,
                },
              },
              {
                selector: '.adjacent-node',
                style: {
                  'border-width': 2,
                  'border-color': '#4DD0E1',
                },
              },
              {
                selector: '.selected-node',
                style: {
                  'border-width': 3,
                  'border-color': '#FFD700',
                },
              },
              {
                selector: '.adjacent-edge',
                style: {
                  width: 2.3,
                  'line-color': '#4DD0E1',
                  'target-arrow-color': '#4DD0E1',
                },
              },
              {
                selector: '.selected-edge',
                style: {
                  width: 2.8,
                  'line-color': '#FFD700',
                  'target-arrow-color': '#FFD700',
                },
              },
            ]}
            layout={{
              name: 'cose',
              animate: false,
              fit: true,
              padding: 36,
              randomize: true,
              nodeRepulsion: 360000,
              idealEdgeLength: 94,
              edgeElasticity: 100,
              gravity: 75,
              numIter: 800,
            }}
          />
        </div>
        <div className="border-t border-border-light bg-surface-secondary p-3 md:border-l md:border-t-0">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Details</h4>
          {selectedNode ? (
            <div className="mt-2 rounded border border-border-light bg-surface-primary p-2 text-xs">
              <div className="font-semibold text-text-primary">Node</div>
              <div className="mt-1 text-text-primary">{selectedNode.label ?? selectedNode.id}</div>
              <div className="mt-1 text-text-secondary">{selectedNode.id}</div>
              <div className="mt-1 text-text-secondary">Type: {selectedNode.type ?? 'entity'}</div>
            </div>
          ) : null}
          {selectedEdge ? (
            <div className="mt-2 rounded border border-border-light bg-surface-primary p-2 text-xs">
              <div className="font-semibold text-text-primary">Edge</div>
              <div className="mt-1 text-text-primary">{selectedEdge.relation ?? 'relation'}</div>
              <div className="mt-1 text-text-secondary">{selectedEdge.source} -&gt; {selectedEdge.target}</div>
            </div>
          ) : null}
          {!selectedNode && !selectedEdge ? (
            <p className="mt-2 text-xs text-text-secondary">Click a node or edge in the graph to inspect details.</p>
          ) : null}
        </div>
      </div>
      <div className="border-t border-border-light bg-surface-secondary px-3 py-1.5 text-[11px] text-text-secondary">
        top_k: {payload.controls?.top_k ?? '-'} | min_score: {payload.controls?.min_score ?? '-'} |
        max_nodes: {payload.controls?.max_nodes ?? '-'}
        {payload.controls?.auto_tuned ? ' | auto-tuned' : ''}
      </div>
    </div>
  );
}