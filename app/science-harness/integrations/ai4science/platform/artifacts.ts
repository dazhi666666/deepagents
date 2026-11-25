/** Project artifacts with content hashes and source identities. Scientific interpretation is scenario-owned. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import type { ExecutionEngine } from './execution.ts'
import type { OperationContext, Json } from './sdk.ts'
import { ArtifactVerificationCache } from './artifact-verification-cache.ts'

export interface ProjectArtifact {
  id: string
  projectId: string
  actorId: string
  path: string
  sha256: string
  bytes: number
  mediaType: string
  sources: string[]
}
/** Durable metadata lives in the engine's transaction database; verification identities belong to this instance. */
export class Artifacts {
  private readonly verification: ArtifactVerificationCache

  /**
   * @param engine Authorized metadata and artifact store owner.
   * @param artifactVerificationCacheEntries Maximum file identities retained; omitted defaults to 1024, 0 disables reuse.
   */
  constructor(
    private readonly engine: Pick<ExecutionEngine, 'readFacts' | 'list' | 'directory' | 'recordFact'>,
    artifactVerificationCacheEntries = 1024,
  ) {
    this.verification = new ArtifactVerificationCache(artifactVerificationCacheEntries)
  }
  list(context: OperationContext): ProjectArtifact[] {
    return this.engine
      .readFacts(context)
      .filter((f) => f.kind === 'artifact-published')
      .map((f) => f.data as unknown as ProjectArtifact)
  }
  /**
   * Resolve this project's currently accessible artifact and verify every recursive source and real path.
   * Unchanged file hashes may be reused; references and current Provider grants are checked on every call.
   * @param context Current project and Provider authority; never cached.
   * @param id Artifact identity in current authorized metadata.
   * @returns Verified metadata without reading or encoding unchanged content.
   */
  verify(context: OperationContext, id: string): ProjectArtifact {
    return this.traverse(context, id, false, new Set()).artifact
  }
  /**
   * Read an accessible artifact, always reading and hashing its bytes and every recursive source regardless of cache state.
   * @param context Current project and Provider authority.
   * @param id Artifact identity in current authorized metadata.
   * @param visiting Optional ancestor identities for cycle detection; omission starts a new traversal.
   * @returns Verified content in the artifact's text or binary encoding.
   */
  read(
    context: OperationContext,
    id: string,
    visiting = new Set<string>(),
  ): { artifact: ProjectArtifact; content: string; encoding: 'utf8' | 'base64' } {
    const { artifact, bytes } = this.traverse(context, id, true, visiting)
    const encoding =
      artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json' ? 'utf8' : 'base64'
    return { artifact, content: bytes!.toString(encoding), encoding }
  }
  private traverse(context: OperationContext, id: string, content: boolean, visiting: Set<string>) {
    const candidates = this.engine.list(context).flatMap((o) =>
      o.artifacts.map((a): ProjectArtifact => ({ ...a, projectId: o.projectId, actorId: o.actorId, sources: [] })),
    )
    const accessible = new Map<string, ProjectArtifact>()
    for (const artifact of [...candidates, ...this.list(context)]) {
      if (!accessible.has(artifact.id)) accessible.set(artifact.id, artifact)
    }
    const walk = (artifactId: string): { artifact: ProjectArtifact; bytes: Buffer | undefined } => {
      if (visiting.has(artifactId)) throw new Error('Artifact provenance cycle')
      const artifact = accessible.get(artifactId)
      if (!artifact) throw new Error('Unknown or inaccessible artifact')
      visiting.add(artifactId)
      try {
        for (const source of artifact.sources) walk(source)
        return { artifact, bytes: this.verification.check(this.engine.directory, artifact, content) }
      } finally {
        visiting.delete(artifactId)
      }
    }
    return walk(id)
  }
  /** Publish bounded text and validated source references; a database failure can leave an unreferenced file, never a false result. */
  publish(
    context: OperationContext,
    input: { content: string; mediaType: string; sources: string[] },
  ): ProjectArtifact {
    this.engine.list(context)
    if (
      !['text/plain', 'text/markdown', 'application/json'].includes(input.mediaType) ||
      Buffer.byteLength(input.content) > 1048576
    )
      throw new Error('Unsupported or oversized text artifact')
    if (input.mediaType === 'application/json') JSON.parse(input.content)
    for (const source of input.sources) this.read(context, source)
    const id = randomUUID()
    const directory = resolve(this.engine.directory, 'project-artifacts')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = resolve(directory, id)
    writeFileSync(path, input.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const artifact: ProjectArtifact = {
      id,
      projectId: context.projectId,
      actorId: context.actorId,
      path: relative(this.engine.directory, path),
      sha256: createHash('sha256').update(input.content).digest('hex'),
      bytes: Buffer.byteLength(input.content),
      mediaType: input.mediaType,
      sources: [...new Set(input.sources)],
    }
    this.engine.recordFact(context, 'artifact-published', artifact as unknown as Json)
    return artifact
  }
}
