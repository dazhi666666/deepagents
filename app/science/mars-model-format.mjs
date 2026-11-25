/** Detect a native tool envelope stranded in text. Never parse or execute its arguments. */
export function strandedToolEnvelope(text, allowedNames) {
  if (typeof text !== 'string') return null
  const visible = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  if (!/<\/[｜|]DSML[｜|]tool_calls\s*>/.test(visible)) return null
  const names = [...visible.matchAll(/<invoke\s+name\s*=\s*["']([^"']+)["']/g)].map(match => match[1]).filter(name => allowedNames.has(name))
  return names.length ? { reason: 'text_tool_call', tools: [...new Set(names)] } : null
}
