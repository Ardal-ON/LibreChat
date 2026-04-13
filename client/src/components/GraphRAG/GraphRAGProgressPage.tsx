import { useEffect, useMemo, useRef, useState } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  ResizableHandleAlt,
  ResizablePanel,
  ResizablePanelGroup,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@librechat/client';

const CHAT_GRAPH_PAYLOAD_KEY = 'graphrag:chat:latestPayload';

type GraphNode = {
  id: string;
  label: string;
  type: string;
  score: number | null;
  source_docs: string[];
  attributes: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number | null;
  attributes: Record<string, unknown>;
};

type Citation = {
  file_id: string;
  filename: string;
  chunk_index: number;
  score: number;
  content: string;
  entities?: string[];
};

type QueryToolResponse = {
  graph: {
    contract: {
      name: string;
      version: string;
    };
    query: string;
    filters: {
      file_ids: string[];
    };
    subgraph: {
      nodes: GraphNode[];
      edges: GraphEdge[];
    };
    meta: {
      generated_at: number;
      node_count: number;
      edge_count: number;
      truncated: boolean;
      max_nodes: number | null;
    };
    validation?: {
      valid: boolean;
      errors: string[];
    };
  };
  results: Citation[];
  controls?: {
    top_k: number;
    min_score: number;
    max_nodes: number;
  };
};

const SAMPLE_RESPONSE: QueryToolResponse = {
  graph: {
    contract: {
      name: 'semaa.graphrag.graph',
      version: '1.0.0',
    },
    query: 'Which contract is referenced in the emergency response protocol and what is the SLA?',
    filters: {
      file_ids: ['semaa-erp-008', 'semaa-contract-088'],
    },
    subgraph: {
      nodes: [
        {
          id: 'doc:semaa-erp-008',
          label: '08_emergency_response_protocol.txt',
          type: 'document',
          score: null,
          source_docs: ['semaa-erp-008'],
          attributes: { file_id: 'semaa-erp-008' },
        },
        {
          id: 'doc:semaa-contract-088',
          label: '03_supplier_contract.txt',
          type: 'document',
          score: null,
          source_docs: ['semaa-contract-088'],
          attributes: { file_id: 'semaa-contract-088' },
        },
        {
          id: 'chunk:semaa-erp-008::1',
          label: 'Chunk 1',
          type: 'chunk',
          score: 0.466667,
          source_docs: ['semaa-erp-008'],
          attributes: { file_id: 'semaa-erp-008', chunk_index: 1 },
        },
        {
          id: 'chunk:semaa-contract-088::0',
          label: 'Chunk 0',
          type: 'chunk',
          score: 0.43,
          source_docs: ['semaa-contract-088'],
          attributes: { file_id: 'semaa-contract-088', chunk_index: 0 },
        },
        {
          id: 'entity:sc-88',
          label: 'SC-88',
          type: 'entity',
          score: 0.46,
          source_docs: ['semaa-erp-008', 'semaa-contract-088'],
          attributes: {},
        },
        {
          id: 'entity:ocean_core_parts_ltd',
          label: 'OceanCore Parts Ltd.',
          type: 'entity',
          score: 0.45,
          source_docs: ['semaa-erp-008', 'semaa-contract-088'],
          attributes: {},
        },
      ],
      edges: [
        {
          id: 'edge:contains:doc:semaa-erp-008:chunk:semaa-erp-008::1',
          source: 'doc:semaa-erp-008',
          target: 'chunk:semaa-erp-008::1',
          relation: 'contains',
          weight: 1,
          attributes: {},
        },
        {
          id: 'edge:contains:doc:semaa-contract-088:chunk:semaa-contract-088::0',
          source: 'doc:semaa-contract-088',
          target: 'chunk:semaa-contract-088::0',
          relation: 'contains',
          weight: 1,
          attributes: {},
        },
        {
          id: 'edge:mentions:chunk:semaa-erp-008::1:entity:sc-88',
          source: 'chunk:semaa-erp-008::1',
          target: 'entity:sc-88',
          relation: 'mentions',
          weight: 1,
          attributes: {},
        },
        {
          id: 'edge:mentions:chunk:semaa-contract-088::0:entity:sc-88',
          source: 'chunk:semaa-contract-088::0',
          target: 'entity:sc-88',
          relation: 'mentions',
          weight: 1,
          attributes: {},
        },
      ],
    },
    meta: {
      generated_at: Date.now(),
      node_count: 6,
      edge_count: 4,
      truncated: false,
      max_nodes: 60,
    },
    validation: {
      valid: true,
      errors: [],
    },
  },
  results: [
    {
      file_id: 'semaa-erp-008',
      filename: '08_emergency_response_protocol.txt',
      chunk_index: 1,
      score: 0.466667,
      content:
        'Ensure spare inventory is maintained per supplier contract SC-88 with OceanCore Parts Ltd.',
      entities: ['SC-88', 'OceanCore Parts Ltd.'],
    },
  ],
  controls: {
    top_k: 5,
    min_score: 0.45,
    max_nodes: 60,
  },
};

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
    if (raw.length === 0) {
      return null;
    }

    const first = raw[0];
    if (typeof first === 'string') {
      return extractJsonCandidate(first);
    }
    if (first && typeof first === 'object' && 'text' in (first as Record<string, unknown>)) {
      return extractJsonCandidate((first as { text?: unknown }).text);
    }
    return extractJsonCandidate(first);
  }

  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;

    if (obj.graph && typeof obj.graph === 'object') {
      return obj;
    }

    if (obj.result !== undefined) {
      return extractJsonCandidate(obj.result);
    }

    if (obj.content !== undefined) {
      return extractJsonCandidate(obj.content);
    }

    if (obj.text !== undefined) {
      return extractJsonCandidate(obj.text);
    }

    // LangChain serialized message shape, e.g. { lc, type: 'constructor', id, kwargs: { content } }
    if (obj.kwargs !== undefined) {
      return extractJsonCandidate(obj.kwargs);
    }

    if (obj.data !== undefined) {
      return extractJsonCandidate(obj.data);
    }
  }

  return raw;
}

