import { Plugin, type ResolvedConfig } from 'vite'
import handleJsxOrTsxFileCode from './jsx-handler.js'

export default function vitePluginVitarx(): Plugin {
  let sourcemap: boolean | 'inline' | 'hidden' = false
  return {
    name: 'vite-plugin-vitarx',
    config(config) {
      if (!config.esbuild) {
        config.esbuild = {
          jsx: 'automatic',
          jsxImportSource: 'vitarx/dist'
        }
      } else {
        config.esbuild.jsx = 'automatic'
        config.esbuild.jsxImportSource = 'vitarx/dist'
      }
      return config
    },
    configResolved(config: ResolvedConfig) {
      sourcemap = config.build.sourcemap
    },
    transform(code, id) {
      // 仅处理 .jsx 或 .tsx 文件
      if (id.endsWith('.jsx') || id.endsWith('.tsx')) {
        return handleJsxOrTsxFileCode(code, {
          sourceMaps: sourcemap !== 'hidden',
          sourceFileName: id
        })
      }
      return {
        code,
        map: null
      }
    }
  }
}
