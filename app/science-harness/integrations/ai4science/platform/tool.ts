/** Shared JSON tool registration; each composition supplies its own live-caller and capability checks. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Materialize a tool result or recorded fact using the existing JSON serialization policy.
 * @param value JSON-serializable result; unsupported values retain native JSON errors.
 * @returns Detached JSON data.
 */
export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Build a registrar with composition-owned authorization and one shared output renderer.
 * @param ctx Context owning every returned tool registration.
 * @param authorize Validate the execution and return its grant before the body runs.
 * @returns Register a named JSON tool and return its Cordis-owned disposer.
 */
export function createJsonToolRegistrar<Grant>(
  ctx: Context,
  authorize: (execution: ToolRunContext, name: string) => Grant,
) {
  return (
    name: string,
    description: string,
    parameters: ParameterSchemaSpec,
    body: (args: Record<string, unknown>, execution: ToolRunContext, grant: Grant) => unknown,
  ) => ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const grant = authorize(execution, name)
      return jsonValue(await body(args, execution, grant))
    },
  }))
}
