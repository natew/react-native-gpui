import { createRequire } from 'node:module'

export function createReactRefreshSwcTransform() {
  const require = createRequire(import.meta.url)
  const swc = require('@swc/core')

  return async function transformReactRefresh(source, { filename, isTs, isJsx }) {
    const result = swc.transformSync(source, {
      filename,
      sourceMaps: false,
      jsc: {
        target: 'es2022',
        parser: isTs
          ? { syntax: 'typescript', tsx: isJsx }
          : { syntax: 'ecmascript', jsx: isJsx },
        transform: {
          react: {
            runtime: 'automatic',
            development: true,
            refresh: true,
          },
        },
      },
      module: {
        type: 'es6',
      },
    })
    return result.code
  }
}
