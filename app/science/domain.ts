/** Domain-owned sampling policy, copied from the AI4Science sampling scene without harness imports.
 * It evaluates data completeness only; scientific interpretation is explicitly out of scope. */
import { z } from 'zod'
import type { OperationContext } from './platform/sdk.ts'
import type { ExecutionEngine } from './platform/execution.ts'
import { Artifacts } from './platform/artifacts.ts'
import type { ExperimentRequest } from './platform/experiments.ts'

const contextSchema = z
  .object({ providerId: z.string().min(1), minimumReadings: z.number().int().min(1).max(96) })
  .strict()
const readingSchema = z
  .object({
    order: z.number().int().positive(),
    value: z.number().finite(),
    unit: z.string(),
    requestedCondition: z.number(),
    appliedCondition: z.number(),
  })
  .passthrough()

/** A concrete recipe offers an initial acquisition and at most one evidence-backed supplement. */
export function samplingRequest(providerId: string): ExperimentRequest {
  return {
    goal: 'Obtain at least six valid observations across two instrument conditions.',
    method: { id: 'bounded-sampling', version: '1' },
    context: { providerId, minimumReadings: 6 },
    inputArtifactIds: [],
    outputRequirements:
      'Raw observations, data-completeness assessments and an execution report; scientific interpretation is separate.',
    budget: 6,
    maxOperations: 2,
    actions: [
      {
        id: 'measure',
        providerId,
        input: {
          conditions: [
            { value: -1, samples: 2 },
            { value: 1, samples: 2 },
          ],
        },
        minUses: 1,
        maxUses: 1,
        requiresEvidence: false,
      },
      {
        id: 'supplement',
        providerId,
        input: {
          conditions: [
            { value: -1, samples: 1 },
            { value: 1, samples: 1 },
          ],
        },
        minUses: 0,
        maxUses: 1,
        requiresEvidence: true,
      },
    ],
  }
}

/** Read actual Provider output and persist the deterministic domain assessment with its raw sources. */
export function assessSampling(engine: ExecutionEngine, c: OperationContext, id: string) {
  const view = engine.experiments.get(c, id)
  if (!view.controllerActive || view.cancelRequested || view.state === 'completed')
    throw new Error('An open experiment with a live controller is required for assessment')
  if (view.request.method.id !== 'bounded-sampling' || view.request.method.version !== '1')
    throw new Error('Unsupported sampling method')
  if (
    !view.operations.length ||
    view.operations.some((o) => !['succeeded', 'failed', 'cancelled'].includes(o.state))
  )
    throw new Error('Wait for confirmed operation outcomes before assessing data')
  const domain = contextSchema.parse(view.request.context),
    artifacts = new Artifacts(engine),
    sources: string[] = [],
    orders = new Set<number>()
  for (const op of view.operations) {
    if (op.providerId !== domain.providerId) throw new Error('Sampling recipe contains an unrelated Provider')
    if (op.state !== 'succeeded') continue
    const raw = op.artifacts.find((a) => a.path.endsWith('raw.json'))
    if (!raw) throw new Error('Expected instrument raw observations')
    const rows = z.array(readingSchema).parse(JSON.parse(artifacts.read(c, raw.id).content))
    for (const row of rows) {
      if (orders.has(row.order)) throw new Error('Repeated observations cannot count as new evidence')
      orders.add(row.order)
    }
    sources.push(raw.id)
  }
  const result = {
    status: orders.size >= domain.minimumReadings ? 'sufficient' : 'insufficient',
    observed: orders.size,
    required: domain.minimumReadings,
    scientificConclusion: 'not-assessed',
  }
  const artifact = artifacts.publish(c, {
    mediaType: 'application/json',
    sources,
    content: JSON.stringify({ method: 'observation-count', version: '1', ...result }, null, 2),
  })
  const assessment = engine.experiments.assess(c, id, {
    method: 'observation-count',
    version: '1',
    result,
    rationale: 'Count unique observations in actual completed instrument outputs.',
    operationIds: view.operations.map((o) => o.id),
    artifactIds: [artifact.id],
  })
  return {
    ...result,
    assessmentId: assessment.id,
    artifactId: artifact.id,
    suggestedAction: result.status === 'insufficient' ? 'supplement' : 'finish',
  }
}

/** Produce an execution report only when this recipe's declared completeness requirement is met. */
export function finishSampling(engine: ExecutionEngine, c: OperationContext, id: string) {
  engine.experiments.requireController(c, id)
  const quality = assessSampling(engine, c, id)
  if (quality.status !== 'sufficient') throw new Error('Sampling output requirement has not been met')
  const view = engine.experiments.get(c, id),
    artifacts = new Artifacts(engine)
  const report = artifacts.publish(c, {
    mediaType: 'text/markdown',
    sources: [quality.artifactId],
    content: `# Experiment execution report\n\n${view.request.goal}\n\nObserved ${quality.observed} readings; required ${quality.required}.\n\nOperations: ${view.operations.map((o) => o.id).join(', ')}.\n\n[Data completeness assessment](${quality.artifactId})\n\nScientific conclusions are not evaluated by this report.\n`,
  })
  return engine.experiments.finish(
    c,
    id,
    'The declared observation count was obtained; execution and provenance verified.',
    [report.id],
    [quality.assessmentId],
  )
}
