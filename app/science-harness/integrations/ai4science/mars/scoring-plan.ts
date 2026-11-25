/** X3: simulate the submitted 500-tick operating plan under hidden truth (spec 7.3, R10). */
import { CHAMBERS, CROP_IDS, growthRate, varietyOf, type Truth } from './truth.ts'
import { activeHypotheses } from './base.ts'
import { clamp, type WorldView } from './scoring-common.ts'

interface ChamberPlan { light: number; nutrient: number; co2: number; temperature: number }
interface Plan { chambers: Record<string, ChamberPlan>; irrigation: Record<string, number>; waterSource: 'main' | 'reserve'; panelCleanEveryTicks: number }
const PROFILES = [{ min: 16, max: 28, moist: 0.8 }, { min: 18, max: 26, moist: 1 }, { min: 19, max: 25, moist: 1.2 }, { min: 17, max: 27, moist: 1.1 }]
const DAY_ENERGY = 45 * 96 / Math.PI

/** Steady growth of one crop under fixed settings, with simple stress rules. */
function cropRate(truth: Truth, cropId: string, chamber: ChamberPlan, irrigation: number) {
  const profile = PROFILES[varietyOf(cropId) - 1]!
  const temperature = chamber.temperature + 0.03 * Math.max(0, chamber.light - 70)
  let rate = growthRate(truth, cropId, { light: chamber.light, nutrient: chamber.nutrient, irrigation, co2: chamber.co2, temperature })
  const needed = 4 * profile.moist * (0.5 + chamber.light / 100) * 10
  if (temperature < profile.min || temperature > profile.max || irrigation < 0.8 * needed) rate *= 0.5
  return rate
}

/** Total 500-tick yield and feasibility for a plan over the crops still alive. */
export function evaluatePlan(truth: Truth, view: WorldView, plan: Plan) {
  const alive = view.crops.filter(crop => crop.status !== 'lost').map(crop => crop.id)
  let yieldTotal = 0, uptake = 0
  for (const cropId of alive) {
    const chamber = plan.chambers[`incubator-${cropId.split('-')[1]}`]
    if (!chamber) return { feasible: false, reason: 'missing chamber plan', yield: 0 }
    const rate = cropRate(truth, cropId, chamber, plan.irrigation[cropId] ?? 0)
    yieldTotal += rate * 500; uptake += 2 * rate
  }
  const water = alive.reduce((sum, id) => sum + (plan.irrigation[id] ?? 0), 0) / 100
  if (plan.waterSource === 'main' && (activeHypotheses(truth, view.base, truth.horizon).size > 0 || water > 12)) return { feasible: false, reason: 'water source contaminated or over recovery', yield: yieldTotal }
  if (plan.waterSource === 'reserve' && water * 500 > view.base.water.reserve) return { feasible: false, reason: 'reserve exhausted', yield: yieldTotal }
  const lights = CHAMBERS.reduce((sum, id) => sum + 0.5 + 0.5 * (plan.chambers[id]?.light ?? 70) / 70, 0)
  const demand = lights + 4 + 1 + 1.5
  if (demand * 48 > view.base.energy.capacity) return { feasible: false, reason: 'night demand exceeds battery', yield: yieldTotal }
  const dust = plan.panelCleanEveryTicks > 0 ? 1 - truth.energy.dustRate * plan.panelCleanEveryTicks / 2 : view.base.energy.dust * (1 - truth.energy.dustRate * 250)
  if (DAY_ENERGY * dust < demand * 96) return { feasible: false, reason: 'daily solar below demand', yield: yieldTotal }
  if (uptake * 0.1 * 500 > view.base.co2Tank) return { feasible: false, reason: 'CO2 tank exhausted', yield: yieldTotal }
  return { feasible: true, reason: 'ok', yield: yieldTotal }
}

/** Best feasible plan found by grid search; an evaluator reference, not shown to Agents. */
export function oraclePlan(truth: Truth, view: WorldView): Plan {
  const alive = new Set(view.crops.filter(crop => crop.status !== 'lost').map(crop => crop.id))
  for (const cap of [100, 90, 80, 70, 60, 50, 40]) {
    const chambers: Record<string, ChamberPlan> = {}, irrigation: Record<string, number> = {}
    for (const chamber of CHAMBERS) {
      const crops = CROP_IDS.filter(id => `incubator-${id.split('-')[1]}` === chamber && alive.has(id))
      let best = { score: -1, plan: { light: 70, nutrient: 1, co2: 800, temperature: 22 }, irrigation: {} as Record<string, number> }
      for (let light = 30; light <= cap; light += 5) for (const nutrient of [1, 2, 3]) for (const co2 of [800, 1000, 1200]) for (let temperature = 18; temperature <= 26; temperature++) {
        const plan = { light, nutrient, co2, temperature }, chosen: Record<string, number> = {}
        let score = 0
        for (const crop of crops) {
          let top = -1
          for (let level = 30; level <= 120; level += 5) { const rate = cropRate(truth, crop, plan, level); if (rate > top) { top = rate; chosen[crop] = level } }
          score += top
        }
        if (score > best.score) best = { score, plan, irrigation: chosen }
      }
      chambers[chamber] = best.plan; Object.assign(irrigation, best.irrigation)
    }
    const total = Object.values(irrigation).reduce((sum, value) => sum + value, 0)
    if (total > 1150) for (const key of Object.keys(irrigation)) irrigation[key] = irrigation[key]! * 1150 / total
    const plan: Plan = { chambers, irrigation, waterSource: activeHypotheses(truth, view.base, truth.horizon).size ? 'reserve' : 'main', panelCleanEveryTicks: 200 }
    if (evaluatePlan(truth, view, plan).feasible) return plan
  }
  return { chambers: Object.fromEntries(CHAMBERS.map(id => [id, { light: 50, nutrient: 1, co2: 800, temperature: 22 }])),
    irrigation: Object.fromEntries(CROP_IDS.map(id => [id, 60])), waterSource: 'main', panelCleanEveryTicks: 200 }
}

/** X3 accuracy: yield gain over the default plan relative to the oracle's gain. */
export function scorePlan(truth: Truth, view: WorldView, answer: Plan) {
  const defaultPlan: Plan = { chambers: Object.fromEntries(CHAMBERS.map(id => [id, { light: 70, nutrient: 1, co2: 800, temperature: 22 }])),
    irrigation: Object.fromEntries(CROP_IDS.map(id => [id, 75])), waterSource: 'main', panelCleanEveryTicks: 0 }
  const submitted = evaluatePlan(truth, view, answer)
  if (!submitted.feasible) return { accuracy: 0, reason: submitted.reason }
  const base = evaluatePlan(truth, view, defaultPlan).yield, best = evaluatePlan(truth, view, oraclePlan(truth, view)).yield
  return { accuracy: best - base > 1e-6 ? clamp((submitted.yield - base) / (best - base)) : submitted.yield >= base ? 1 : 0, reason: 'ok' }
}
