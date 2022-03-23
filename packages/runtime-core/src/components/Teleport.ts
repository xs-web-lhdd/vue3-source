import { ComponentInternalInstance } from '../component'
import { SuspenseBoundary } from './Suspense'
import {
  RendererInternals,
  MoveType,
  RendererElement,
  RendererNode,
  RendererOptions,
  traverseStaticChildren
} from '../renderer'
import { VNode, VNodeArrayChildren, VNodeProps } from '../vnode'
import { isString, ShapeFlags } from '@vue/shared'
import { warn } from '../warning'
import { isHmrUpdating } from '../hmr'

export type TeleportVNode = VNode<RendererNode, RendererElement, TeleportProps>

export interface TeleportProps {
  to: string | RendererElement | null | undefined
  disabled?: boolean
}

// 判断是不是 teleport 组件，通过组件身上有没有 __isTeleport 标识：
export const isTeleport = (type: any): boolean => type.__isTeleport

const isTeleportDisabled = (props: VNode['props']): boolean =>
  props && (props.disabled || props.disabled === '')

const isTargetSVG = (target: RendererElement): boolean =>
  typeof SVGElement !== 'undefined' && target instanceof SVGElement

// 该函数作用是查找挂载在那个节点下面:
const resolveTarget = <T = RendererElement>(
  props: TeleportProps | null,
  select: RendererOptions['querySelector']
): T | null => {
  // 获取要挂载的节点: 通过 teleport 组件身上的 props 确定, 如果不在 teleport 上设置就会报警告
  const targetSelector = props && props.to
  if (isString(targetSelector)) {
    if (!select) {
      // 判断有没有传进来查找节点的选择器,没有传进来选择器就报警告
      __DEV__ &&
        warn(
          `Current renderer does not support string target for Teleports. ` +
            `(missing querySelector renderer option)`
        )
      return null
    } else {
      // 传进来查找节点的选择器后,进行查找节点,查找到挂载节点后进行返回,如果没有查找到在控制台报警告
      const target = select(targetSelector)
      if (!target) {
        __DEV__ &&
          warn(
            `Failed to locate Teleport target with selector "${targetSelector}". ` +
              `Note the target element must exist before the component is mounted - ` +
              `i.e. the target cannot be rendered by the component itself, and ` +
              `ideally should be outside of the entire Vue component tree.`
          )
      }
      return target as any
    }
  } else {
    if (__DEV__ && !targetSelector && !isTeleportDisabled(props)) {
      warn(`Invalid Teleport target: ${targetSelector}`)
    }
    return targetSelector as any
  }
}

// teleport 组件的处理逻辑:
export const TeleportImpl = {
  // 打标记，为 teleport 组件：
  __isTeleport: true,
  process(
    n1: TeleportVNode | null,
    n2: TeleportVNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean,
    internals: RendererInternals
  ) {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment }
    } = internals

    const disabled = isTeleportDisabled(n2.props)
    let { shapeFlag, children, dynamicChildren } = n2

    // #3302
    // HMR updated, force full diff
    if (__DEV__ && isHmrUpdating) {
      optimized = false
      dynamicChildren = null
    }

    // 如果 n1 为空，那么就是挂载逻辑，否则就是更新逻辑
    if (n1 == null) {
      // insert anchors in the main view
      const placeholder = (n2.el = __DEV__
        ? createComment('teleport start')
        : createText(''))
      const mainAnchor = (n2.anchor = __DEV__
        ? createComment('teleport end')
        : createText(''))
      insert(placeholder, container, anchor)
      insert(mainAnchor, container, anchor)
      // 通过查找器找到要挂载的目标对象:
      const target = (n2.target = resolveTarget(n2.props, querySelector))
      const targetAnchor = (n2.targetAnchor = createText(''))
      if (target) {
        // 插入操作：
        insert(targetAnchor, target)
        // #2652 we could be teleporting from a non-SVG tree into an SVG tree
        isSVG = isSVG || isTargetSVG(target)
      } else if (__DEV__ && !disabled) {
        warn('Invalid Teleport target on mount:', target, `(${typeof target})`)
      }

      // 挂载逻辑,其实就是挂载孩子组件的逻辑,复用 mountChildren
      const mount = (container: RendererElement, anchor: RendererNode) => {
        // Teleport *always* has Array children. This is enforced in both the
        // compiler and vnode children normalization.
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            children as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        }
      }

      if (disabled) {
        mount(container, mainAnchor)
      } else if (target) {
        mount(target, targetAnchor)
      }
    } else {
      // update content
      n2.el = n1.el
      const mainAnchor = (n2.anchor = n1.anchor)!
      const target = (n2.target = n1.target)!
      const targetAnchor = (n2.targetAnchor = n1.targetAnchor)!
      const wasDisabled = isTeleportDisabled(n1.props)
      const currentContainer = wasDisabled ? container : target
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor
      isSVG = isSVG || isTargetSVG(target)

      if (dynamicChildren) {
        // fast path when the teleport happens to be a block root
        patchBlockChildren(
          n1.dynamicChildren!,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds
        )
        // even in block tree mode we need to make sure all root-level nodes
        // in the teleport inherit previous DOM references so that they can
        // be moved in future patches.
        traverseStaticChildren(n1, n2, true)
      } else if (!optimized) {
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          false
        )
      }

      if (disabled) {
        if (!wasDisabled) {
          // enabled -> disabled
          // move into main container
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      } else {
        // target changed
        // 容器发生变化的情况，to 属性值变化的情况：
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          const nextTarget = (n2.target = resolveTarget(
            n2.props,
            querySelector
          ))
          if (nextTarget) {
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              TeleportMoveTypes.TARGET_CHANGE
            )
          } else if (__DEV__) {
            warn(
              'Invalid Teleport target on update:',
              target,
              `(${typeof target})`
            )
          }
        } else if (wasDisabled) {
          // disabled -> enabled
          // move into teleport target
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      }
    }
  },

  remove(
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean,
    { um: unmount, o: { remove: hostRemove } }: RendererInternals,
    doRemove: Boolean
  ) {
    const { shapeFlag, children, anchor, targetAnchor, target, props } = vnode

    if (target) {
      hostRemove(targetAnchor!)
    }

    // an unmounted teleport should always remove its children if not disabled
    if (doRemove || !isTeleportDisabled(props)) {
      hostRemove(anchor!)
      if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        for (let i = 0; i < (children as VNode[]).length; i++) {
          const child = (children as VNode[])[i]
          unmount(
            child,
            parentComponent,
            parentSuspense,
            true,
            !!child.dynamicChildren
          )
        }
      }
    }
  },

  move: moveTeleport,
  hydrate: hydrateTeleport
}

