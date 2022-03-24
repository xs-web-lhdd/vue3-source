// 子孙组件进行共享数据 --- 依赖注入 provide inject      参考文章: https://www.yht7.com/news/175931
import { isFunction } from '@vue/shared'
import { currentInstance } from './component'
import { currentRenderingInstance } from './componentRenderContext'
import { warn } from './warning'

export interface InjectionKey<T> extends Symbol {}

// provide 逻辑：
export function provide<T>(key: InjectionKey<T> | string | number, value: T) {
  if (!currentInstance) {
    // 没有当前实例在开发环境下报警告：provide 函数只能在 setup 函数内使用
    if (__DEV__) {
      warn(`provide() can only be used inside setup().`)
    }
  } else {
    // 拿到用户设置的 provides ，provides 是一个对象，里面存储的都是 setup 函数中上一次 provide 设置后的键值对
    // 例如: 01-provideInject.html 中 provide 函数函数执行后 provides 是 { name: 'H2O', age: 20 }
    // 这里需要思考 currentInstance 的 provides 是哪里来的?
    // 见 runtime-core/src/component.ts 中 createComponentInstance 这个函数,在创建组件实例时创建的 provides 属性
    // 会先判断有没有父节点,有父节点就把父节点的 provides 拿过来,所以这里的 provides 其实是父节点的 provides, 也就是创建实例初始化时的 provides 默认是父节点的 provides
    let provides = currentInstance.provides
    // by default an instance inherits its parent's provides object
    // but when it needs to provide values of its own, it creates its
    // own provides object using parent provides object as prototype.
    // this way in `inject` we can simply look up injections from direct
    // parent and let the prototype chain do the work.
    const parentProvides =
      currentInstance.parent && currentInstance.parent.provides
    // 如果 parentProvides === provides 说明是在该实例上第一次通过 provide 设置值,也就是该实例中第一个 provide 函数会走这一步:
    if (parentProvides === provides) {
      // 这个时候会创建一个新的对象, 该对象的原型是父节点的 provides ,并且把新创建的这个对象赋值给当前实例的 provides ,这样当该实例的子组件 A 通过 inject 寻找值的时候会先来当前实例上来寻找 provides 
      // 如果当前实例的 provides 中没有,会再通过原型链去当前实例的原型中(也就是 parentProvides 中)去找
      provides = currentInstance.provides = Object.create(parentProvides)
    }
    // TS doesn't allow symbol as index type
    // 往当前实例的 provides 对象中存储这次 provide 函数设置的键值对
    provides[key as string] = value
  }
}

export function inject<T>(key: InjectionKey<T> | string): T | undefined
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T,
  treatDefaultAsFactory?: false
): T
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T | (() => T),
  treatDefaultAsFactory: true
): T
// inject 逻辑：
export function inject(
  key: InjectionKey<any> | string,
  defaultValue?: unknown,
  treatDefaultAsFactory = false
) {
  // fallback to `currentRenderingInstance` so that this can be called in
  // a functional component
  const instance = currentInstance || currentRenderingInstance
  if (instance) {
    // #2400
    // to support `app.use` plugins,
    // fallback to appContext's `provides` if the instance is at root
    // 去当前实例的父组件实例上去找 provides, 如果 instance.parent == null 那说明是根节点, 这时去 instance.vnode.appContext.provides 中找,这与 runtime-core/src/component.ts 中 createComponentInstance 这个函数中 provides 属性一一对应
    const provides =
      instance.parent == null
        ? instance.vnode.appContext && instance.vnode.appContext.provides
        : instance.parent.provides

    // 注意判断的顺序,先去祖先节点的 provides 中找,找不到再去看看有没有设置默认值,如果两者都没命中直接在控制台报警告 
    if (provides && (key as string | symbol) in provides) {
      // TS doesn't allow symbol as index type
      return provides[key as string]
    } else if (arguments.length > 1) {
      // 设置了默认值的情况：先判断设置的默认值是不是函数的情况,是函数就将函数执行一下返回, 不是函数那么直接返回设置的值即可
      return treatDefaultAsFactory && isFunction(defaultValue)
        ? defaultValue.call(instance.proxy)
        : defaultValue
    } else if (__DEV__) {
      // 没有找到 provide 也没有设置默认值，即在生产环境下报警告：
      warn(`injection "${String(key)}" not found.`)
    }
  } else if (__DEV__) {
    warn(`inject() can only be used inside setup() or functional components.`)
  }
}

/*
  引发的思考？
  问：Vue3.js 跨组件共享数组，为何要用 provide/inject ? 直接 export/import 数据行吗 ？

  模块化是可以用来共享数据的，但与 provide/inject 有几点不同
  1、作用域不同：
     对于依赖注入，它的作用域是局部范围，把数据注入以这个节点为根的后代组件中
     对于模块化的方式，它的作用域是全局范围的，在任何地方引用它导出的数据
  2、数据来源不同：
     对于依赖注入，后代组件是不需要知道注入的数据来自哪里，注入并使用
     对于模块化的方式提供的数据，用户必须知道这个数据是在哪个模块定义的，引入它
  3、上下文不同：
     对于依赖注入，根据不同的组件上下文提供不同的数据给后代组件
     对于模块化提供的数据，从 API 层面设计做更改

  问：依赖注入的缺陷和应用场景：
  缺陷：耦合性太强，移动后代组件或者祖先组件可能会引发一些莫名的报错
  应用场景：祖先组件不需要知道哪些后代组件在使用它提供的数据，后代组件也不需要知道注入的数据来自哪里

  不推荐在普通应用程序代码中使用依赖注入，
  推荐在组件库中使用依赖注入，因为组件库中特定组件它和对应的上下文组件嵌套联系是很紧密的

  问：上面提到了组件库使用依赖注入，为什么不使用 this.$parent 和 this.$children 呢？
  因为 this.$paent 和 this.$children 是一种强耦合的获取父组件实例方式，不利于代码的重构，
  因为一旦组件层级发生变化，就会产生非预期的后果，在平时的开发工作中慎用\

  问: inject 是如何找到祖先组件的值的呢?
  通过原型链找到的,inject 会先去父组件的 provides 中去找,如果找不到就会去 父组件的 provides 的原型中去找(也就是爷爷组件的 provides 中找), 直到找到或者找到根组件的 provides 中,
  所以这也解释了为什么父组件的 provides 会覆盖爷爷节点往上节点的 provides 这一现象
*/