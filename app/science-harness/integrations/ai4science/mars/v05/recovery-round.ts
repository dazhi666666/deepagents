/** Startup participants may be parked only because their native Sessions are still mounting.
 * That is not a completed scientific round. A forced startup snapshot may persist it,
 * but must leave its durable intents open for the unresolved actor's resumed decision. */
export function snapshotMayCommitRound(state: { v05: boolean; teamReady: boolean; infrastructureFailed: boolean }): boolean {
  return !state.v05 || state.teamReady && !state.infrastructureFailed
}

/** Startup snapshots may retain unresolved slots. After mounting, a held actor has
 * not settled its inherited slot until it actually enters a current-tick request. */
export function resumeSlotsSettled(state: { v05: boolean; teamReady: boolean; incomplete: ReadonlySet<string> }): boolean {
  return !state.v05 || !state.teamReady || state.incomplete.size === 0
}
