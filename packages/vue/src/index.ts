// This entry is the "full-build" that includes both the runtime
// and the compiler, and supports on-the-fly compilation of the template option.
import { initDev } from './dev'
import { compile, CompilerOptions, CompilerError } from '@vue/compiler-dom'
import { registerRuntimeCompiler, RenderFunction, warn } from '@vue/runtime-dom'
import * as runtimeDom from '@vue/runtime-dom'
import { isString, NOOP, generateCodeFrame, extend } from '@vue/shared'
import { InternalRenderFunction } from 'packages/runtime-core/src/component'

if (__DEV__) {
  initDev()
}

const compileCache: Record<string, RenderFunction> = Object.create(null)

// 入口文件只做了一件事，定义了一个编译函数：
// 为浏览器平台单独
function compileToFunction(
  template: string | HTMLElement,
  options?: CompilerOptions
): RenderFunction {
  if (!isString(template)) {
    // DOM
    if (template.nodeType) {
      // 从宿主元素的innerHTML中获取模板
      template = template.innerHTML
    } else {
      __DEV__ && warn(`invalid template option: `, template)
      return NOOP
    }
  }

  const key = template
  const cached = compileCache[key]
  if (cached) {
    return cached
  }

  // 用户传入的是选择器：
  if (template[0] === '#') {
    // 拿到选择器所指的元素节点：
    const el = document.querySelector(template)
    if (__DEV__ && !el) {
      warn(`Template element not found or is empty: ${template}`)
    }
    // __UNSAFE__
    // Reason: potential execution of JS expressions in in-DOM template.
    // The user must make sure the in-DOM template is trusted. If it's rendered
    // by the server, the template should not contain any user data.
    // 拿到 template 选项：
    template = el ? el.innerHTML : ``
  }

  // 将模板编译成字符串：
  const { code } = compile(
    template,
    extend(
      {
        hoistStatic: true,
        onError: __DEV__ ? onError : undefined,
        onWarn: __DEV__ ? e => onError(e, true) : NOOP
      } as CompilerOptions,
      options
    )
  )

  function onError(err: CompilerError, asWarning = false) {
    const message = asWarning
      ? err.message
      : `Template compilation error: ${err.message}`
    const codeFrame =
      err.loc &&
      generateCodeFrame(
        template as string,
        err.loc.start.offset,
        err.loc.end.offset
      )
    warn(codeFrame ? `${message}\n${codeFrame}` : message)
  }

  // The wildcard import results in a huge object with every export
  // with keys that cannot be mangled, and can be quite heavy size-wise.
  // In the global build we know `Vue` is available globally so we can avoid
  // the wildcard object.

  // "const _Vue = Vue
  // const { createElementVNode: _createElementVNode, createTextVNode: _createTextVNode } = _Vue
  
  // const _hoisted_1 = /*#__PURE__*/_createTextVNode(" 这是一个标题 ")
  
  // return function render(_ctx, _cache) {
  //   with (_ctx) {
  //     const { toDisplayString: _toDisplayString, createElementVNode: _createElementVNode, createTextVNode: _createTextVNode, Fragment: _Fragment, openBlock: _openBlock, createElementBlock: _createElementBlock } = _Vue
  
  //     return (_openBlock(), _createElementBlock(_Fragment, null, [
  //       _createElementVNode("h1", null, _toDisplayString(title), 1 /* TEXT */),
  //       _hoisted_1
  //     ], 64 /* STABLE_FRAGMENT */))
  //   }
  // }"

  const render = (
    // 将编译出来的字符串转化为渲染函数：
    __GLOBAL__ ? new Function(code)() : new Function('Vue', code)(runtimeDom)
  ) as RenderFunction

  // mark the function as runtime compiled
  ;(render as InternalRenderFunction)._rc = true

  return (compileCache[key] = render)
}

registerRuntimeCompiler(compileToFunction)

export { compileToFunction as compile }
export * from '@vue/runtime-dom'
