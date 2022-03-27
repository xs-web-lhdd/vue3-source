// v-model 指令   在 input textarea select 自定义组件中使用
// 实际上就是一种打通数据双向通讯的语法糖,即外部可以往组件上传递数据,组件内部经过某些操作行为修改了数据,然后把更新后的数据再回传到外部
import {
  ObjectDirective,
  VNode,
  DirectiveHook,
  DirectiveBinding,
  warn
} from '@vue/runtime-core'
import { addEventListener } from '../modules/events'
import {
  isArray,
  looseEqual,
  looseIndexOf,
  invokeArrayFns,
  toNumber,
  isSet
} from '@vue/shared'

type AssignerFn = (value: any) => void

// 更新数据：dom 到数据的流程
const getModelAssigner = (vnode: VNode): AssignerFn => {
  const fn = vnode.props!['onUpdate:modelValue']
  return isArray(fn) ? value => invokeArrayFns(fn, value) : fn
}

// 当用户在使用中文输入法的时候会触发 onCompositionStart onCompositionEnd 这两个事件 
// 在刚开始在输入法中输入时会触发 onCompositionStart
function onCompositionStart(e: Event) {
  // 设置 e.target.composing 为 true，这样会在 input 的回调函数中判断 e.target.composing 的值，如果为 true 会直接返回，不会执行回调函数
  ;(e.target as any).composing = true
}

// 当用户在输入法中确定值之后，会触发 onCompositionEnd 
function onCompositionEnd(e: Event) {
  const target = e.target as any
  // 如果 e.target.composing 为 true, 会设置为 false, 并且手动触发 input 事件,完成赋值
  if (target.composing) {
    target.composing = false
    trigger(target, 'input')
  }
}

function trigger(el: HTMLElement, type: string) {
  const e = document.createEvent('HTMLEvents')
  e.initEvent(type, true, true)
  el.dispatchEvent(e)
}

type ModelDirective<T> = ObjectDirective<T & { _assign: AssignerFn }>

// We are exporting the v-model runtime directly as vnode hooks so that it can
// be tree-shaken in case v-model is never used.
// v-model 的 text 类型实现:
// 如果配置了 lazy 修饰符，那么监听的是 input 的 change 事件
// 如果不配置 lazy，监听的是 input 的 input 事件
// 另外多监听 compositionstart 和 compositionend 事件
export const vModelText: ModelDirective<
  HTMLInputElement | HTMLTextAreaElement
> = {
  // 思考？为什么里面是 created mounted beforeUpdated 这种钩子函数呢？？？
  // 思考开始：首先 v-modle 是指令，那么会经过指令的处理
  // 在自定义指令中，第一个参数是指令名，第二个是指令对象（可能是函数），因为 v-model 指令是内部指令，所以这里 vModelText 对应的 
  // 这个对象就代表着 v-model 这个指令的指令对象，那么想到这里可能就想通了，自定义指令的指令对象是我们自定义的，无非 v-model 的指令对象是 vue 帮
  // 我们定义好的，所以该对象与自定义指令一样，当节点在编译为渲染函数时，会经过 directives.ts 文件中 withDirectives 函数处理（这点可以在 01-vModel.html 中给  withDirectives 函数打上断点调试验证）
  // 经过 withDirectives 函数处理后，就会把 v-model 对应的值，修饰符，指令对象都添加到该节点的指令数组中，然后当在生命周期执行时就会执行 directives.ts
  // 中 invokeDirectiveHook 函数，然后执行对应指令对象中的声明周期钩子函数，也就是下面的 created mounted beforeUpdated 这些！！！
  // 哇！！！我悟了！！！

  created(el, { modifiers: { lazy, trim, number } }, vnode) {
    el._assign = getModelAssigner(vnode)
    // 根据修饰符和表单类型判断用不用把表单输入值转为数字类型
    const castToNumber =
      number || (vnode.props && vnode.props.type === 'number')
    // 会根据 lazy 修饰符是否配置,来确定是监听 change 还是 input 事件
    addEventListener(el, lazy ? 'change' : 'input', e => {
      // 会在回调函数中判断 e.target.composing 的值，如果为 true 会直接返回，不会执行回调函数, 这主要是针对中文输入法的情况
      if ((e.target as any).composing) return
      let domValue: string | number = el.value
      // 有 trim 修饰符就把 dom 的值给去空格之后再赋值给 dom
      if (trim) {
        domValue = domValue.trim()
      } else if (castToNumber) {
        // 如果判断发现需要转数字类型会把输入的内容转为 number 类型的
        domValue = toNumber(domValue)
      }
      el._assign(domValue)
    })
    // 如果有 trim 修饰符就监听 change 事件并且把输入的结果用 trim 过滤空格一下
    if (trim) {
      addEventListener(el, 'change', () => {
        el.value = el.value.trim()
      })
    }
    if (!lazy) {
      // compositionstart compositionend 是对输入法进行的操作：
      addEventListener(el, 'compositionstart', onCompositionStart)
      addEventListener(el, 'compositionend', onCompositionEnd)
      // Safari < 10.2 & UIWebView doesn't fire compositionend when
      // switching focus before confirming composition choice
      // this also fixes the issue where some browsers e.g. iOS Chrome
      // fires "change" instead of "input" on autocomplete.
      addEventListener(el, 'change', onCompositionEnd)
    }
  },
  // set value on mounted so it's after min/max for type="range"
  mounted(el, { value }) {
    // 挂载是会判断值是否为空,为空就挂载空字符串,不为空直接挂载
    el.value = value == null ? '' : value
  },
  beforeUpdate(el, { value, modifiers: { lazy, trim, number } }, vnode) {
    el._assign = getModelAssigner(vnode)
    // avoid clearing unresolved text. #2302
    if ((el as any).composing) return
    if (document.activeElement === el) {
      if (lazy) {
        return
      }
      if (trim && el.value.trim() === value) {
        return
      }
      if ((number || el.type === 'number') && toNumber(el.value) === value) {
        return
      }
    }
    const newValue = value == null ? '' : value
    // 值不同就进行更新:
    if (el.value !== newValue) {
      el.value = newValue
    }
  }
}

