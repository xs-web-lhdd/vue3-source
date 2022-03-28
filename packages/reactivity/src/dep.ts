// 这个文件里面的内容都是为了优化依赖收集而生的     相比于之前每次执行 effect 函数都需要先清空依赖，再添加依赖的过程，现在的实现会在每次执行 effect 包裹的函数前标记依赖的状态，过程中对于已经收集的依赖不会重复收集，执行完 effect 函数还会移除掉已被收集但是新的一轮依赖收集中没有被收集的依赖
// 参考： https://juejin.cn/post/6995732683435278344#heading-3
import { ReactiveEffect, trackOpBit } from './effect'

export type Dep = Set<ReactiveEffect> & TrackedMarkers

/**
 * wasTracked and newTracked maintain the status for several levels of effect
 * tracking recursion. One bit per level is used to define whether the dependency
 * was/is tracked.
 */
type TrackedMarkers = {
  /**
   * wasTracked
   */
  w: number
  /**
   * newTracked
   */
  n: number
}

// 创建一个 dep
export const createDep = (effects?: ReactiveEffect[]): Dep => {
  const dep = new Set<ReactiveEffect>(effects) as Dep
  // w 表示是否已经被收集，n 表示是否新收集，默认都是 0
  dep.w = 0
  dep.n = 0
  return dep
}

// 是不是已经被收集过
export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0

// 是不是新收集的
export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0

// 遍历 _effect 实例中的 deps 属性，给每个 dep 的 w 属性标记为 trackOpBit 的值
export const initDepMarkers = ({ deps }: ReactiveEffect) => {
  // 参数从 effect 中结构出 deps 属性,deps 是一个数组,用来存放那些 dep 里面收集了该 effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].w |= trackOpBit // set was tracked  标记依赖已经被收集
    }
  }
}

// 找到那些曾经被收集过但是新的一轮依赖收集没有被收集的依赖，从 deps 中移除
export const finalizeDepMarkers = (effect: ReactiveEffect) => {
  const { deps } = effect
  if (deps.length) {
    let ptr = 0
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i]
      // 曾经被收集过,但不是新的依赖,需要删除
      if (wasTracked(dep) && !newTracked(dep)) {
        dep.delete(effect)
      } else {
        deps[ptr++] = dep
      }
      // clear bits 清空状态
      dep.w &= ~trackOpBit
      dep.n &= ~trackOpBit
    }
    deps.length = ptr
  }
}
