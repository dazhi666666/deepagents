import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../../../../science-harness/vitest.shared.ts'
import { kitAliases } from '../../vitest-aliases.ts'
export default defineConfig({ plugins: [standardDecoratorPlugin()], resolve: { alias: kitAliases },
  // The laboratory scenario tests drive whole scripted missions; they run for
  // minutes on slower hosts.
  test: { include: ['integrations/ai4science/greenhouse/**/*.spec.ts'], testTimeout: 120000 } })
