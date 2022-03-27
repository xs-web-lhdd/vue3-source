// 组件自定义事件处理逻辑： 
import {
  camelize,
  EMPTY_OBJ,
  toHandlerKey,
  extend,
  hasOwn,
  hyphenate,
  isArray,
  isFunction,
  isOn,
  toNumber,
  UnionToIntersection
} from '@vue/shared'
import {
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  formatComponentName
} from './component'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { warn } from './warning'
import { devtoolsComponentEmit } from './devtools'
import { AppContext } from './apiCreateApp'
import { emit as compatInstanceEmit } from './compat/instanceEventEmitter'
import {
  compatModelEventPrefix,
  compatModelEmit
} from './compat/componentVModel'

export type ObjectEmitsOptions = Record<
  string,
  ((...args: any[]) => any) | null
>

export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitsToProps<T extends EmitsOptions> = T extends string[]
  ? {
      [K in string & `on${Capitalize<T[number]>}`]?: (...args: any[]) => any
    }
  : T extends ObjectEmitsOptions
  ? {
      [K in string &
        `on${Capitalize<string & keyof T>}`]?: K extends `on${infer C}`
        ? T[Uncapitalize<C>] extends null
          ? (...args: any[]) => any
          : (
              ...args: T[Uncapitalize<C>] extends (...args: infer P) => any
                ? P
                : never
            ) => any
        : never
    }
  : {}

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => void
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
  ? (event: string, ...args: any[]) => void
  : UnionToIntersection<
      {
        [key in Event]: Options[key] extends (...args: infer Args) => any
          ? (event: key, ...args: Args) => void
          : (event: key, ...args: any[]) => void
      }[Event]
    >