function parseToolResultBody(raw: unknown): QueryToolResponse | null {
  if (!raw) {
    return null;
  }

  const candidate = extractJsonCandidate(raw);

  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const parsed = candidate as Partial<QueryToolResponse> & {
    graph?: QueryToolResponse['graph'];
    results?: QueryToolResponse['results'];
  };

  if (!parsed.graph?.subgraph?.nodes || !parsed.graph?.subgraph?.edges) {
    return null;
  }

  return {
    graph: parsed.graph,
    results: Array.isArray(parsed.results) ? parsed.results : [],
    controls: parsed.controls,
  };
}

function parseRawJsonInput(raw: string): QueryToolResponse | null {
  try {
    const parsed = JSON.parse(raw);
    return parseToolResultBody(parsed);
  } catch {
    return null;
  }
}

const DEFAULT_HIDDEN_RELATIONS = new Set(['contains', 'mentions']);

export function GraphRAGProgressPage() {
  const cyRef = useRef<unknown>(null);
  const [response, setResponse] = useState<QueryToolResponse>(SAMPLE_RESPONSE);

  const [activeTab, setActiveTab] = useState<'graph' | 'text'>('graph');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const [fileFilter, setFileFilter] = useState<string[]>([]);
  const [relationFilter, setRelationFilter] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_GRAPH_PAYLOAD_KEY);
      if (!raw) {
        return;
      }

      const parsedRaw = JSON.parse(raw);
      const normalized = parseToolResultBody(parsedRaw);
      if (!normalized) {
        return;
      }

      setResponse(normalized);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    } catch {
      // Ignore malformed handoff payloads.
    }
  }, []);

  const fileOptions = useMemo(() => {
    const labelByFileId = new Map<string, string>();

    response.graph.subgraph.nodes.forEach((node) => {
      node.source_docs.forEach((docId) => {
        if (!labelByFileId.has(docId)) {
          labelByFileId.set(docId, docId);
        }
      });

      if (node.type !== 'document') {
        return;
      }

      const fileIdFromAttrs =
        typeof node.attributes?.file_id === 'string' ? (node.attributes.file_id as string) : null;
      const fileId = fileIdFromAttrs ?? node.source_docs[0] ?? null;

      if (fileId && node.label) {
        labelByFileId.set(fileId, node.label);
      }
    });

    response.results.forEach((item) => {
      if (!item?.file_id) {
        return;
      }
      if (!labelByFileId.has(item.file_id) || labelByFileId.get(item.file_id) === item.file_id) {
        labelByFileId.set(item.file_id, item.filename || item.file_id);
      }
    });

    return Array.from(labelByFileId.entries())
      .map(([fileId, label]) => ({ fileId, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [response.graph.subgraph.nodes, response.results]);

  const allRelations = useMemo(
    () =>
      Array.from(
        new Set(response.graph.subgraph.edges.map((edge) => edge.relation).filter(Boolean)),
      ),
    [response.graph.subgraph.edges],
  );

  useEffect(() => {
    setRelationFilter((current) => {
      const next = current.filter((relation) => allRelations.includes(relation));
      if (next.length > 0) {
        return next;
      }
      return allRelations.filter(
        (relation) => !DEFAULT_HIDDEN_RELATIONS.has((relation ?? '').toLowerCase()),
      );
    });
  }, [allRelations]);

  const filtered = useMemo(() => {
    const nodes = response.graph.subgraph.nodes.filter((node) => {
      if (fileFilter.length > 0 && !node.source_docs.some((doc) => fileFilter.includes(doc))) {
        return false;
      }
      return true;
    });

    const nodeIds = new Set(nodes.map((node) => node.id));

    const edges = response.graph.subgraph.edges.filter((edge) => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        return false;
      }
      if (relationFilter.length > 0 && !relationFilter.includes(edge.relation)) {
        return false;
      }
      return true;
    });

    const connectedNodeIds = new Set<string>();
    edges.forEach((edge) => {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    });

    const connectedNodes = nodes.filter(
      (node) => connectedNodeIds.has(node.id) || node.type === 'document',
    );

    return { nodes: connectedNodes, edges };
  }, [fileFilter, relationFilter, response.graph.subgraph.edges, response.graph.subgraph.nodes]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    filtered.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [filtered.nodes]);

  const edgeMap = useMemo(() => {
    const map = new Map<string, GraphEdge>();
    filtered.edges.forEach((edge) => map.set(edge.id, edge));
    return map;
  }, [filtered.edges]);

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? edgeMap.get(selectedEdgeId) ?? null : null;

  const adjacentEdgeIds = useMemo(() => {
    if (!selectedNodeId) {
      return new Set<string>();
    }
    return new Set(
      filtered.edges
        .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
        .map((edge) => edge.id),
    );
  }, [filtered.edges, selectedNodeId]);

  const adjacentNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedNodeId) {
      return ids;
    }
    ids.add(selectedNodeId);
    filtered.edges.forEach((edge) => {
      if (edge.source === selectedNodeId) {
        ids.add(edge.target);
      }
      if (edge.target === selectedNodeId) {
        ids.add(edge.source);
      }
    });
    return ids;
  }, [filtered.edges, selectedNodeId]);

  const cyElements = useMemo(() => {
    const nodes = filtered.nodes.map((node) => {
      const classes = [node.type];
      if (selectedNodeId && node.id === selectedNodeId) {
        classes.push('selected-node');
      } else if (adjacentNodeIds.has(node.id)) {
        classes.push('adjacent-node');
      }

      return {
        data: {
          id: node.id,
          label: node.label,
          type: node.type,
        },
        classes: classes.join(' '),
      };
    });

    const edges = filtered.edges.map((edge) => {
      const classes = ['relation'];
      if (selectedEdgeId && edge.id === selectedEdgeId) {
        classes.push('selected-edge');
      } else if (adjacentEdgeIds.has(edge.id)) {
        classes.push('adjacent-edge');
      }

      return {
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.relation,
          relation: edge.relation,
        },
        classes: classes.join(' '),
      };
    });

    return [...nodes, ...edges];
  }, [adjacentEdgeIds, adjacentNodeIds, filtered.edges, filtered.nodes, selectedEdgeId, selectedNodeId]);

  const toggleFileFilter = (fileId: string) => {
    setFileFilter((prev) =>
      prev.includes(fileId) ? prev.filter((item) => item !== fileId) : [...prev, fileId],
    );
  };

  const toggleRelationFilter = (relation: string) => {
    setRelationFilter((prev) =>
      prev.includes(relation) ? prev.filter((item) => item !== relation) : [...prev, relation],
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-surface-primary text-text-primary">
      <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
        <ResizablePanel id="gr-left" defaultSize="24" minSize="18" maxSize="34">
          <div className="flex h-full flex-col border-r border-border-medium p-4">
            <h2 className="text-base font-semibold">Filters</h2>

            <div className="mt-3 overflow-y-auto pr-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                File Filter
              </h3>
              <div className="mt-2 space-y-1">
                {fileOptions.map((option) => (
                  <label key={option.fileId} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={fileFilter.includes(option.fileId)}
                      onChange={() => toggleFileFilter(option.fileId)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>

              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Relation Filter
              </h3>
              <div className="mt-2 space-y-1">
                {allRelations.map((relation) => (
                  <label key={relation} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={relationFilter.includes(relation)}
                      onChange={() => toggleRelationFilter(relation)}
                    />
                    {relation}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandleAlt withHandle className="bg-border-medium" />

        <ResizablePanel id="gr-center" defaultSize="46" minSize="35">
          <div className="flex h-full flex-col p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Graph Canvas</h2>
              <div className="flex items-center gap-2">
                <div className="text-xs text-text-secondary">
                  Nodes: {filtered.nodes.length} | Edges: {filtered.edges.length}
                </div>
                <button
                  onClick={() => (cyRef.current as any)?.fit(undefined, 40)}
                  className="rounded border border-border-medium bg-surface-secondary px-2 py-1 text-xs hover:bg-surface-tertiary"
                >
                  Fit
                </button>
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'graph' | 'text')}>
              <TabsList className="mb-2 w-fit border border-border-medium bg-surface-secondary p-1">
                <TabsTrigger value="graph">Graph</TabsTrigger>
                <TabsTrigger value="text">Text</TabsTrigger>
              </TabsList>

              <TabsContent
                value="graph"
                className="relative mt-0 h-[calc(100vh-220px)] overflow-hidden rounded-md border border-border-medium p-0"
                style={{ background: '#1a1527' }}
              >
                <CytoscapeComponent
                  key={`cy-${filtered.nodes.length}-${filtered.edges.length}`}
                  elements={cyElements as never[]}
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
                        'font-size': 11,
                        'font-weight': 'bold',
                        'text-wrap': 'ellipsis',
                        'text-max-width': 80,
                        'text-valign': 'center',
                        'text-halign': 'center',
                        color: '#ffffff',
                        'background-color': '#569480',
                        'border-width': 0,
                        width: 56,
                        height: 56,
                        shape: 'ellipse',
                      },
                    },
                    {
                      selector: 'node.document',
                      style: {
                        'background-color': '#4C8EDA',
                        width: 84,
                        height: 84,
                        'font-size': 11,
                        'text-max-width': 75,
                      },
                    },
                    {
                      selector: 'node.chunk',
                      style: {
                        'background-color': '#C879A0',
                        width: 64,
                        height: 64,
                      },
                    },
                    {
                      selector: 'node.entity',
                      style: {
                        'background-color': '#F0A840',
                        width: 56,
                        height: 56,
                      },
                    },
                    {
                      selector: 'edge',
                      style: {
                        width: 1.5,
                        'line-color': '#6e7f8d',
                        'target-arrow-color': '#6e7f8d',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        label: 'data(label)',
                        'font-size': 9,
                        color: '#a8b8c4',
                        'text-background-color': '#1a1527',
                        'text-background-opacity': 0.85,
                        'text-background-padding': 2,
                      },
                    },
                    {
                      selector: '.adjacent-node',
                      style: {
                        'border-width': 3,
                        'border-color': '#4DD0E1',
                      },
                    },
                    {
                      selector: '.selected-node',
                      style: {
                        'border-width': 4,
                        'border-color': '#FFD700',
                      },
                    },
                    {
                      selector: '.adjacent-edge',
                      style: {
                        width: 2.5,
                        'line-color': '#4DD0E1',
                        'target-arrow-color': '#4DD0E1',
                      },
                    },
                    {
                      selector: '.selected-edge',
                      style: {
                        width: 3,
                        'line-color': '#FFD700',
                        'target-arrow-color': '#FFD700',
                      },
                    },
                  ]}
                  layout={{
                    name: 'cose',
                    animate: false,
                    fit: true,
                    padding: 50,
                    randomize: true,
                    componentSpacing: 100,
                    nodeRepulsion: 450000,
                    nodeOverlap: 20,
                    idealEdgeLength: 100,
                    edgeElasticity: 100,
                    nestingFactor: 5,
                    gravity: 80,
                    numIter: 1000,
                    initialTemp: 200,
                    coolingFactor: 0.95,
                    minTemp: 1.0,
                  }}
                />
                <div
                  className="pointer-events-none absolute bottom-3 left-3 z-10 flex gap-3 rounded-lg px-3 py-2 text-xs text-white"
                  style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ background: '#4C8EDA' }} />
                    Document
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ background: '#C879A0' }} />
                    Chunk
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ background: '#F0A840' }} />
                    Entity
                  </span>
                </div>
              </TabsContent>

              <TabsContent value="text" className="mt-0 h-[calc(100vh-220px)] overflow-y-auto rounded-md border border-border-medium bg-surface-secondary p-3">
                <div className="space-y-3">
                  {response.results.length === 0 ? (
                    <p className="text-sm text-text-secondary">No snippets available in this response.</p>
                  ) : (
                    response.results.map((result) => {
                      const citationId = `citation-${result.file_id}-${result.chunk_index}`;
                      return (
                        <div key={citationId} className="rounded-md border border-border-medium bg-white p-3">
                          <div className="text-xs font-semibold">
                            {result.file_id} | chunk {result.chunk_index} | score {result.score.toFixed(3)}
                          </div>
                          <p className="mt-1 text-sm">{result.content}</p>
                          <div className="mt-2 flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedNodeId(`chunk:${result.file_id}::${result.chunk_index}`)}
                            >
                              Highlight chunk node
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const target = document.getElementById(citationId);
                                target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                              }}
                            >
                              Jump to citation details
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </ResizablePanel>

        <ResizableHandleAlt withHandle className="bg-border-medium" />

        <ResizablePanel id="gr-right" defaultSize="30" minSize="22" maxSize="40">
          <div className="flex h-full flex-col border-l border-border-medium p-4">
            <h2 className="text-base font-semibold">Node Details + Sources</h2>

            <div className="mt-3 rounded-md border border-border-medium bg-surface-secondary p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Selected Node
              </h3>
              {selectedNode ? (
                <div className="mt-2 text-sm">
                  <div className="font-semibold">{selectedNode.label}</div>
                  <div className="mt-1 text-xs text-text-secondary">{selectedNode.id}</div>
                  <div className="mt-1 text-xs">Type: {selectedNode.type}</div>
                  <div className="mt-1 text-xs">Source docs: {selectedNode.source_docs.join(', ') || 'n/a'}</div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-text-secondary">Click a graph node.</p>
              )}
            </div>

            <div className="mt-3 rounded-md border border-border-medium bg-surface-secondary p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Selected Edge
              </h3>
              {selectedEdge ? (
                <div className="mt-2 text-sm">
                  <div className="font-semibold">{selectedEdge.relation}</div>
                  <div className="mt-1 text-xs text-text-secondary">
                    {selectedEdge.source} {'->'} {selectedEdge.target}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-text-secondary">Click an edge for relation details.</p>
              )}
            </div>

            <Accordion type="single" collapsible className="mt-3 overflow-y-auto">
              <AccordionItem value="citations">
                <AccordionTrigger className="text-sm font-semibold">Citation Panel</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2">
                    {response.results.map((item) => {
                      const id = `citation-${item.file_id}-${item.chunk_index}`;
                      return (
                        <div id={id} key={id} className="rounded-md border border-border-medium bg-white p-2 text-xs">
                          <div className="font-semibold">{item.file_id}</div>
                          <div className="text-text-secondary">
                            {item.filename} | chunk {item.chunk_index}
                          </div>
                          <p className="mt-1 line-clamp-4">{item.content}</p>
                        </div>
                      );
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-3 rounded-md border border-border-medium bg-surface-secondary p-3 text-xs text-text-secondary">
              Contract: {response.graph.contract.name}@{response.graph.contract.version}
              <br />
              Validation: {response.graph.validation?.valid ? 'valid' : 'invalid'}
              <br />
              Meta: {response.graph.meta.node_count} nodes / {response.graph.meta.edge_count} edges
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