export const enum TeleportMoveTypes {
  TARGET_CHANGE,
  TOGGLE, // enable / disable
  REORDER // moved in the main view
}

// 移动 teleport 的操作:
function moveTeleport(
  vnode: VNode,
  container: RendererElement,
  parentAnchor: RendererNode | null,
  { o: { insert }, m: move }: RendererInternals,
  moveType: TeleportMoveTypes = TeleportMoveTypes.REORDER
) {
  // move target anchor if this is a target change.
  if (moveType === TeleportMoveTypes.TARGET_CHANGE) {
    insert(vnode.targetAnchor!, container, parentAnchor)
  }
  const { el, anchor, shapeFlag, children, props } = vnode
  const isReorder = moveType === TeleportMoveTypes.REORDER
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(el!, container, parentAnchor)
  }
  // if this is a re-order and teleport is enabled (content is in target)
  // do not move children. So the opposite is: only move children if this
  // is not a reorder, or the teleport is disabled
  if (!isReorder || isTeleportDisabled(props)) {
    // Teleport has either Array children or no children.
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move(
          (children as VNode[])[i],
          container,
          parentAnchor,
          MoveType.REORDER
        )
      }
    }
  }
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(anchor!, container, parentAnchor)
  }
}

interface TeleportTargetElement extends Element {
  // last teleport target
  _lpa?: Node | null
}

function hydrateTeleport(
  node: Node,
  vnode: TeleportVNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  slotScopeIds: string[] | null,
  optimized: boolean,
  {
    o: { nextSibling, parentNode, querySelector }
  }: RendererInternals<Node, Element>,
  hydrateChildren: (
    node: Node | null,
    vnode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  const target = (vnode.target = resolveTarget<Element>(
    vnode.props,
    querySelector
  ))
  if (target) {
    // if multiple teleports rendered to the same target element, we need to
    // pick up from where the last teleport finished instead of the first node
    const targetNode =
      (target as TeleportTargetElement)._lpa || target.firstChild
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (isTeleportDisabled(vnode.props)) {
        vnode.anchor = hydrateChildren(
          nextSibling(node),
          vnode,
          parentNode(node)!,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
        vnode.targetAnchor = targetNode
      } else {
        vnode.anchor = nextSibling(node)
        vnode.targetAnchor = hydrateChildren(
          targetNode,
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
      }
      ;(target as TeleportTargetElement)._lpa =
        vnode.targetAnchor && nextSibling(vnode.targetAnchor as Node)
    }
  }
  return vnode.anchor && nextSibling(vnode.anchor as Node)
}

// Force-casted public typing for h and TSX props inference
export const Teleport = TeleportImpl as any as {
  __isTeleport: true
  new (): { $props: VNodeProps & TeleportProps }
}