// 自定义事件 emit 派发:   调试用例可用 01-emit.html
export function emit(
  instance: ComponentInternalInstance,
  event: string, // 自定义事件名称
  ...rawArgs: any[] // 事件传递的参数
) {
  // 拿到组件自身的 props，这里的 props 指的是父组件传递过来的属性
  const props = instance.vnode.props || EMPTY_OBJ

  // 在开发环境下检验用 emits 检验 emit 是否合法
  if (__DEV__) {
    const {
      emitsOptions,
      propsOptions: [propsOptions]
    } = instance
    if (emitsOptions) {
      if (
        !(event in emitsOptions) &&
        !(
          __COMPAT__ &&
          (event.startsWith('hook:') ||
            event.startsWith(compatModelEventPrefix))
        )
      ) {
        if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
          warn(
            `Component emitted event "${event}" but it is neither declared in ` +
              `the emits option nor as an "${toHandlerKey(event)}" prop.`
          )
        }
      } else {
        // 从 emits 中取出对应的检验函数
        const validator = emitsOptions[event]
        // 如果 emits 中对应的是函数，那么就拿出来把参数传递进去执行一下，如果返回为 false，则表明检验不成功，会在控制台报警告
        if (isFunction(validator)) {
          const isValid = validator(...rawArgs)
          if (!isValid) {
            warn(
              `Invalid event arguments: event validation failed for event "${event}".`
            )
          }
        }
      }
    }
  }

  // 拿到参数：
  let args = rawArgs
  const isModelListener = event.startsWith('update:')

  // for v-model update:xxx events, apply modifiers on args
  // 这是 v-mode 的情况，因为 v-mode 内部就是 emit('update:modelValue') 的语法糖，所以这里进行了特殊处理   见测试用例 01-vModel2.html
  const modelArg = isModelListener && event.slice(7)
  if (modelArg && modelArg in props) {
    // 针对 v-model 起别名的措施:
    const modifiersKey = `${
      modelArg === 'modelValue' ? 'model' : modelArg
    }Modifiers`
    // 解析出来父组件 v-model 的修饰符，然后对传过去的参数进行处理
    const { number, trim } = props[modifiersKey] || EMPTY_OBJ
    if (trim) {
      args = rawArgs.map(a => a.trim())
    } else if (number) {
      args = rawArgs.map(toNumber)
    }
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args)
  }

  if (__DEV__) {
    const lowerCaseEvent = event.toLowerCase()
    if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
      warn(
        `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(
            instance,
            instance.type
          )} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
      )
    }
  }

  // 通过 toHandlerKey 标准化事件名称,首字母大写并在前面加上 on
  let handlerName
  // 根据对应的事件名称去 props 中找到对应的回调函数
  let handler =
    props[(handlerName = toHandlerKey(event))] ||
    // also try camelCase event handler (#2249)
    props[(handlerName = toHandlerKey(camelize(event)))]
  // for v-model update:xxx events, also trigger kebab-case equivalent
  // for props passed via kebab-case
  // 如果找不到回调函数,并且event 是以 update 开头的,则尝试将 event 转换为连字符再进行处理
  if (!handler && isModelListener) {
    handler = props[(handlerName = toHandlerKey(hyphenate(event)))]
  }

  // 有回调函数就执行相应的回调函数并且把参数 args 传入 
  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  // 事件只执行一次的逻辑： 事件第一次执行会往实例 emitted 上设置事件名为 true，接着执行事件，然后第二次执行时会走向 else if 逻辑里面直接返回从而不执行事件
  const onceHandler = props[handlerName + `Once`]
  if (onceHandler) {
    // 如果实例身上没有 emitted 那么就挂载一个空对象
    if (!instance.emitted) {
      instance.emitted = {} as Record<any, boolean>
    } else if (instance.emitted[handlerName]) {
      return
    }
    // 事件第一次执行会往实例 emitted 上设置事件名为 true，接着执行事件
    instance.emitted[handlerName] = true
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  if (__COMPAT__) {
    compatModelEmit(instance, event, args)
    return compatInstanceEmit(instance, event, args)
  }
}

// 组件实例创建时标准化 emits 选项的操作:  调试用例可以用 01-emits.html
export function normalizeEmitsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): ObjectEmitsOptions | null {
  // 从全局 emits 的缓存中拿出该组件相应的缓存, 缓存存在就直接返回
  const cache = appContext.emitsCache
  const cached = cache.get(comp)
  if (cached !== undefined) {
    return cached
  }

  // 拿出组件内部定义的 emits 选项:
  const raw = comp.emits
  let normalized: ObjectEmitsOptions = {}

  // apply mixin/extends props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendEmits = (raw: ComponentOptions) => {
      const normalizedFromExtend = normalizeEmitsOptions(raw, appContext, true)
      if (normalizedFromExtend) {
        hasExtends = true
        extend(normalized, normalizedFromExtend)
      }
    }
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits)
    }
    if (comp.extends) {
      extendEmits(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits)
    }
  }

  // 如果组件身上没有 emits 选项,并且 mixin 和 extends 中也没有 emits 选项,就在缓存中设置组件对应的 emits 为 null
  if (!raw && !hasExtends) {
    cache.set(comp, null)
    return null
  }

  // 官网解释：https://v3.cn.vuejs.org/guide/migration/emits-option.html#_3-x-%E7%9A%84%E8%A1%8C%E4%B8%BA
  // 如果 emits 是 emits: ['xxx', 'yyy'] 这种形式就标准为: {xxx: null, yyy: null} 这种格式
  if (isArray(raw)) {
    raw.forEach(key => (normalized[key] = null))
  } else {
    // 该选项也可以接收一个对象，该对象允许开发者定义传入事件参数的验证器，和 props 定义里的验证器类似。  这种情况直接浅拷贝就行了
    extend(normalized, raw)
  }

  // 往缓存中设置组件对应的标准化后的 emits 
  cache.set(comp, normalized)
  return normalized
}

// Check if an incoming prop key is a declared emit event listener.
// e.g. With `emits: { click: null }`, props named `onClick` and `onclick` are
// both considered matched listeners.
export function isEmitListener(
  options: ObjectEmitsOptions | null,
  key: string
): boolean {
  if (!options || !isOn(key)) {
    return false
  }

  if (__COMPAT__ && key.startsWith(compatModelEventPrefix)) {
    return true
  }

  key = key.slice(2).replace(/Once$/, '')
  return (
    hasOwn(options, key[0].toLowerCase() + key.slice(1)) ||
    hasOwn(options, hyphenate(key)) ||
    hasOwn(options, key)
  )
}
