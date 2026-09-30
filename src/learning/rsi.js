/**
 * RSI (recursive self-improvement) — praktični nivo: agent analizira svoj rad i predlaže poboljšanja.
 *
 * Nivoi koje ovaj modul pokriva:
 *   1. prompt     — bolji system prompt (iz padova i niske nagrade)
 *   2. policy     — izmjena politika (npr. alat koji se stalno odbija a potreban je, ili obratno)
 *   3. kb         — dopuna baze znanja iz ponavljanih pitanja bez odgovora
 *   4. pattern    — izbor patterna (npr. `reflection` je bolji od `agent` za dati domen)
 *   5. tool/code  — traži izmjenu koda ili MCP servera → ostaje zadatak za čovjeka
 *
 * Nivoi koje NE pokriva (i zašto): automatsko pisanje i deploy nove arhitekture ili modela.
 * Za to treba (a) eval koji je jeftiniji od rizika, (b) sandbox u drugom procesu, (c) čovjek u lancu.
 * Ovaj modul daje tačno ono što tim treba prije toga: **dokaze i predloge**.
 *
 * Sve što se primijeni ide kroz `improvements` (odobrenje + rollback + mjerenje efekta).
 */
import { iso } from '../core/clock.js';

export function createRsi({ logger, metrics, audit, rewards, improvements, goals, tracer, catalog, cost, autonomy, memory } = {}) {
  const DAY = 86_400_000;

  /** Prikuplja nalaze iz stvarnih podataka (nagrade, trace, ciljevi, trošak). */
  async function analyze(tenantId, { sinceDays = 7 } = {}) {
    const sinceMs = sinceDays * DAY;
    const findings = [];

    // 1) Najslabiji agenti i patterni po nagradi
    if (rewards) {
      const agents = await rewards.ranking(tenantId, { groupBy: 'agent', sinceMs });
      for (const row of agents.bottom) {
        if (row.n >= 3 && row.avgReward < 0.5) {
          findings.push({
            id: `low_reward_agent_${row.key}`,
            severity: row.avgReward < 0.35 ? 'high' : 'medium',
            area: 'agent',
            subject: row.key,
            message: `Agent "${row.key}" ima prosječnu nagradu ${row.avgReward} na ${row.n} runova`,
            evidence: row,
            suggestedKind: 'prompt',
          });
        }
      }
      const patterns = await rewards.ranking(tenantId, { groupBy: 'pattern', sinceMs });
      for (const row of patterns.bottom) {
        if (row.n >= 3 && row.avgReward < 0.5) {
          findings.push({
            id: `low_reward_pattern_${row.key}`,
            severity: 'medium',
            area: 'pattern',
            subject: row.key,
            message: `Pattern "${row.key}" daje prosječnu nagradu ${row.avgReward} na ${row.n} runova`,
            evidence: row,
            suggestedKind: 'pattern',
          });
        }
      }
    }

    // 2) Ponavljajuće greške alata i odbijene politike iz trace-a
    if (tracer) {
      const runs = await tracer.readFromDisk({ tenantId, limit: 200 }).catch(() => []);
      const toolErrors = {};
      const denials = {};
      const shortRuns = [];
      for (const run of runs) {
        for (const span of run.spans ?? []) {
          if (span.name?.startsWith('tool ') && span.status === 'error') {
            const tool = span.name.replace('tool ', '');
            toolErrors[tool] = (toolErrors[tool] ?? 0) + 1;
          }
        }
        if (run.status === 'error') shortRuns.push(run.runId);
      }
      for (const [tool, n] of Object.entries(toolErrors)) {
        if (n >= 3) {
          findings.push({
            id: `tool_errors_${tool}`,
            severity: n >= 10 ? 'high' : 'medium',
            area: 'tool',
            subject: tool,
            message: `Alat "${tool}" je pao ${n}x u zadnjih ${runs.length} runova`,
            evidence: { tool, errors: n },
            suggestedKind: 'tool',
          });
        }
      }
      if (shortRuns.length >= 5) {
        findings.push({
          id: 'run_errors',
          severity: 'high',
          area: 'reliability',
          subject: 'runs',
          message: `${shortRuns.length} od ${runs.length} runova je završilo greškom`,
          evidence: { errors: shortRuns.length, total: runs.length },
          suggestedKind: 'prompt',
        });
      }
    }

    // 3) Ciljevi koji skreću
    if (goals) {
      const portfolio = await goals.portfolio(tenantId);
      for (const g of portfolio.atRisk) {
        findings.push({
          id: `goal_${g.id}`,
          severity: g.status === 'off_track' || g.status === 'missed' ? 'high' : 'medium',
          area: 'goal',
          subject: g.id,
          message: `Cilj "${g.title}" je ${g.status} (${g.pct}% vs očekivano ${g.expected}%)`,
          evidence: g,
          suggestedKind: 'action',
        });
      }
    }

    metrics?.set('rsi_findings', { tenant: tenantId }, findings.length);
    return { tenantId, sinceDays, findings, at: iso() };
  }

  /** Pretvara nalaze u prijedloge (nikad ne mijenja ništa samo). */
  async function propose(tenantId, { findings } = {}) {
    const list = findings ?? (await analyze(tenantId)).findings;
    const created = [];
    for (const f of list) {
      if (!improvements) break;
      const kind = f.suggestedKind ?? 'prompt';
      const proposal = await improvements.createProposal(tenantId, {
        kind,
        target: kind === 'policy' ? null : f.subject,
        current: null,
        proposed: null,
        rationale: `RSI: ${f.message}`,
        evidence: [f.evidence],
        expectedImpact: kind === 'prompt' ? 'veća nagrada i manje padova' : kind === 'pattern' ? 'bolji izbor patterna za dati domen' : 'manje grešaka',
        riskLevel: f.severity === 'high' ? 'high' : 'medium',
        source: 'rsi',
      });
      created.push({ findingId: f.id, proposalId: proposal.id, kind });
    }
    metrics?.inc('rsi_proposals_total', { tenant: tenantId }, created.length);
    return created;
  }

  /** Pun ciklus: analiza → predlozi (+ audit). */
  async function cycle(tenantId, { sinceDays = 7, autoPropose = true } = {}) {
    const analysis = await analyze(tenantId, { sinceDays });
    const proposals = autoPropose ? await propose(tenantId, { findings: analysis.findings }) : [];
    await audit?.append({
      tenantId,
      actor: 'rsi',
      action: 'rsi_cycle',
      args: { findings: analysis.findings.length, proposals: proposals.length, sinceDays },
      decision: 'allow',
      outcome: 'ok',
    });
    logger?.info?.('rsi.cycle', { tenantId, findings: analysis.findings.length, proposals: proposals.length });
    return { ...analysis, proposals };
  }

  /** Efekat primijenjenog prijedloga: nagrada prije i poslije primjene. */
  async function impact(tenantId, proposalId) {
    const proposal = await improvements.get(tenantId, proposalId);
    if (!proposal.appliedAt && !proposal.rolledBackAt) return { proposalId, status: 'nije primijenjen', impact: null };
    const at = new Date(proposal.appliedAt ?? proposal.rolledBackAt).getTime();
    const rows = await rewards.recent(tenantId, { limit: 1000 });
    const before = rows.filter((r) => new Date(r.ts).getTime() < at && (!proposal.target || r.agentId === proposal.target));
    const after = rows.filter((r) => new Date(r.ts).getTime() >= at && (!proposal.target || r.agentId === proposal.target));
    const avg = (arr) => (arr.length ? Number((arr.reduce((s, r) => s + r.reward, 0) / arr.length).toFixed(4)) : null);
    const delta = before.length && after.length ? Number((avg(after) - avg(before)).toFixed(4)) : null;
    metrics?.observe('rsi_impact_delta', { tenant: tenantId, kind: proposal.kind }, delta ?? 0);
    return {
      proposalId,
      target: proposal.target,
      kind: proposal.kind,
      appliedAt: proposal.appliedAt ?? null,
      before: { n: before.length, avgReward: avg(before) },
      after: { n: after.length, avgReward: avg(after) },
      delta,
      verdict: delta === null ? 'nedovoljno podataka' : delta > 0.03 ? 'poboljšanje' : delta < -0.03 ? 'pogoršanje (razmisli o rollback-u)' : 'bez promjene',
    };
  }

  return { analyze, propose, cycle, impact, DAY, sinceDaysDefault: 7 };
}
