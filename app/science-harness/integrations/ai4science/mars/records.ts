/** Durable Agent-authored tasks and text records over the platform fact journal. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { canonicalJson, type Json, type OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { TASK_IDS } from './deliverables.ts'

const id = z.string().trim().min(1)
const taskSchema = z.object({
  id, title: id, description: z.string(), objectiveIds: z.array(id), dependencies: z.array(id),
  createdBy: id, createdTick: z.number().int().nonnegative().default(0), updatedTick: z.number().int().nonnegative().default(0),
  parentTaskId: id.nullable().default(null), assignee: id.nullable(), revision: z.number().int().positive(),
  state: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
  resultRefs: z.array(id), reason: z.string(),
}).strict()
const noteSchema = z.object({ path: id, text: z.string(), revision: z.number().int().positive(), updatedBy: id, updatedTick: z.number().int().nonnegative().default(0) }).strict()
const receiptSchema = z.object({ key: id, input: z.string(), result: z.json(), tick: z.number().int().nonnegative().default(0) }).strict()
const createSchema = z.object({ title: id, description: z.string().default(''), objectiveIds: z.array(id),
  dependencies: z.array(id).default([]), parentTaskId: id.nullable().default(null), assignee: id.nullable().default(null) }).strict()
const patchSchema = z.object({ title: id.optional(), description: z.string().optional(),
  dependencies: z.array(id).optional(), parentTaskId: id.nullable().optional(), assignee: id.nullable().optional(),
  state: taskSchema.shape.state.optional(), resultRefs: z.array(id).optional(), reason: id }).strict()
export type MarsTask = z.infer<typeof taskSchema>

/** One native host serializes synchronous fact writes; revisions prevent lost updates.
 * @param engine Owning execution manager.
 * @param context Current participant context, checked on every read and write.
 */
