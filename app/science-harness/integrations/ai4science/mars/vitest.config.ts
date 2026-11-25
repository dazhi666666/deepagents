import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../../../../science-harness/vitest.shared.ts'
import { kitAliases } from '../../vitest-aliases.ts'
export default defineConfig({ plugins: [standardDecoratorPlugin()], resolve: { alias: kitAliases },
  test: { include: ['integrations/ai4science/mars/**/*.spec.ts'], testTimeout: 30000 } })
