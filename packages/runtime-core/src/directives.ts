/**
Runtime helper for applying directives to a vnode. Example usage:

const comp = resolveComponent('comp')
const foo = resolveDirective('foo')
const bar = resolveDirective('bar')

return withDirectives(h(comp), [
  [foo, this.x],
  [bar, this.y]
])
*/

import { VNode } from './vnode'
import { isFunction, EMPTY_OBJ, isBuiltInDirective } from '@vue/shared'
import { warn } from './warning'
import { ComponentInternalInstance, Data } from './component'
import { currentRenderingInstance } from './componentRenderContext'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { ComponentPublicInstance } from './componentPublicInstance'
import { mapCompatDirectiveHook } from './compat/customDirective'
import { pauseTracking, resetTracking } from '@vue/reactivity'
import { traverse } from './apiWatch'

export interface DirectiveBinding<V = any> {
  instance: ComponentPublicInstance | null
  value: V
  oldValue: V | null
  arg?: string
  modifiers: DirectiveModifiers
  dir: ObjectDirective<any, V>
}

export type DirectiveHook<T = any, Prev = VNode<any, T> | null, V = any> = (
  el: T,
  binding: DirectiveBinding<V>,
  vnode: VNode<any, T>,
  prevVNode: Prev
) => void

export type SSRDirectiveHook = (
  binding: DirectiveBinding,
  vnode: VNode
) => Data | undefined

export interface ObjectDirective<T = any, V = any> {
  created?: DirectiveHook<T, null, V>
  beforeMount?: DirectiveHook<T, null, V>
  mounted?: DirectiveHook<T, null, V>
  beforeUpdate?: DirectiveHook<T, VNode<any, T>, V>
  updated?: DirectiveHook<T, VNode<any, T>, V>
  beforeUnmount?: DirectiveHook<T, null, V>
  unmounted?: DirectiveHook<T, null, V>
  getSSRProps?: SSRDirectiveHook
  deep?: boolean
}

export type FunctionDirective<T = any, V = any> = DirectiveHook<T, any, V>

export type Directive<T = any, V = any> =
  | ObjectDirective<T, V>
  | FunctionDirective<T, V>

export type DirectiveModifiers = Record<string, boolean>

// 验证指令是否合法
export function validateDirectiveName(name: string) {
  if (isBuiltInDirective(name)) {
    warn('Do not use built-in directive ids as custom directive id: ' + name)
  }
}

// Directive, value, argument, modifiers
export type DirectiveArguments = Array<
  | [Directive]
  | [Directive, any]
  | [Directive, any, string]
  | [Directive, any, string, DirectiveModifiers]
>

/**
 * Adds directives to a VNode.
 */
// 第一参是 vnode 第二参是指令构成的数组（一个元素节点身上是可以有多个指令的）
export function withDirectives<T extends VNode>(
  vnode: T,
  directives: DirectiveArguments // 这个参数是该节点上全部指令对应的数组, 例如对应 01-directive.html 就是 [[{mounted(){}, updated(){}}, 111, undefined], [{beforeUpdate(){}}], []] 这种格式
): T {
  const internalInstance = currentRenderingInstance
  if (internalInstance === null) {
    __DEV__ && warn(`withDirectives can only be used inside render functions.`)
    return vnode
  }
  const instance = internalInstance.proxy
  // 给节点创建一个 dirs 属性为一个空数组，用来存放其身上的全部指令，且赋值给 bindings
  const bindings: DirectiveBinding[] = vnode.dirs || (vnode.dirs = [])
  // 循环指令数组：
  for (let i = 0; i < directives.length; i++) {
    // 指令对象 值     参数   修饰符    这里面 dir 对应的就是指令对象（也可能是函数），就是指令名称对应的那个对象
    /* 例如： 
    .directive('focus', {
      mounted(el) {
        el.focus()
      }
    }) */
    // 在上面那个例子中 directive 里面那个第二个参数（也可以是函数）就是 dir
    let [dir, value, arg, modifiers = EMPTY_OBJ] = directives[i]
    if (isFunction(dir)) {
      // 如果注册指令时的第二参（dir）是函数，就对参数进行包装处理，包装为对象
      // 这种情况官方文档说的很清楚（只想 mounted updated 时触发相同行为而不关心其他的钩子函数）：https://v3.cn.vuejs.org/guide/custom-directive.html#%E5%87%BD%E6%95%B0%E7%AE%80%E5%86%99
      dir = {
        mounted: dir,
        updated: dir
      } as ObjectDirective
    }
    if (dir.deep) {
      traverse(value)
    }
    bindings.push({
      dir,
      instance,
      value,
      oldValue: void 0,
      arg,
      modifiers
    })
  }
  return vnode
}

// 这个函数是指令对应声明周期执行的具体函数，其实就是把节点里面指令组成的数组中的每个指令拿出来，然后找到对应指令对象（dir），然后找指令对象里面对应 name 的钩子函数，拿出来执行
export function invokeDirectiveHook(
  vnode: VNode, // 新 vnode
  prevVNode: VNode | null, // 旧 vnode
  instance: ComponentInternalInstance | null, // 组件实例
  name: keyof ObjectDirective // 钩子函数的名称
) {
  // 取出节点对应的所有指令所构成的数组
  const bindings = vnode.dirs! // 这里对应上面 withDirectives 函数中的 const bindings: DirectiveBinding[] = vnode.dirs || (vnode.dirs = []) 这行代码
  const oldBindings = prevVNode && prevVNode.dirs!
  // 遍历每个指令构成的数组,拿出每一个指令
  for (let i = 0; i < bindings.length; i++) {
    // 拿出每一个指令，是一个对象的形式，对应上面 withDirectives 函数中的 bindings.push({}) 操作里面的那个对象
    const binding = bindings[i] 
    if (oldBindings) {
      binding.oldValue = oldBindings[i].value
    }
    // 取出指令里面对应的钩子函数
    let hook = binding.dir[name] as DirectiveHook | DirectiveHook[] | undefined
    if (__COMPAT__ && !hook) {
      hook = mapCompatDirectiveHook(name, binding.dir, instance)
    }
    // 如果有钩子函数，就执行相应的钩子函数
    if (hook) {
      // disable tracking inside all lifecycle hooks
      // since they can potentially be called inside effects.
      // 禁止在声明周期内部追踪依赖
      pauseTracking()
      callWithAsyncErrorHandling(hook, instance, ErrorCodes.DIRECTIVE_HOOK, [
        vnode.el,
        binding,
        vnode,
        prevVNode
      ])
      resetTracking()
    }
  }
}
