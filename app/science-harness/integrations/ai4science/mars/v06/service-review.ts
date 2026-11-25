/** Project the same active specifications at review and again at commitment time. */
import type { Plan } from '../v05/planning.ts'
import type { MarsWorld } from '../world.ts'
import type { Commission } from './cases.ts'
import { planHash } from './actions.ts'
import { contentHash } from './contracts.ts'
import { inspectServicePortfolio } from './service-portfolio.ts'

const hard = new Set(['insufficient_charge', 'dock_reserve', 'charge_off_dock', 'route_unavailable', 'deadline'])
export function reviewServices(world: Pick<MarsWorld, 'observe' | 'observeSystems' | 'rules' | 'scenario'>, commissions: readonly Commission[], plans: Plan[]) {
  const active = plans.filter(p => p.service && ['running', 'scheduled'].includes(p.state)).sort((a,b) => a.createdTick-b.createdTick || a.id.localeCompare(b.id))
  const hashes = active.map(p => [p.id, planHash(p)])
  const view = inspectServicePortfolio(world, commissions, active.map(p => ({ id:p.id, draft:p, saved:p, committed:false })), x=>x)
  return { asOfTick: view.asOfTick, plans: view.services.map(s => {
    const issues = view.issues.filter(i => i.planId === s.planId)
    const blockers = issues.filter(i => hard.has(i.code))
    const reviewId = contentHash({ version:'reviewed-v1', plans:hashes, target:s.planId })
    return { planId:s.planId, commissionId:s.commissionId, reviewId, eligible:!blockers.length, firstBlocker:blockers[0] ?? null,
      blockers, advisory:issues.filter(i => !hard.has(i.code)), deadline:s.deadline, slackTicks:s.slackTicks }
  }) }
}
/** Show the paired sample lineage to the water and service owners, even before a plan is registered. */
export function serviceWindows(world:Pick<MarsWorld,'observe'|'observeSystems'|'rules'>, commissions:readonly Commission[]) {
  const lab=world.observe(), sources=world.observeSystems().sampleSources
  return commissions.map(c=>{
    const timely=lab.results.filter(r=>r.completedTick<=Math.min(lab.tick,c.deadline) && c.methods.includes(r.methodId) && sources[r.rootSampleId]===c.sourceId
      && !lab.revocations.some(v=>v.resultId===r.id && v.tick<=lab.tick))
    const roots=new Map(timely.map(r=>[r.rootSampleId,r]))
    const mothers=[...roots].map(([id,result])=>{
      const sample=lab.samples.find(s=>s.id===id)
      return {rootSampleId:id,resultId:result.id,completedTick:result.completedTick,remainingUl:sample?.volumeUl??0,location:sample?.location??null,expiresAt:sample?.expiresAt??null,
        viableByPublicInventory:Boolean(sample && sample.state==='raw' && sample.disposition==='available' && sample.volumeUl>=c.minimumRemainingUl && sample.expiresAt>=c.preserveUntil)}
    }).sort((a,b)=>Number(b.viableByPublicInventory)-Number(a.viableByPublicInventory) || b.completedTick-a.completedTick)
    return {commissionId:c.id,source:c.sourceId,methods:c.methods,deadline:c.deadline,preserveUntil:c.preserveUntil,minimumRemainingUl:c.minimumRemainingUl,
      earliestSampleCompletionTick:Math.max(0,c.preserveUntil-world.rules.sampleLifetimeTicks),timelyMeasurements:timely.length,measuredRoots:mothers.length,mothers:mothers.slice(0,4)}
  })
}

export function requireServiceReview(review: ReturnType<typeof reviewServices>, planId: string, reviewId?: string) {
  const plan = review.plans.find(p => p.planId === planId)
  if (!plan || plan.reviewId !== reviewId) throw new Error(`Read service_review for ${planId}: supply its current reviewId after scheduling or amending the portfolio`)
  if (plan.firstBlocker) throw new Error(`Service commitment blocked for ${planId}/${plan.firstBlocker.stepId}: ${plan.firstBlocker.code}: ${plan.firstBlocker.detail}`)
}
