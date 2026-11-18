import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d';
import {
  AlertTriangle,
  ArrowRight,
  GitFork,
  Info,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';

type SupplierEdgeType =
  | 'SHARED_BANK'
  | 'SHARED_ADDRESS'
  | 'SHARED_PHONE'
  | 'SHARED_PAN_PATTERN';

interface SupplierGraphNode {
  id: number;
  supplierCode: string;
  name: string;
  gstin: string;
  pan: string;
  stateCode: string;
  maskedBankIdentifier: string;
  address: string;
  phone: string;
  gstFilingStatus: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore: number;
  activeInvoiceCount: number;
  openInvestigationsCount: number;
  isSampleData: boolean;
  x?: number;
  y?: number;
}

interface LinkedInvestigation {
  id: number;
  issueType: string;
  department: string;
  status: string;
  severity: string;
  assignedToName: string | null;
}

interface SupplierGraphEdge {
  id: string;
  source: number | SupplierGraphNode;
  target: number | SupplierGraphNode;
  type: SupplierEdgeType;
  sharedValue: string;
  reason: string;
  requiresVerification: true;
  linkedInvestigations: LinkedInvestigation[];
}

interface GraphApiResponse {
  isSampleData: true;
  disclaimer: string;
  nodes: SupplierGraphNode[];
  edges: SupplierGraphEdge[];
}

const NODE_COLORS: Record<string, string> = {
  CRITICAL: '#be123c',
  HIGH: '#e11d48',
  MEDIUM: '#d97706',
  LOW: '#059669',
};

const EDGE_COLORS: Record<SupplierEdgeType, string> = {
  SHARED_BANK: '#dc2626',
  SHARED_ADDRESS: '#d97706',
  SHARED_PHONE: '#2563eb',
  SHARED_PAN_PATTERN: '#7c3aed',
};

function resolveNodeId(ref: number | SupplierGraphNode | string | undefined): number | null {
  if (typeof ref === 'number') return ref;
  if (typeof ref === 'string') {
    const n = Number(ref);
    return Number.isNaN(n) ? null : n;
  }
  if (ref && typeof ref === 'object' && typeof ref.id === 'number') {
    return ref.id;
  }
  return null;
}

export function SupplierGraphPage() {
  const { apiFetch } = useAuth();
  const [graphResponse, setGraphResponse] = useState<GraphApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SupplierGraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<SupplierGraphEdge | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<SupplierGraphNode, SupplierGraphEdge> | undefined>(
    undefined
  );
  const [dimensions, setDimensions] = useState({ width: 680, height: 420 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 120) {
        setDimensions({
          width: Math.floor(rect.width),
          height: 430,
        });
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<GraphApiResponse>('/api/suppliers/graph');
      setGraphResponse(data);
      if (data.edges.length > 0) {
        setSelectedEdge(data.edges[0]);
        setSelectedNode(null);
      } else if (data.nodes.length > 0) {
        setSelectedNode(data.nodes[0]);
        setSelectedEdge(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier relationship graph.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const forceGraphData = useMemo(() => {
    if (!graphResponse) {
      return { nodes: [] as SupplierGraphNode[], links: [] as SupplierGraphEdge[] };
    }
    return {
      nodes: graphResponse.nodes.map((n) => ({ ...n })),
      links: graphResponse.edges.map((e) => ({ ...e })),
    };
  }, [graphResponse]);

  const nodeLookup = useMemo(() => {
    const map = new Map<number, SupplierGraphNode>();
    for (const n of graphResponse?.nodes || []) {
      map.set(n.id, n);
    }
    return map;
  }, [graphResponse]);

  const edgeInvestigationsForSelectedNode = useMemo(() => {
    if (!selectedNode || !graphResponse) return [];
    const seen = new Map<number, LinkedInvestigation>();
    for (const edge of graphResponse.edges) {
      const sId = resolveNodeId(edge.source);
      const tId = resolveNodeId(edge.target);
      if (sId === selectedNode.id || tId === selectedNode.id) {
        for (const inv of edge.linkedInvestigations) {
          seen.set(inv.id, inv);
        }
      }
    }
    return Array.from(seen.values());
  }, [selectedNode, graphResponse]);

  return (
    <div className="space-y-6">
      {/* Sample data & Relationship verification banner */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-900">
                Supplier Relationship Graph (Sample Data)
              </h2>
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                Sample data
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {graphResponse?.disclaimer ||
                'Shared attributes are indicators only — Relationship requires verification, never proof of fraud.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/suppliers"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              Supplier Scorecards
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={() => void loadGraph()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
            <span>
              <strong>Relationship requires verification:</strong> Shared bank accounts, addresses,
              or phone numbers are investigation indicators only — never proof of fraud.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-600" />
              HIGH Risk
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-600" />
              MEDIUM Risk
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
              LOW Risk
            </span>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 grid gap-6 lg:grid-cols-3">
          {/* Interactive Force Graph Canvas */}
          <div className="lg:col-span-2">
            <div
              ref={containerRef}
              className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
              style={{ height: 430 }}
            >
              {loading ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  Building supplier relationship graph from PostgreSQL...
                </div>
              ) : forceGraphData.nodes.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  No supplier nodes found.
                </div>
              ) : (
                <ForceGraph2D
                  ref={fgRef}
                  width={dimensions.width}
                  height={dimensions.height}
                  graphData={forceGraphData}
                  nodeId="id"
                  nodeRelSize={10}
                  linkWidth={(link) => (link.type === 'SHARED_BANK' ? 3.5 : 2)}
                  linkColor={(link) => EDGE_COLORS[link.type] || '#64748b'}
                  linkDirectionalParticles={(link) => (link.type === 'SHARED_BANK' ? 2 : 0)}
                  linkDirectionalParticleWidth={3}
                  onEngineStop={() => {
                    try {
                      fgRef.current?.zoomToFit(350, 60);
                    } catch {
                      // Ignore canvas zoom errors when unmounted
                    }
                  }}
                  onNodeClick={(node) => {
                    setSelectedNode(node as SupplierGraphNode);
                    setSelectedEdge(null);
                  }}
                  onLinkClick={(link) => {
                    setSelectedEdge(link as SupplierGraphEdge);
                    setSelectedNode(null);
                  }}
                  nodeCanvasObjectMode={() => 'replace'}
                  nodeCanvasObject={(node, ctx, globalScale) => {
                    const sup = node as SupplierGraphNode;
                    const x = sup.x || 0;
                    const y = sup.y || 0;
                    const radius = 10;
                    const color = NODE_COLORS[sup.riskLevel] || '#334155';
                    const isSelected = selectedNode?.id === sup.id;

                    ctx.beginPath();
                    ctx.arc(x, y, isSelected ? radius + 3 : radius, 0, 2 * Math.PI, false);
                    ctx.fillStyle = color;
                    ctx.fill();
                    if (isSelected) {
                      ctx.lineWidth = 2.5 / globalScale;
                      ctx.strokeStyle = '#0f172a';
                      ctx.stroke();
                    }

                    const fontSize = Math.max(10, 12 / globalScale);
                    ctx.font = `600 ${fontSize}px ui-monospace, monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillStyle = '#0f172a';
                    ctx.fillText(sup.supplierCode, x, y + radius + 3);

                    const shortName =
                      sup.name.length > 26 ? `${sup.name.slice(0, 24)}…` : sup.name;
                    ctx.font = `500 ${Math.max(8, fontSize * 0.85)}px sans-serif`;
                    ctx.fillStyle = '#475569';
                    ctx.fillText(shortName, x, y + radius + fontSize + 5);
                  }}
                  nodePointerAreaPaint={(node, color, ctx) => {
                    const x = (node.x as number) || 0;
                    const y = (node.y as number) || 0;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(x, y, 16, 0, 2 * Math.PI, false);
                    ctx.fill();
                  }}
                  linkCanvasObjectMode={() => 'after'}
                  linkCanvasObject={(link, ctx, globalScale) => {
                    const src = link.source as SupplierGraphNode | undefined;
                    const tgt = link.target as SupplierGraphNode | undefined;
                    if (!src || !tgt || src.x == null || src.y == null || tgt.x == null || tgt.y == null) {
                      return;
                    }
                    const midX = (src.x + tgt.x) / 2;
                    const midY = (src.y + tgt.y) / 2;
                    const label = `${link.type} (${link.sharedValue})`;
                    const fontSize = Math.max(8, 10 / globalScale);
                    ctx.font = `600 ${fontSize}px ui-monospace, monospace`;
                    const textWidth = ctx.measureText(label).width;

                    ctx.fillStyle = 'rgba(255,255,255,0.92)';
                    ctx.fillRect(
                      midX - textWidth / 2 - 4,
                      midY - fontSize / 2 - 2,
                      textWidth + 8,
                      fontSize + 4
                    );

                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = EDGE_COLORS[(link as SupplierGraphEdge).type] || '#334155';
                    ctx.fillText(label, midX, midY);
                  }}
                />
              )}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Click any supplier node or relationship edge above to inspect details, masked bank IDs, and linked investigations.
            </p>
          </div>

          {/* Selection Inspector Panel */}
          <aside className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            {selectedEdge ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <span className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-rose-800">
                      <GitFork className="h-3 w-3" aria-hidden="true" />
                      {selectedEdge.type}
                    </span>
                    <h3 className="mt-2 text-sm font-semibold text-slate-900">
                      Relationship Requires Verification
                    </h3>
                  </div>
                </div>

                <dl className="space-y-2 text-xs">
                  <div>
                    <dt className="text-slate-500">Connected Suppliers</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {nodeLookup.get(resolveNodeId(selectedEdge.source) || 0)?.name ||
                        `Supplier #${resolveNodeId(selectedEdge.source)}`}{' '}
                      ↔{' '}
                      {nodeLookup.get(resolveNodeId(selectedEdge.target) || 0)?.name ||
                        `Supplier #${resolveNodeId(selectedEdge.target)}`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Shared Attribute (Masked)</dt>
                    <dd className="mt-0.5 font-mono font-semibold text-slate-900">
                      {selectedEdge.sharedValue}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Reason</dt>
                    <dd className="mt-0.5 text-slate-700">{selectedEdge.reason}</dd>
                  </div>
                </dl>

                <div className="rounded border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-950">
                  <p className="flex items-start gap-1.5">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
                    <span>
                      Relationship requires verification — shared bank/address attributes can reflect group companies or common agents and are never proof of fraud.
                    </span>
                  </p>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-slate-900">
                    Linked Investigations ({selectedEdge.linkedInvestigations.length})
                  </h4>
                  {selectedEdge.linkedInvestigations.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">No linked investigations yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {selectedEdge.linkedInvestigations.map((inv) => (
                        <li
                          key={inv.id}
                          className="rounded border border-slate-200 bg-white p-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="font-semibold text-slate-900">
                              Case #{inv.id} · {inv.issueType}
                            </span>
                            <span className="text-amber-700">{inv.status}</span>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-600">
                            Dept: {inv.department}
                            {inv.assignedToName ? ` · Assigned: ${inv.assignedToName}` : ''}
                          </p>
                          <Link
                            to={`/investigations?id=${inv.id}`}
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-900 underline"
                          >
                            Open Investigation
                            <ArrowRight className="h-3 w-3" aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : selectedNode ? (
              <div className="space-y-4">
                <div className="border-b border-slate-200 pb-3">
                  <span className="font-mono text-[11px] font-semibold text-slate-500">
                    {selectedNode.supplierCode} · Sample data
                  </span>
                  <h3 className="mt-1 text-sm font-semibold text-slate-900">
                    {selectedNode.name}
                  </h3>
                  <p className="mt-1 text-xs text-slate-600">
                    Investigation Priority:{' '}
                    <span className="font-mono font-semibold text-slate-900">
                      {selectedNode.riskLevel} (score {selectedNode.riskScore})
                    </span>
                  </p>
                </div>

                <dl className="space-y-2 text-xs">
                  <div>
                    <dt className="text-slate-500">GSTIN / PAN</dt>
                    <dd className="font-mono text-slate-900">
                      {selectedNode.gstin} · {selectedNode.pan}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Bank Identifier (Masked)</dt>
                    <dd className="font-mono font-semibold text-slate-900">
                      {selectedNode.maskedBankIdentifier}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Address &amp; Phone</dt>
                    <dd className="text-slate-700">
                      {selectedNode.address} · {selectedNode.phone}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">GST Filing Status</dt>
                    <dd className="font-mono text-slate-900">{selectedNode.gstFilingStatus}</dd>
                  </div>
                </dl>

                <div>
                  <h4 className="text-xs font-semibold text-slate-900">
                    Linked Investigations ({edgeInvestigationsForSelectedNode.length})
                  </h4>
                  {edgeInvestigationsForSelectedNode.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">No shared-attribute investigations.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {edgeInvestigationsForSelectedNode.map((inv) => (
                        <li
                          key={inv.id}
                          className="rounded border border-slate-200 bg-white p-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="font-semibold text-slate-900">
                              Case #{inv.id} · {inv.issueType}
                            </span>
                            <span className="text-amber-700">{inv.status}</span>
                          </div>
                          <Link
                            to={`/investigations?id=${inv.id}`}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-900 underline"
                          >
                            Open Investigation
                            <ArrowRight className="h-3 w-3" aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Link
                  to={`/suppliers?supplierId=${selectedNode.id}`}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  View Supplier Performance Scorecard
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Select a supplier node or edge to inspect details.
              </p>
            )}
          </aside>
        </div>
      </section>

      {/* Accessible Tabular Edge Summary */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-semibold text-slate-900">
          Detected Shared-Attribute Indicators (Sample Data)
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Every shared attribute edge requires verification and is never treated as proof of fraud.
        </p>

        {!graphResponse || graphResponse.edges.length === 0 ? (
          <p className="py-6 text-xs text-slate-500">
            No shared bank, address, phone, or PAN pattern edges detected across suppliers.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-3">Relationship Type</th>
                  <th className="py-2 pr-3">Suppliers</th>
                  <th className="py-2 pr-3">Shared Value</th>
                  <th className="py-2 pr-3">Verification Notice</th>
                  <th className="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {graphResponse.edges.map((edge) => {
                  const sId = resolveNodeId(edge.source) || 0;
                  const tId = resolveNodeId(edge.target) || 0;
                  const sNode = nodeLookup.get(sId);
                  const tNode = nodeLookup.get(tId);
                  return (
                    <tr key={edge.id} className="hover:bg-slate-50">
                      <td className="py-2.5 pr-3 font-mono font-semibold text-rose-700">
                        {edge.type}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-900">
                        {sNode?.name || `#${sId}`} ↔ {tNode?.name || `#${tId}`}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-slate-800">{edge.sharedValue}</td>
                      <td className="py-2.5 pr-3 text-slate-600">{edge.reason}</td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedEdge(edge);
                            setSelectedNode(null);
                          }}
                          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Inspect Edge
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