export class MarsRecords {
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext,
    private readonly logicalTick: () => number = () => 0,
    private readonly objectiveIds: readonly string[] = TASK_IDS) {}

  private mutate(key: string, input: Json, kind: string, body: () => Json): Json {
    id.parse(key)
    const request = canonicalJson({ kind, input })
    for (const fact of this.engine.readFacts(this.context)) if (fact.kind === 'mars-record-mutation') {
      const receipt = receiptSchema.parse(fact.data)
      if (fact.actorId === this.context.actorId && receipt.key === key) {
        if (receipt.input !== request) throw new Error('Request key already used with different input')
        return receipt.result
      }
    }
    // A single fact contains both mutation and retry receipt, avoiding partial commits.
    const result = body()
    this.engine.recordFact(this.context, 'mars-record-mutation', { key, input: request, result, tick: this.logicalTick() })
    return result
  }

  private currentTasks(): MarsTask[] {
    const tasks = new Map<string, MarsTask>()
    for (const fact of this.engine.readFacts(this.context)) if (fact.kind === 'mars-record-mutation') {
      const value = receiptSchema.parse(fact.data).result
      const task = taskSchema.safeParse(value)
      if (task.success) tasks.set(task.data.id, task.data)
    }
    return [...tasks.values()]
  }

  /** Read all task revisions projected from atomic mutation receipts. */
  listTasks(): MarsTask[] { return this.currentTasks() }

  /** Create an Agent-authored task with an idempotent request key.
   * @param key Stable caller request key.
   * @param input Model-supplied task fields.
   * @returns Durable task including author identity.
   */
  createTask(key: string, input: unknown): MarsTask {
    const request = createSchema.parse(input)
    const objectives = new Set<string>([...this.objectiveIds, 'operations', 'incident'])
    if (request.objectiveIds.some(objective => !objectives.has(objective))) throw new Error('Unknown objective; use mission task IDs (D1-D3, W1-W4, G1-G4, F1-F3, A1-A8, X1-X3), operations or incident')
    return taskSchema.parse(this.mutate(key, request, 'task-create', () => {
      const tasks = this.currentTasks()
      if (request.dependencies.some(dependency => !tasks.some(task => task.id === dependency))) throw new Error('Unknown dependency')
      if (request.parentTaskId && !tasks.some(task => task.id === request.parentTaskId)) throw new Error('Unknown parent task')
      return { ...request, id: randomUUID(), createdBy: this.context.actorId, createdTick: this.logicalTick(), updatedTick: this.logicalTick(), revision: 1,
        state: 'pending', resultRefs: [], reason: 'Created by Agent' }
    }))
  }

  /** Update a task only against its current revision.
   * @param key Stable request key.
   * @param taskId Existing task.
   * @param revision Last observed revision.
   * @param input Requested fields and reason.
   * @returns Persisted revision.
   */
  updateTask(key: string, taskId: string, revision: number, input: unknown): MarsTask {
    const patch = patchSchema.parse(input)
    return taskSchema.parse(this.mutate(key, z.json().parse({ taskId, revision, patch }), 'task-update', () => {
      const tasks = this.currentTasks(), current = tasks.find(task => task.id === taskId)
      if (!current) throw new Error('Unknown task')
      if (current.revision !== revision) throw new Error('Task revision changed; read before editing')
      const next = taskSchema.parse({ ...current, ...patch, updatedTick: this.logicalTick(), revision: revision + 1 })
      const byId = new Map(tasks.map(task => [task.id, task]))
      byId.set(taskId, next)
      const parents = new Set([taskId])
      let parent = next.parentTaskId
      while (parent) {
        if (parents.has(parent)) throw new Error('Parent task cycle')
        parents.add(parent)
        const ancestor = byId.get(parent)
        if (!ancestor) throw new Error('Unknown parent task')
        parent = ancestor.parentTaskId
      }
      const visiting = new Set<string>(), visited = new Set<string>()
      const visit = (task: MarsTask) => {
        if (visiting.has(task.id)) throw new Error('Task dependency cycle')
        if (visited.has(task.id)) return
        visiting.add(task.id)
        for (const dependency of task.dependencies) {
          const value = byId.get(dependency)
          if (!value) throw new Error('Unknown dependency')
          visit(value)
        }
        visiting.delete(task.id); visited.add(task.id)
      }
      visit(next)
      return next
    }))
  }

  /** Read text records, projecting atomic mutation receipts. */
  listNotes() {
    const notes = new Map<string, z.infer<typeof noteSchema>>()
    for (const fact of this.engine.readFacts(this.context)) if (fact.kind === 'mars-record-mutation') {
      const value = noteSchema.safeParse(receiptSchema.parse(fact.data).result)
      if (value.success) notes.set(value.data.path, value.data)
    }
    return [...notes.values()]
  }

  /** Persist freely authored text with compare-and-swap editing.
   * @param key Stable request key.
   * @param path Logical text path within the shared notebook.
   * @param revision Zero to create, current revision to edit.
   * @param text Full UTF-8 text.
   * @returns Durable note version.
   */
  writeNote(key: string, path: string, revision: number, text: string) {
    if (!/^(?:notes|plans|reports)\/[\p{L}\p{N}_. /-]+$/u.test(path) || path.split('/').some(part => part === '..' || part === '.'))
      throw new Error('Use a notebook path under notes/, plans/ or reports/')
    z.number().int().nonnegative().parse(revision)
    z.string().parse(text)
    return noteSchema.parse(this.mutate(key, { path, revision, text }, 'note-write', () => {
      const prior = this.listNotes().find(note => note.path === path)
      if ((prior?.revision ?? 0) !== revision) throw new Error('Note revision changed; read before editing')
      return { path, text, revision: revision + 1, updatedBy: this.context.actorId, updatedTick: this.logicalTick() }
    }))
  }
  /** Edit one uniquely matching text fragment without reloading the complete notebook into context. */
  editNote(key: string, path: string, revision: number, oldText: string, newText: string) {
    z.string().min(1).parse(oldText)
    return noteSchema.parse(this.mutate(key, { path, revision, oldText, newText }, 'note-edit', () => {
      const prior = this.listNotes().find(note => note.path === path)
      if (!prior || prior.revision !== revision) throw new Error('Read the current note revision before editing')
      const first = prior.text.indexOf(oldText)
      if (first < 0 || prior.text.indexOf(oldText, first + oldText.length) >= 0) throw new Error('old_text must match exactly one note fragment')
      return { ...prior, text: prior.text.slice(0, first) + newText + prior.text.slice(first + oldText.length),
        revision: revision + 1, updatedBy: this.context.actorId, updatedTick: this.logicalTick() }
    }))
  }
}
