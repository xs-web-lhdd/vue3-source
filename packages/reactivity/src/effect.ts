import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
// 记录当前的 effect 被递归多少层, 也就是用来记录递归嵌套执行 effect 函数的深度
let effectTrackDepth = 0

// 用于标识依赖收集的状态，处理不同嵌套层级的依赖标记
export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
// 表示最大标记的位数
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 当前激活的 effect
export let activeEffect: ReactiveEffect | undefined

// 为对象的 for ... in 设置而生
export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

// 主要做两件事情,把全局的 effect 指向它, 执行原始被包装的 fn 函数
export class ReactiveEffect<T = any> {
  active = true
  // effect 存储相关的 deps 依赖
  deps: Dep[] = []
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  // 接受一个函数和一个调度器
  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    // 非激活函数，直接执行原始的函数返回
    if (!this.active) {
      return this.fn()
    }
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack
    // parent 其实就是书上的 effectStack 操作
    // 这一步跟书中的 判断 effectStack 中有没有 effect 那步一致,书中只有不包含时逻辑才会往下走
    // 这里也是一样道理,只有找 parent 找不到时才会往下走
    while (parent) {
      // 如果 最外层的 effect 就是自己,直接返回即可
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      // 类似于书中的压栈操作 --- 解决嵌套 effect 的思想一致,无非与书中的实现方式不一致罢了,下面来说说源码中的实现:
      // 1 将该实例方法(effect) 身上的 parent 标记为之前的活动对象,也就是说该操作是为了保存该 effect 的外层 effect
      // 因为在没执行 effect 之前,activeEffect 是该 effect 的外层 effect
      this.parent = activeEffect
      // 2 在这里把 activeEffect 更改为内层 effect 也就是它自身
      activeEffect = this
      // 允许依赖收集:
      shouldTrack = true

      // 执行时将 effect 嵌套(递归)深度加一
      // 并且根据递归的深度记录位数
      trackOpBit = 1 << ++effectTrackDepth

      // 这里其实是对依赖收集的优化操作:
      // 检查 effect 函数嵌套(递归)的深度
      if (effectTrackDepth <= maxMarkerBits) {
        // 没超过时就给依赖打标记
        initDepMarkers(this)
      } else {
        // 当超过 maxMarkerBits 时，就去执行 cleanupEffect 函数
        cleanupEffect(this)
      }
      // 在这里会执行 fn, 然后就会访问到响应式数据,会触发它们的 getter,进而执行依赖收集
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        // 完成依赖标记 找到那些曾经被收集过但是新的一轮依赖收集没有被收集的依赖，从 deps 中移除
        finalizeDepMarkers(this)
      }

      // effect 执行完之后将嵌套深度减一
      // 标记恢复到上一级
      trackOpBit = 1 << --effectTrackDepth

      // 类似于书中的出栈操作: 与上面入栈部分一一对应
      // 把 activeEffect 恢复到之前那一层 effect，也就是刚刚执行 effect 函数的外层
      activeEffect = this.parent
      // shouldTrack 恢复之前的状态
      shouldTrack = lastShouldTrack
      // 因为 effect 已经执行完毕了,就把 parent 给换为 undefined 了
      this.parent = undefined
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

// 清除 effect 的函数逻辑： 见 P50 4.4 分支切换与 cleanup
function cleanupEffect(effect: ReactiveEffect) {
  // 从副作用函数身上取出 deps 属性，deps 里面是每个小的 dep，因为 dep 中存储了 effect 函数
  // effect 身上的 deps 存储的就是那些里面有 effect 函数的 dep
  // 也就是说当某些 dep 在收集 effect 时，effect 自身也会记录那些 dep 收集过我，然后当我（effect）
  // 需要清除时，可以通过 deps 找到对应的 dep，进而从那些收集过我（effect）的 dep 中把我给去掉
  // 这里 effect 和 dep 是双向关系与 vue2 中 watcher 和 dep 一致，都是双向关系，即你收集我，我也会收集你这种关系
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建 _effect 实例 
  const _effect = new ReactiveEffect(fn)
  if (options) {
    // 拷贝 options 中的属性到 _effect 中
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    // 立即执行
    _effect.run()
  }
  // 绑定 run 函数,作为 effect runner
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  // 返回的 runner 指向 _effect(ReactiveEffect) 的 run 方法
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

// 是否应该收集依赖:
export let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 依赖收集：
/**
  targetMap : WeakMap 类型   见 19 行
  targetMap: { target: { key: [ activeEffect ] } }
              WeakMap  Map    Set
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // target 表示原始数据；type 表示这次依赖收集的类型；key 表示访问的属性
  if (shouldTrack && activeEffect) {
    // 每个 target 对应一个 depsMap
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 每一个 key 对应一个 dep 集合
    let dep = depsMap.get(key)
    if (!dep) {
      // 创建 dep 时，是通过 createDep 这个方法
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined

    // 创建依赖关系： 
    trackEffects(dep, eventInfo)
  }
}

// 创建依赖关系：
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    // 判断 dep 是不是新的依赖,如果不是就标记为新的依赖
    if (!newTracked(dep)) {
      // 标记为新依赖：
      dep.n |= trackOpBit // set newly tracked
      // 如果依赖已经被收集了就不需要再次收集了
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.  cleanup 模式
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    // 收集当前激活的 effect 作为依赖
    dep.add(activeEffect!)
    // 当前激活的 effect 收集对应的 dep 集合作为依赖
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

// 派发通知:  target 表示目标原始对象；type 表示更新的类型；key 表示要修改的属性
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 去 targetMap 中拿到 target 对应的 Map
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    // 如果 depsMap 不存在,说明 没有被追踪过(依赖收集过)那么直接返回即可
    return
  }

  
  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 对数组的 length 做操作,就在派发通知的时候让 收集的 length 和 key 大于 newValue 的派发通知 P118
    // 例如: arr.length = 5
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      // 根据 key 从 depsMap 中找到对应的 dep（里面是收集的 effect） 添加到 deps 数组中
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 根据传进来的不同的 type 做不同派发通知的操作
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        // 像 Map 类型,那么 SET 类型的操作也应该触发副作用函数执行 P146
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    // 创建运行的 effects 集合
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  // 判断 dep 是不是数组,是数组就直接 for of 遍历,不是数组就包装成数组然后遍历
  // 不是数组就是对应 trigger 上面 deps.length === 1 的情况
  for (const effect of isArray(dep) ? dep : [...dep]) {
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      if (effect.scheduler) {
        // 调度执行
        effect.scheduler()
      } else {
        // 直接执行
        effect.run()
      }
    }
  }
}
