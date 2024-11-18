import { type ParseResult, types as t, parseSync } from '@babel/core'

/**
 * 标识符
 */
export enum HmrId {
  hmr = '__$vitarx_vite_hmr$__',
  vnode = '__$vitarx_vnode$__',
  state = '__$vitarx_state$__',
  manager = '__$vitarx_hmr_manager$__'
}

let createVNodeDeclarationCache: t.VariableDeclaration | null = null
let createHmrHandlerCache: t.Statement[] | null = null
let createHmrRegisterHandlerCache: t.CallExpression | null = null

/**
 * 检查是否已经存在指定的 import 语句
 *
 * @param ast - AST 树
 * @param moduleName - 模块名称
 * @param importNames - 导入的标识符名称数组
 * @returns {string[]} - 未导入的标识符数组
 */
export function hasImport(ast: t.File, moduleName: string, importNames: string[]): string[] {
  const notImported: string[] = []

  // 获取已导入的标识符名称集合
  const importedSet = new Set<string>()

  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node) && node.source.value === moduleName) {
      for (const specifier of node.specifiers) {
        if (t.isImportSpecifier(specifier) && 'name' in specifier.imported) {
          importedSet.add(specifier.imported.name)
        }
      }
    }
  }
  // 检查每个 importName 是否已导入
  for (const importName of importNames) {
    if (!importedSet.has(importName)) {
      notImported.push(importName)
    }
  }

  return notImported
}

/**
 * 创建vnode变量声明语句
 *
 * ```ts
 * const __$vnode$__ = getCurrentVNode()
 * ```
 *
 * @returns {t.VariableDeclaration} - vnode变量声明语句
 */
function createVNodeDeclaration(): t.VariableDeclaration {
  if (!createVNodeDeclarationCache) {
    createVNodeDeclarationCache = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier(HmrId.vnode),
        t.callExpression(t.identifier('getCurrentVNode'), [])
      )
    ])
  }
  return createVNodeDeclarationCache
}

/**
 * 创建热更新注册处理程序
 */
function createHmrRegisterHandler() {
  if (!createHmrRegisterHandlerCache) {
    createHmrRegisterHandlerCache = t.callExpression(
      t.memberExpression(t.identifier(HmrId.manager), t.identifier('register')),
      [t.identifier(HmrId.vnode)]
    )
  }

  return createHmrRegisterHandlerCache
}

/**
 * 创建vnode缓存处理程序
 */
function createHmrHandler() {
  if (createHmrHandlerCache) return createHmrHandlerCache
  const code = `
  const ${HmrId.manager} = new ${HmrId.hmr}.ModuleManager()
  import.meta.hot.accept(mod => {
    const updateResult = ${HmrId.manager}.update(mod)
    typeof updateResult === 'string' && import.meta.hot.invalidate(updateResult)
  })
`
  const parsed = parseSync(code)
  // 提取if节点
  return (createHmrHandlerCache = parsed!.program.body)
}

/**
 * 导入客户端热更新所需的依赖
 *
 * @param ast
 */
export function importHmrClientDeps(ast: ParseResult) {
  // 如果开发环境，则添加，HMR 热更新处理所需要的依赖
  if (process.env.NODE_ENV === 'development') {
    const injects: t.Statement[] = []

    // 插入 import * as __$hmr$__ from "@vitarx/vite-plugin-vitarx"
    const hmrImportStatement = t.importDeclaration(
      [t.importNamespaceSpecifier(t.identifier(HmrId.hmr))],
      t.stringLiteral('/src/hmr-client.ts') // npm run build 时会自动替换为@vitarx/vite-plugin-vitarx/hmr-client.js
    )
    injects.push(hmrImportStatement)

    // 插入 import { getCurrentVNode } from 'vitarx'
    const importVitarx = hasImport(ast, 'vitarx', ['getCurrentVNode'])
    if (importVitarx.length > 0) {
      const importStatement = t.importDeclaration(
        importVitarx.map(name => t.importSpecifier(t.identifier(name), t.identifier(name))),
        t.stringLiteral('vitarx')
      )
      injects.push(importStatement)
    }
    ast.program.body.unshift(...injects)

    // 插入 vnode 缓存处理程序
    ast.program.body.push(...createHmrHandler())
  }
}

/**
 * 处理函数代码块变量声明
 *
 * @param statement
 * @param states
 */
export function handleFnVariableDeclaration(statement: t.VariableDeclaration, states: Set<string>) {
  for (const declarator of statement.declarations) {
    const varName = declarator.id.type === 'Identifier' ? declarator.id.name : null
    if (!varName) continue
    if (t.isCallExpression(declarator.init)) {
      const callee = declarator.init.callee
      const callName = callee.type === 'Identifier' ? callee.name : null
      if (!callName) continue
      if (callName === 'ref' || callName === 'reactive') {
        // 获取调用表达式的参数
        const args = declarator.init.arguments
        const defaultValue = args.length > 0 ? args[0] : t.nullLiteral()
        // 创建新的表达式
        declarator.init = t.logicalExpression(
          '||',
          t.callExpression(t.identifier(`${HmrId.hmr}.getState`), [
            t.identifier(HmrId.vnode),
            t.stringLiteral(varName)
          ]),
          t.parenthesizedExpression(t.callExpression(callee, [defaultValue]))
        )
        states.add(varName)
      }
    }
  }
}

/**
 * 注入函数组件状态处理程序
 *
 * @param block
 * @param states
 */
export function injectFnWidgetHmrHandler(block: t.BlockStatement, states: Set<string>) {
  if (process.env.NODE_ENV !== 'development') return
  // 动态生成状态对象 getter
  const stateProperties = Array.from(states).map(stateName => {
    return t.objectMethod(
      'get',
      t.identifier(stateName),
      [],
      t.blockStatement([t.returnStatement(t.identifier(stateName))])
    )
  })
  const stateObject = t.objectExpression(stateProperties)
  // 创建状态对象挂载语句
  const stateMount = t.expressionStatement(
    t.callExpression(
      t.memberExpression(
        t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), []),
        t.identifier('then')
      ),
      [
        t.arrowFunctionExpression(
          [],
          t.blockStatement([
            t.expressionStatement(
              t.assignmentExpression(
                '=',
                t.memberExpression(t.identifier(HmrId.vnode), t.identifier(HmrId.state)),
                stateObject
              )
            )
          ])
        )
      ]
    )
  )
  block.body.unshift(
    createVNodeDeclaration(),
    createHmrRegisterHandler() as unknown as t.Statement,
    stateMount
  )
}