// type 为 checkbox 类型:
export const vModelCheckbox: ModelDirective<HTMLInputElement> = {
  // #4096 array checkboxes need to be deep traversed
  deep: true,
  created(el, _, vnode) {
    el._assign = getModelAssigner(vnode)
    addEventListener(el, 'change', () => {
      const modelValue = (el as any)._modelValue
      const elementValue = getValue(el)
      const checked = el.checked
      const assign = el._assign
      if (isArray(modelValue)) {
        const index = looseIndexOf(modelValue, elementValue)
        const found = index !== -1
        if (checked && !found) {
          assign(modelValue.concat(elementValue))
        } else if (!checked && found) {
          const filtered = [...modelValue]
          filtered.splice(index, 1)
          assign(filtered)
        }
      } else if (isSet(modelValue)) {
        const cloned = new Set(modelValue)
        if (checked) {
          cloned.add(elementValue)
        } else {
          cloned.delete(elementValue)
        }
        assign(cloned)
      } else {
        assign(getCheckboxValue(el, checked))
      }
    })
  },
  // set initial checked on mount to wait for true-value/false-value
  mounted: setChecked,
  beforeUpdate(el, binding, vnode) {
    el._assign = getModelAssigner(vnode)
    setChecked(el, binding, vnode)
  }
}

function setChecked(
  el: HTMLInputElement,
  { value, oldValue }: DirectiveBinding,
  vnode: VNode
) {
  // store the v-model value on the element so it can be accessed by the
  // change listener.
  ;(el as any)._modelValue = value
  if (isArray(value)) {
    el.checked = looseIndexOf(value, vnode.props!.value) > -1
  } else if (isSet(value)) {
    el.checked = value.has(vnode.props!.value)
  } else if (value !== oldValue) {
    el.checked = looseEqual(value, getCheckboxValue(el, true))
  }
}

// type 为 radio 类型:
export const vModelRadio: ModelDirective<HTMLInputElement> = {
  created(el, { value }, vnode) {
    el.checked = looseEqual(value, vnode.props!.value)
    el._assign = getModelAssigner(vnode)
    addEventListener(el, 'change', () => {
      el._assign(getValue(el))
    })
  },
  beforeUpdate(el, { value, oldValue }, vnode) {
    el._assign = getModelAssigner(vnode)
    if (value !== oldValue) {
      el.checked = looseEqual(value, vnode.props!.value)
    }
  }
}

