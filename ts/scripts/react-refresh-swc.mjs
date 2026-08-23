import { createRequire } from 'node:module'

export function createReactRefreshSwcTransform() {
  const require = createRequire(import.meta.url)
  const swc = require('@swc/core')

  return async function transformReactRefresh(source, { filename, isTs, isJsx }) {
    const result = await swc.transform(source, {
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
            refresh: {
              refreshReg: '$RNGPUIRefreshReg$',
              refreshSig: '$RefreshSig$',
              emitFullSignatures: false,
            },
          },
        },
      },
      module: {
        type: 'es6',
      },
    })
    const moduleId = JSON.stringify(filename)
    return `const $RNGPUIRefreshReg$ = (type, id) => globalThis.$RefreshReg$(type, ${moduleId} + " " + id);\n${result.code}`
  }
}
