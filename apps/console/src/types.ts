// The partner API's shapes as the console reads them. Big numbers arrive as decimal strings; the console
// converts at the edge (policy.ts) and never does arithmetic on floats.

export interface ApiError {
  error: string;
  detail?: string;
  correlationId?: string;
  [k: string]: unknown;
}

export interface Money {
  baseUnits: string;
  usdc: string;
}

export interface Obligation {
  lineId: string;
  user: string;
  marketId: string;
  openedAt: number | null;
  openedBlock: number | null;
  openTx: string | null;
  decisionHash: string | null;
  lineStatus: string;
  obligationStatus: string;
  policyVersion: number | null;
  drawnPrincipal: Money | null;
  holdReason: string | null;
}

export interface ObligationsResponse {
  correlationId: string;
  policyVersion: number;
  partnerId: string;
  chainId: number;
  count: number;
  source: "indexer" | "api-cache";
  sourceNote: string;
  obligations: Obligation[];
}

export interface LineResponse {
  correlationId: string;
  policyVersion: number;
  chainId: number;
  desk: string;
  line: {
    lineId: string;
    partnerId: string;
    user: string;
    marketId: string;
    collateralToken: string;
    policyVersion: number;
    status: string;
    holdReason: string;
    openedAt: number;
    drawnPrincipal: Money;
  };
  obligationStatus: string;
  quote: Record<string, unknown>;
  readAt: number;
}

export interface Decision {
  action: string;
  hash: string;
  amount: string;
  price8: string;
  blockNumber: number;
  blockTime: number;
  txHash: string;
  logIndex: number;
}

export interface TimelineEvent {
  event: string;
  hash: string | null;
  blockNumber: number;
  blockTime: number;
  txHash: string;
  logIndex: number;
  args: Record<string, unknown>;
}

export interface DecisionsResponse {
  correlationId: string;
  policyVersion: number;
  chainId: number;
  desk: string;
  lineId: string;
  status: string;
  source: string;
  count: number;
  decisions: Decision[];
  timeline: TimelineEvent[];
}

export interface PartnerConfig {
  admin: string;
  signer: string;
  eligibility: string;
  active: boolean;
  exposureCap: string;
  exposure: string;
}

export interface TickerPolicy {
  symbol: string;
  collateral: string;
  marketId: string;
  allowed: boolean;
  maxLtvWad: string;
  minDraw: string;
  maxDraw: string;
  exposureCap: string;
  exposure: string;
  marketLltvWad: string;
}

export interface PolicyResponse {
  partnerId: string;
  name: string;
  policyVersion: number;
  partner: PartnerConfig;
  tickers: TickerPolicy[];
}

export interface TickerDraft {
  collateral: string;
  allowed: boolean;
  maxLtvWad: string;
  minDraw: string;
  maxDraw: string;
  exposureCap: string;
}

export interface PartnerDraft {
  signer: string;
  eligibility: string;
  exposureCap: string;
  active: boolean;
}

export interface PolicyDraftBody {
  note: string;
  tickers?: TickerDraft[];
  partner?: PartnerDraft;
}

export interface PolicyChange {
  scope: "partner" | "ticker" | string;
  collateral?: string;
  field: string;
  before: string | boolean | number | null;
  after: string | boolean | number | null;
}

export interface PreparedCall {
  to: string;
  data: string;
  description: string;
}

export interface PolicyVersion {
  id: string;
  status: "prepared" | "applied" | string;
  createdAt: number;
  appliedAt?: number | null;
  note: string;
  changes: PolicyChange[];
  calls: PreparedCall[];
  policyVersionBefore: number;
  policyVersionAfter?: number | null;
  txHash?: string | null;
}

export interface DrillStep {
  n: number;
  title: string;
  detail: string;
}

export interface DrillTx {
  hash: string;
  label: string;
}

export interface DrillAttempt {
  what: string;
  result: string;
}

export interface DrillRun {
  ranAt: number;
  chainId: number;
  /** One line on what was staged for this run (optional). */
  label?: string;
  txs: (DrillTx & { block?: number })[];
  /** The ordered attempts and what each answered (optional). */
  attempts?: DrillAttempt[];
  outcome: string;
  /** Paths or links to the evidence records (one or several). */
  evidence: string | string[];
}

export interface Drill {
  id: string;
  title: string;
  description: string;
  venue: string;
  steps: DrillStep[];
  runs: DrillRun[];
}

export interface ReconcileCheck {
  id?: number;
  chainId?: number;
  subject: string;
  checkedAt?: number;
  blockNumber?: number;
  status: string;
  expected: Record<string, string>;
  actual: Record<string, string>;
}

export interface ReconcileLatest {
  chainId: number;
  checkedAt: number;
  blockNumber: number;
  status: string;
  checks: ReconcileCheck[];
}

export interface RootRow {
  chainId?: number;
  day: string;
  firstBlock: number | null;
  lastBlock: number | null;
  eventCount: number;
  prevRoot: string;
  root: string;
  computedAt?: number;
}

export interface RootsResponse {
  chainId: number;
  scheme?: string;
  roots: RootRow[];
  today?: { day: string; eventCount: number; rootSoFar: string };
}

export interface ReconciliationResponse {
  reconcile: ReconcileLatest | ApiError | null;
  roots: RootsResponse | ApiError | null;
}

export interface SourceCursor {
  chainId: number;
  source: string;
  lastBlock: number;
  lastBlockTime: number;
  updatedAt: number;
}

export interface SourceRow {
  id: string;
  chainId: number;
  addresses: number;
  topic0s: number;
  indexedFilter: boolean;
  startBlock: number;
  addressList: string[];
  cursor: SourceCursor | null;
}

export interface SourcesResponse {
  count: number;
  sources: SourceRow[];
}

export interface EvidenceBundle {
  generatedAt: number;
  partnerId: string;
  policy: unknown;
  lines: unknown[];
  obligations: unknown[];
  decisions: unknown[];
  roots: unknown;
  reconciliation: unknown;
  drills: unknown[];
  hash: string;
  [k: string]: unknown;
}

export interface ObservatorySessions {
  takenAt: number;
  state: string;
  isFeedLive: boolean;
  nextTransition: { to: string; at: number } | null;
  lastFeedUpdateAt: number | null;
  nextFeedTransition: { at: number; from: string; to: string; kind: string } | null;
}

export interface ConsoleConfig {
  partnerId: string;
  hasPartnerKey: boolean;
  keySource: "pasted" | "console" | "none";
}
