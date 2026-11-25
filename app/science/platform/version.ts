/** Host compatibility version and the checked-in Harness revision; deployment commit metadata does not alter either. */
import { readFileSync } from 'node:fs'

/** Supported deployment host API; independent of deployment apiVersion and Provider protocol version. */
export const HOST_API_VERSION = '0.2'

const metadata = JSON.parse(readFileSync(new URL('../../../UPSTREAM.json', import.meta.url), 'utf8')) as { upstreamCommit: string }
if (!/^[a-f0-9]{40}$/.test(metadata.upstreamCommit)) throw new Error('Invalid pinned Harness revision in UPSTREAM.json')
/** Pinned host revision from UPSTREAM.json, independent of a deployment file's optional baseline. */
export const HARNESS_BASELINE = metadata.upstreamCommit