// type 为 select 类型:
export const vModelSelect: ModelDirective<HTMLSelectElement> = {
  // <select multiple> value need to be deep traversed
  deep: true,
  created(el, { value, modifiers: { number } }, vnode) {
    const isSetModel = isSet(value)
    addEventListener(el, 'change', () => {
      const selectedVal = Array.prototype.filter
        .call(el.options, (o: HTMLOptionElement) => o.selected)
        .map((o: HTMLOptionElement) =>
          number ? toNumber(getValue(o)) : getValue(o)
        )
      el._assign(
        el.multiple
          ? isSetModel
            ? new Set(selectedVal)
            : selectedVal
          : selectedVal[0]
      )
    })
    el._assign = getModelAssigner(vnode)
  },
  // set value in mounted & updated because <select> relies on its children
  // <option>s.
  mounted(el, { value }) {
    setSelected(el, value)
  },
  beforeUpdate(el, _binding, vnode) {
    el._assign = getModelAssigner(vnode)
  },
  updated(el, { value }) {
    setSelected(el, value)
  }
}

function setSelected(el: HTMLSelectElement, value: any) {
  const isMultiple = el.multiple
  if (isMultiple && !isArray(value) && !isSet(value)) {
    __DEV__ &&
      warn(
        `<select multiple v-model> expects an Array or Set value for its binding, ` +
          `but got ${Object.prototype.toString.call(value).slice(8, -1)}.`
      )
    return
  }
  for (let i = 0, l = el.options.length; i < l; i++) {
    const option = el.options[i]
    const optionValue = getValue(option)
    if (isMultiple) {
      if (isArray(value)) {
        option.selected = looseIndexOf(value, optionValue) > -1
      } else {
        option.selected = value.has(optionValue)
      }
    } else {
      if (looseEqual(getValue(option), value)) {
        if (el.selectedIndex !== i) el.selectedIndex = i
        return
      }
    }
  }
  if (!isMultiple && el.selectedIndex !== -1) {
    el.selectedIndex = -1
  }
}

// retrieve raw value set via :value bindings
function getValue(el: HTMLOptionElement | HTMLInputElement) {
  return '_value' in el ? (el as any)._value : el.value
}

// retrieve raw value for true-value and false-value set via :true-value or :false-value bindings
function getCheckboxValue(
  el: HTMLInputElement & { _trueValue?: any; _falseValue?: any },
  checked: boolean
) {
  const key = checked ? '_trueValue' : '_falseValue'
  return key in el ? el[key] : checked
}

export const vModelDynamic: ObjectDirective<
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
> = {
  created(el, binding, vnode) {
    callModelHook(el, binding, vnode, null, 'created')
  },
  mounted(el, binding, vnode) {
    callModelHook(el, binding, vnode, null, 'mounted')
  },
  beforeUpdate(el, binding, vnode, prevVNode) {
    callModelHook(el, binding, vnode, prevVNode, 'beforeUpdate')
  },
  updated(el, binding, vnode, prevVNode) {
    callModelHook(el, binding, vnode, prevVNode, 'updated')
  }
}

function callModelHook(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  binding: DirectiveBinding,
  vnode: VNode,
  prevVNode: VNode | null,
  hook: keyof ObjectDirective
) {
  let modelToUse: ObjectDirective
  switch (el.tagName) {
    case 'SELECT':
      modelToUse = vModelSelect
      break
    case 'TEXTAREA':
      modelToUse = vModelText
      break
    default:
      switch (vnode.props && vnode.props.type) {
        case 'checkbox':
          modelToUse = vModelCheckbox
          break
        case 'radio':
          modelToUse = vModelRadio
          break
        default:
          modelToUse = vModelText
      }
  }
  const fn = modelToUse[hook] as DirectiveHook
  fn && fn(el, binding, vnode, prevVNode)
}

// SSR vnode transforms, only used when user includes client-oriented render
// function in SSR
export function initVModelForSSR() {
  vModelText.getSSRProps = ({ value }) => ({ value })

  vModelRadio.getSSRProps = ({ value }, vnode) => {
    if (vnode.props && looseEqual(vnode.props.value, value)) {
      return { checked: true }
    }
  }

  vModelCheckbox.getSSRProps = ({ value }, vnode) => {
    if (isArray(value)) {
      if (vnode.props && looseIndexOf(value, vnode.props.value) > -1) {
        return { checked: true }
      }
    } else if (isSet(value)) {
      if (vnode.props && value.has(vnode.props.value)) {
        return { checked: true }
      }
    } else if (value) {
      return { checked: true }
    }
  }
}
