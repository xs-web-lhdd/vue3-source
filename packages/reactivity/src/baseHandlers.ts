import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
// 浅响应式的 get 操作:
const shallowGet = /*#__PURE__*/ createGetter(false, true)
// 只读的 getter 操作:
const readonlyGet = /*#__PURE__*/ createGetter(true)
// 浅只读的 getter 操作:
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

// 对数组身上一些特殊情况的处理: 例如 includes indexOf 等等否则可能会在某些场景下报一些出乎意料的错误  P128 - P131
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // toRaw 是把响应式数据转换为 原始数据
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        // 然后进行依赖收集
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 为了避免一些无限循环的情况，我们需要重写一些方法，如：push 等
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 停止追踪依赖
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      // 回复追踪依赖
      resetTracking()
      return res
    }
  })
  return instrumentations
}

// 执行 get 操作，实际执行的函数, 默认创建深响应式 不是只读的响应式对象
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      // 增加一个标识 'raw' 当访问代理.raw 时就返回原始值 ,这其实是为避免 !!!对象设置属性没有去原型链上进行设置的情况!!! 见 P107
      // 为 setter 里面的 判断 toRaw 函数做铺垫
      return target
    }

    // 判断 target 是不是数组：
    const targetIsArray = isArray(target)

    // 如果 target 是数组，并且判断 arrayInstrumentations 这个对象上有没有这个 key，有了 就执行这个, 其实是对数组身上一些特殊情况的处理
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      // 通过 Reflect.get 求值
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 求值: 求出返回值,为后续如果值是对象就递归做响应式处理做铺垫
    const res = Reflect.get(target, key, receiver)

    // 内置 Symbol 不需要做代理:   为了避免 Symbol 造成的意外的错误,以及性能上的考虑,不应该与 Symbol 值建立响应式联系  P123
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 不是只读的就去依赖收集，其实也比较好理解，不是只读的那就意味着可能会变，既然有可能会变，那么就依赖收集
    // 如果是只读的那么就不需要收集依赖,原因是既然是只读的,那么数据必然不会发生变化,那还收集啥依赖
    if (!isReadonly) {
      // track 是整个 get 函数的核心
      track(target, TrackOpTypes.GET, key)
    }

    // 如果是浅响应式那么就不用判断结果是对象还是基本数据类型,不需要对对象做深层响应式处理,直接返回就行了
    if (shallow) {
      return res
    }

    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    // 如果值是对象，那么就需要进行递归做响应式处理，避免深层次的数据拦截不到
    if (isObject(res)) {
    /**
     * 在这里会判断 arr 里面的每一项(也就是结果res)是不是对象,如果是对象类型,那么就需要递归
     * 进行响应式处理,因为 Proxy 只能拦截整个对象,而不能拦截子元素,所以需要递归进行拦截,这点与 defineProperty 一致,但是不同点是
     * defineProperty 在定义响应式数据对象时,就进行了全部的递归遍历拦截,而 Proxy 是在对对象进行访问时才进行递归响应式处理,这点起到了性能优化的作用
     */
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 如果是 readonly ,那么就不做依赖收集了,也比较好理解,都readonly了你还收集个毛线
      // 判断 isReadonly 是为了实现深只读,如果是深只读的那么就把结果包一层,然后返回,如果不是深只读,那么就是深响应的,那么就用 reactive 包一层返回
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
// 浅响应的 set 操作:
const shallowSet = /*#__PURE__*/ createSetter(true)

// 整个 set 函数的核心就是 trigger 派发通知这一步
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    if (!shallow && !isReadonly(value)) {
      if (!isShallow(value)) {
        value = toRaw(value)
        oldValue = toRaw(oldValue)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      // 判断 target 是不是一个数组，以及传进来的这个 key 是不是一个合法的 key，如果都可以那说明
      // 1 是对数组进行判断,然后判断key是不是在数组长度的有效范围内(也即是key小于数组的长度)
      // 2 不是 说明是对对象进行判断,那么就调用 hasOwn 进行判断
      // 总之最后的结果就是判断 key 是不是 数组或者对象 的合法的 key,如果是那么就意味着给数组设置新值或者给对象设置新属性,否则就意味着给数组添加新值或者对象添加新属性
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 先通过 Reflect.set 求值：
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 加一层 target === toRaw(receiver) 是为了防止属性不存在然后去原型中找然后触发两次派发通知(一次是原型上,一次是在对象自身身上的)的浪费性能的行为, 该判断语句是为了 避免在原型中派发通知的行为 P107
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 没有找到 key ,那么就是新增操作: 数组对象都是如此
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 有 key ,然后比较新值和老值是否一致,如果不一致,也就符合 hasChanged,那么就是 set 操作
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

// 对象删除属性的操作:
function deleteProperty(target: object, key: string | symbol): boolean {
  // 先判断target身上有没有这个key
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  // 执行删除属性操作
  const result = Reflect.deleteProperty(target, key)
  // 只有删除属性成功并且对象身上有这个 key,才会执行派发通知 P101
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

// 为拦截 for ... in 而生
function ownKeys(target: object): (string | symbol)[] {
  // 只要数组 length 发生改变,for ... in 就会发生改变,所以需要使用数组的 length 去建立响应联系
  // 如果是对象的 for ... in 发生变化,我们用自定义的 ITERATE_KEY 去建立响应
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

// 对象被 Proxy 劫持后的操作:
// 访问会触发 get 函数, 设置会触发 set 函数, 删除会触发 deleteProperty 函数, in 会触发 deleteProperty 函数, Object.getOwnPropertyNames 会触发 ownKeys 函数
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

// 对象只读的 Proxy 拦截实现:
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  // 只读的不能更改,所以如果更改,在开发环境下报警告, deleteProperty 也是同样的道理,在只读情况下不能删除,否则报警告
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
