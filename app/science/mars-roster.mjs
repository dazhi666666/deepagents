/** Fixed roster ordering used by configuration, admission and journals. */
const six = Object.freeze(['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst'])
const eight = Object.freeze([...six, 'service', 'verifier'])
const single = Object.freeze(['single'])

export function marsRoster(mode, teamSize = 6) {
  if (teamSize !== 6 && teamSize !== 8) throw new Error('Mars teamSize must be 6 or 8')
  if (mode === 'single') return single
  if (mode === 'multi') return teamSize === 8 ? eight : six
  throw new Error('Mars mode must be single or multi')
}

/** Runs written before explicit roster metadata used the six-member team. */
export function assertMarsRoster(manifest, mode, roles) {
  if (manifest.mode !== mode && manifest.mode !== `${mode}-agent`) throw new Error('Existing Mars run manifest differs: mode')
  const stored = Object.hasOwn(manifest, 'roles') ? manifest.roles : marsRoster(mode, 6)
  if (!Array.isArray(stored) || stored.length !== roles.length || stored.some((role, index) => role !== roles[index])) {
    throw new Error('Mars roster differs from the saved run. Use a fresh home or select the saved roster.')
  }
}
