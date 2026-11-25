/* Mars panel view registry. Each module owns one route and reads only the Viewer API proxy. */
import { createMarsApi } from './api.js'
import { createOverview } from './overview.js'
import { createBase } from './base.js'
import { createMap } from './map.js'
import { createEnergy } from './energy.js'
import { createWater } from './water.js'
import { createCrops } from './crops.js'
import { createTeam } from './team.js'
import { createResearch } from './research.js'
import { createRaw } from './raw.js'
import { createAnalysis } from './analysis.js'
import { createIncidents } from './incidents.js'
import { createCompare } from './compare.js'

export function createMarsViews(context) {
  const api = createMarsApi(context.api)
  const shared = { ...context, api, mars: context.mars ?? {} }
  return {
    'mars-overview': createOverview(shared),
    'mars-base': createBase(shared),
    'mars-map': createMap(shared),
    'mars-energy': createEnergy(shared),
    'mars-water': createWater(shared),
    'mars-crops': createCrops(shared),
    'mars-research': createResearch(shared),
    'mars-raw': createRaw(shared),
    'mars-analysis': createAnalysis(shared),
    'mars-incidents': createIncidents(shared),
    'mars-team': createTeam(shared),
    'mars-compare': createCompare(shared),
  }
}
