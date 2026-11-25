/** Optional model-origin routing through a physical interface, retaining normal TLS verification. */
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { Agent, Dispatcher, buildConnector, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { z } from 'zod'

export const name = 'greenhouse-direct-transport'
export const inject = []
/** Explicit model origin and interface settings shared by the owning Agent profile. */
export const directTransportSchema = z.object({ origin: z.url(), interface: z.string().min(1),
  address: z.string().refine(value => isIP(value) === 4, 'Expected a public DNS-resolved IPv4 address'),
  additionalOrigins: z.array(z.object({ origin: z.url(),
    address: z.string().refine(value => isIP(value) === 4, 'Expected a public DNS-resolved IPv4 address') }).strict()).optional(),
}).strict()
export type Config = z.infer<typeof directTransportSchema>

/** Route the configured HTTPS model origins through one physical interface.
 * @param ctx Plugin lifetime owning the dispatcher and its sockets.
 * @param input Explicit model origin, physical interface and DNS-resolved IPv4; no credentials.
 */
export function apply(ctx: Context, input: Config): void {
  const config = directTransportSchema.parse(input)
  const routes = [config, ...(config.additionalOrigins ?? [])].map(route => {
    const url = new URL(route.origin)
    if (url.protocol !== 'https:' || url.origin !== route.origin || url.username || url.password)
      throw new Error('Direct model routing requires an HTTPS origin without credentials or a path')
    return { ...route, hostname: url.hostname }
  })
  if (new Set(routes.map(route => route.origin)).size !== routes.length) throw new Error('Duplicate direct model origin')
  const interfaceAddress = () => networkInterfaces()[config.interface]?.find(item => item.family === 'IPv4' && !item.internal)?.address
  const localAddress = interfaceAddress()
  ctx.effect(() => {
    const previous = getGlobalDispatcher()
    const agents = new Map(routes.map(route => {
      const connect = buildConnector({ lookup(hostname, options, callback) {
        // Socket error listeners must be installed before lookup completion can emit a bind error.
        queueMicrotask(() => {
          if (hostname !== route.hostname) return callback(new Error('Unexpected direct model hostname'), '', 4)
          if (options.all) callback(null, [{ address: route.address, family: 4 }])
          else callback(null, route.address, 4)
        })
      } })
      const direct = new Agent({ connect(options, callback) {
        const address = interfaceAddress()
        if (!address) {
          const error: NodeJS.ErrnoException = new Error(`Physical IPv4 interface unavailable: ${config.interface}`)
          error.code = 'ENETUNREACH'
          queueMicrotask(() => callback(error, null))
          return
        }
        connect({ ...options, localAddress: address }, callback)
      } })
      return [route.origin, direct] as const
    }))
    const scoped = new class extends Dispatcher {
      override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
        return (agents.get(String(options.origin)) ?? previous).dispatch(options, handler)
      }
    }()
    setGlobalDispatcher(scoped)
    console.log(`Greenhouse model source address: ${localAddress ?? 'unavailable; requests wait for physical connectivity through supervision'} (${config.interface}); verify the actual socket interface separately; TLS hostname verification enabled`)
    return async () => {
      if (getGlobalDispatcher() === scoped) setGlobalDispatcher(previous)
      await Promise.all([...agents.values()].map(direct => direct.close()))
    }
  }, 'greenhouse.direct-transport')
}
