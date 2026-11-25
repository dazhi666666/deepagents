/** Bounded, instance-owned byte-verification metadata; callers must resolve current access and source references on every traversal. */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

type ExpectedArtifact = { path: string; sha256: string; bytes: number }
type Fingerprint = {
  path: string
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}
type VerifiedFile = { fingerprint: Fingerprint; sha256: string; bytes: number }

function fingerprint(path: string, stat: BigIntStats): Fingerprint {
  return { path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}
function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function identify(directory: string, artifactPath: string): Fingerprint {
  const base = realpathSync(directory)
  const path = realpathSync(resolve(base, artifactPath))
  const rel = relative(base, path)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact path escaped project store')
  return fingerprint(path, statSync(path, { bigint: true }))
}

/** Successful file identities only, evicted in least-recently-used order; no content or authorization is retained. */
export class ArtifactVerificationCache {
  private readonly entries = new Map<string, VerifiedFile>()

  /**
   * @param capacity Maximum successful identities retained; 0 disables reuse. Invalid capacities throw before any file access.
   */
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 100000)
      throw new Error('Artifact verification cache entries must be an integer 0..100000')
  }

  /**
   * Verify current real paths and file identity, reusing a matching hash only when content is not requested.
   * Strict content reads always hash bytes from one descriptor and reject differing pre/post identities.
   * @param directory Real-path confinement root, re-resolved for each check.
   * @param artifact Current expected path, hash and byte count from authorized metadata.
   * @param content True to read and hash even a warmed file; false permits metadata reuse.
   * @returns Verified bytes for content reads or cache misses; undefined on a metadata-only cache hit.
   */
  check(directory: string, artifact: ExpectedArtifact, content: boolean): Buffer | undefined {
    const before = identify(directory, artifact.path)
    const cached = this.entries.get(before.path)
    if (!content && cached && cached.sha256 === artifact.sha256 && cached.bytes === artifact.bytes &&
      sameFile(cached.fingerprint, before)) {
      this.entries.delete(before.path)
      this.entries.set(before.path, cached)
      return
    }
    this.entries.delete(before.path)
    const descriptor = openSync(before.path, 'r')
    let bytes: Buffer
    try {
      if (!sameFile(before, fingerprint(before.path, fstatSync(descriptor, { bigint: true }))))
        throw new Error('Artifact integrity check failed')
      bytes = readFileSync(descriptor)
      if (!sameFile(before, fingerprint(before.path, fstatSync(descriptor, { bigint: true }))))
        throw new Error('Artifact integrity check failed')
    } finally {
      closeSync(descriptor)
    }
    if (!sameFile(before, identify(directory, artifact.path)) || bytes.length !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('Artifact integrity check failed')
    if (this.capacity > 0) {
      this.entries.set(before.path, { fingerprint: before, sha256: artifact.sha256, bytes: artifact.bytes })
      if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
    }
    return bytes
  }
}
