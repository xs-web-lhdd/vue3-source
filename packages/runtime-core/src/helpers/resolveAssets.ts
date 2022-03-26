import {
  currentInstance,
  ConcreteComponent,
  ComponentOptions,
  getComponentName
} from '../component'
import { currentRenderingInstance } from '../componentRenderContext'
import { Directive } from '../directives'
import { camelize, capitalize, isString } from '@vue/shared'
import { warn } from '../warning'
import { VNodeTypes } from '../vnode'

export const COMPONENTS = 'components'
export const DIRECTIVES = 'directives'
export const FILTERS = 'filters'

export type AssetTypes = typeof COMPONENTS | typeof DIRECTIVES | typeof FILTERS

/**
 * @private
 */
export function resolveComponent(
  name: string,
  maybeSelfReference?: boolean
): ConcreteComponent | string {
  return resolveAsset(COMPONENTS, name, true, maybeSelfReference) || name
}

export const NULL_DYNAMIC_COMPONENT = Symbol()

/**
 * @private
 */
export function resolveDynamicComponent(component: unknown): VNodeTypes {
  if (isString(component)) {
    return resolveAsset(COMPONENTS, component, false) || component
  } else {
    // invalid types will fallthrough to createVNode and raise warning
    return (component || NULL_DYNAMIC_COMPONENT) as any
  }
}

/**
 * @private
 */
// 指令函数：
export function resolveDirective(name: string): Directive | undefined {
  return resolveAsset(DIRECTIVES, name)
}

/**
 * v2 compat only
 * @internal
 */
export function resolveFilter(name: string): Function | undefined {
  return resolveAsset(FILTERS, name)
}

/**
 * @private
 * overload 1: components
 */
function resolveAsset(
  type: typeof COMPONENTS,
  name: string,
  warnMissing?: boolean,
  maybeSelfReference?: boolean
): ConcreteComponent | undefined
// overload 2: directives
function resolveAsset(
  type: typeof DIRECTIVES,
  name: string
): Directive | undefined
// implementation
// overload 3: filters (compat only)
function resolveAsset(type: typeof FILTERS, name: string): Function | undefined
// implementation
function resolveAsset(
  type: AssetTypes,
  name: string,
  warnMissing = true,
  maybeSelfReference = false
) {
  // 获取当前渲染实例：
  const instance = currentRenderingInstance || currentInstance
  if (instance) {
    const Component = instance.type

    // explicit self name has highest priority
    if (type === COMPONENTS) {
      const selfName = getComponentName(Component)
      if (
        selfName &&
        (selfName === name ||
          selfName === camelize(name) ||
          selfName === capitalize(camelize(name)))
      ) {
        return Component
      }
    }

    // 先去组件实例上局部查找是否注册指令，如果没有再去全局查找指令
    const res =
      // local registration
      // check instance[type] first which is resolved for options API
      // 局部注册：在对指令进行操作的时候，instance 是组件实例，type 是 directives，所以 resolve 函数第一实参就是该实例上的指令对象，第二实参是指令名称
      // 对应 01-directive.html 文件那么第一实参就是下面 directives 对应的那个对象，第二实参就是像 focus bbb 这样的指令名称
      /* directives: {
        focus: {
          mounted(el) {
            el.focus()
          },
          updated() {
            console.log(111);
          }
        },
        aaa: {
          beforeUpdate() {
            console.log('beforeUpdated');
          }
        },
        bbb: () => {
          console.log('我是函数的情况');
        }
      }, */
      resolve(instance[type] || (Component as ComponentOptions)[type], name) ||
      // global registration
      // 全局注册：
      resolve(instance.appContext[type], name)

    if (!res && maybeSelfReference) {
      // fallback to implicit self-reference
      return Component
    }

    // 都没找到就去开发环境中报警告
    if (__DEV__ && warnMissing && !res) {
      const extra =
        type === COMPONENTS
          ? `\nIf this is a native custom element, make sure to exclude it from ` +
            `component resolution via compilerOptions.isCustomElement.`
          : ``
      warn(`Failed to resolve ${type.slice(0, -1)}: ${name}${extra}`)
    }

    return res
  } else if (__DEV__) {
    warn(
      `resolve${capitalize(type.slice(0, -1))} ` +
        `can only be used in render() or setup().`
    )
  }
}

// 查找指令：先根据 name 匹配，如果失败则把 name 变成驼峰格式继续匹配，还匹配不到则把 name 首字母大写后继续匹配 --->>> 这样做是为了让用户编写的指令更加灵活
function resolve(registry: Record<string, any> | undefined, name: string) {
  return (
    registry &&
    (registry[name] ||
      registry[camelize(name)] ||
      registry[capitalize(camelize(name))])
  )
}
