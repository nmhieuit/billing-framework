import type { ReconciliationItem, ReconciliationRun } from './ports.js';

export interface ReconciliationRunView {
  id: string;
  day: string;
  status: string;
  triggeredBy: string;
  failureReason: string | null;
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
  itemCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export function toRunView(run: ReconciliationRun): ReconciliationRunView {
  return {
    id: run.id,
    day: run.day,
    status: run.status,
    triggeredBy: run.triggeredBy,
    failureReason: run.failureReason,
    gatewayTotals: run.gatewayTotals,
    walletTotals: run.walletTotals,
    itemCount: run.itemCount,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export interface ReconciliationItemView {
  id: string;
  runId: string;
  kind: string;
  chargeId: string | null;
  topupId: string | null;
  amountGateway: number | null;
  amountWallet: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  action: string;
  caseStatus: string;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function toItemView(item: ReconciliationItem): ReconciliationItemView {
  return {
    id: item.id,
    runId: item.runId,
    kind: item.kind,
    chargeId: item.chargeId,
    topupId: item.topupId,
    amountGateway: item.amountGateway,
    amountWallet: item.amountWallet,
    currency: item.currency,
    detail: item.detail,
    action: item.action,
    caseStatus: item.caseStatus,
    resolvedBy: item.resolvedBy,
    resolutionNote: item.resolutionNote,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}
