import * as React from 'react';
import useLayoutEffect from 'use-isomorphic-layout-effect';
import {useFloatingParentNodeId, useFloatingTree} from '../FloatingTree';
import type {
  ElementProps,
  FloatingContext,
  FloatingTreeType,
  ReferenceType,
} from '../types';
import {getDocument} from '../utils/getDocument';
import {isElement} from '../utils/is';
import {useLatestRef} from '../utils/useLatestRef';
import {usePrevious} from '../utils/usePrevious';

export function getDelay(
  value: Props['delay'],
  prop: 'open' | 'close',
  pointerType?: PointerEvent['pointerType']
) {
  if (pointerType && pointerType !== 'mouse') {
    return 0;
  }

  if (typeof value === 'number') {
    return value;
  }

  return value?.[prop];
}

export interface Props<RT extends ReferenceType = ReferenceType> {
  enabled?: boolean;
  handleClose?:
    | null
    | ((
        context: FloatingContext<RT> & {
          onClose: () => void;
          tree?: FloatingTreeType<RT> | null;
          leave?: boolean;
        }
      ) => (event: PointerEvent) => void);
  restMs?: number;
  delay?: number | Partial<{open: number; close: number}>;
  mouseOnly?: boolean;
}

/**
 * Adds hover event listeners that change the open state, like CSS :hover.
 * @see https://floating-ui.com/docs/useHover
 */
export const useHover = <RT extends ReferenceType = ReferenceType>(
  context: FloatingContext<RT>,
  {
    enabled = true,
    delay = 0,
    handleClose = null,
    mouseOnly = false,
    restMs = 0,
  }: Props<RT> = {}
): ElementProps => {
  const {open, onOpenChange, dataRef, events, refs} = context;

  const tree = useFloatingTree<RT>();
  const parentId = useFloatingParentNodeId();
  const onOpenChangeRef = useLatestRef(onOpenChange);
  const handleCloseRef = useLatestRef(handleClose);
  const previousOpen = usePrevious(open);

  const pointerTypeRef = React.useRef<string>();
  const timeoutRef = React.useRef<any>();
  const handlerRef = React.useRef<(event: PointerEvent) => void>();
  const restTimeoutRef = React.useRef<any>();
  const blockMouseMoveRef = React.useRef(true);
  const performedPointerEventsMutationRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    function onDismiss() {
      clearTimeout(timeoutRef.current);
      clearTimeout(restTimeoutRef.current);
      blockMouseMoveRef.current = true;
    }

    events.on('dismiss', onDismiss);
    return () => {
      events.off('dismiss', onDismiss);
    };
  }, [enabled, events, refs]);

  React.useEffect(() => {
    if (!enabled || !handleCloseRef.current) {
      return;
    }

    function onLeave() {
      if (dataRef.current.openEvent?.type.includes('mouse')) {
        onOpenChangeRef.current(false);
      }
    }

    const html = getDocument(refs.floating.current).documentElement;
    html.addEventListener('mouseleave', onLeave);
    return () => {
      html.removeEventListener('mouseleave', onLeave);
    };
  }, [refs, onOpenChangeRef, enabled, handleCloseRef, dataRef]);

  const closeWithDelay = React.useCallback(
    (runElseBranch = true) => {
      const closeDelay = getDelay(delay, 'close', pointerTypeRef.current);
      if (closeDelay && !handlerRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(
          () => onOpenChangeRef.current(false),
          closeDelay
        );
      } else if (runElseBranch) {
        clearTimeout(timeoutRef.current);
        onOpenChangeRef.current(false);
      }
    },
    [delay, onOpenChangeRef]
  );

  const cleanupPointerMoveHandler = React.useCallback(() => {
    if (handlerRef.current) {
      getDocument(refs.floating.current).removeEventListener(
        'pointermove',
        handlerRef.current
      );
      handlerRef.current = undefined;
    }
  }, [refs]);

  const clearPointerEvents = React.useCallback(() => {
    getDocument(refs.floating.current).body.style.pointerEvents = '';
    performedPointerEventsMutationRef.current = false;
  }, [refs]);

  // Registering the mouse events on the reference directly to bypass React's
  // delegation system. If the cursor was on a disabled element and then entered
  // the reference (no gap), `mouseenter` doesn't fire in the delegation system.
  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    function onMouseEnter(event: MouseEvent) {
      clearTimeout(timeoutRef.current);
      blockMouseMoveRef.current = false;

      if (
        open ||
        (mouseOnly && pointerTypeRef.current !== 'mouse') ||
        (restMs > 0 && getDelay(delay, 'open') === 0)
      ) {
        return;
      }

      dataRef.current.openEvent = event;

      const openDelay = getDelay(delay, 'open', pointerTypeRef.current);

      if (openDelay) {
        timeoutRef.current = setTimeout(() => {
          onOpenChangeRef.current(true);
        }, openDelay);
      } else {
        onOpenChangeRef.current(true);
      }
    }

    function onMouseLeave(event: MouseEvent) {
      if (
        dataRef.current.openEvent?.type === 'click' ||
        dataRef.current.openEvent?.type === 'pointerdown'
      ) {
        return;
      }

      const doc = getDocument(refs.floating.current);
      clearTimeout(restTimeoutRef.current);

      if (handleCloseRef.current) {
        clearTimeout(timeoutRef.current);

        handlerRef.current &&
          doc.removeEventListener('pointermove', handlerRef.current);

        handlerRef.current = handleCloseRef.current({
          ...context,
          tree,
          x: event.clientX,
          y: event.clientY,
          onClose() {
            cleanupPointerMoveHandler();
            closeWithDelay();
          },
        });

        doc.addEventListener('pointermove', handlerRef.current);
        return;
      }

      closeWithDelay();
    }

    // Ensure the floating element closes after scrolling even if the pointer
    // did not move.
    // https://github.com/floating-ui/floating-ui/discussions/1692
    function onScrollMouseLeave(event: MouseEvent) {
      handleCloseRef.current?.({
        ...context,
        tree,
        x: event.clientX,
        y: event.clientY,
        leave: true,
        onClose() {
          cleanupPointerMoveHandler();
          closeWithDelay();
        },
      })(event as PointerEvent);
    }

    const floating = refs.floating.current;
    const reference = refs.domReference.current;

    if (isElement(reference)) {
      open && reference.addEventListener('mouseleave', onScrollMouseLeave);
      floating?.addEventListener('mouseleave', onScrollMouseLeave);
      reference.addEventListener('mousemove', onMouseEnter, {once: true});
      reference.addEventListener('mouseenter', onMouseEnter);
      reference.addEventListener('mouseleave', onMouseLeave);
      return () => {
        open && reference.removeEventListener('mouseleave', onScrollMouseLeave);
        floating?.removeEventListener('mouseleave', onScrollMouseLeave);
        reference.removeEventListener('mousemove', onMouseEnter);
        reference.removeEventListener('mouseenter', onMouseEnter);
        reference.removeEventListener('mouseleave', onMouseLeave);
      };
    }
  }, [
    enabled,
    closeWithDelay,
    context,
    delay,
    handleCloseRef,
    dataRef,
    mouseOnly,
    onOpenChangeRef,
    open,
    tree,
    restMs,
    cleanupPointerMoveHandler,
    refs,
  ]);

  // Block pointer-events of every element other than the reference and floating
  // while the floating element is open and has a `handleClose` handler. Also
  // handles nested floating elements.
  // https://github.com/floating-ui/floating-ui/issues/1722
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    if (open && handleCloseRef.current) {
      getDocument(refs.floating.current).body.style.pointerEvents = 'none';
      performedPointerEventsMutationRef.current = true;
      const reference = refs.domReference.current;
      const floating = refs.floating.current;

      if (isElement(reference) && floating) {
        const parentFloating = tree?.nodesRef.current.find(
          (node) => node.id === parentId
        )?.context?.refs.floating.current;

        if (parentFloating) {
          parentFloating.style.pointerEvents = '';
        }

        reference.style.pointerEvents = 'auto';
        floating.style.pointerEvents = 'auto';

        return () => {
          reference.style.pointerEvents = '';
          floating.style.pointerEvents = '';
        };
      }
    }
  }, [enabled, open, parentId, refs, tree, handleCloseRef, dataRef]);

  useLayoutEffect(() => {
    if (previousOpen && !open) {
      pointerTypeRef.current = undefined;
      cleanupPointerMoveHandler();
      clearPointerEvents();
    }
  });

  React.useEffect(() => {
    return () => {
      cleanupPointerMoveHandler();
      clearTimeout(timeoutRef.current);
      clearTimeout(restTimeoutRef.current);

      if (performedPointerEventsMutationRef.current) {
        clearPointerEvents();
      }
    };
  }, [cleanupPointerMoveHandler, clearPointerEvents]);

  if (!enabled) {
    return {};
  }

  function setPointerRef(event: React.PointerEvent) {
    pointerTypeRef.current = event.pointerType;
  }

  return {
    reference: {
      onPointerDown: setPointerRef,
      onPointerEnter: setPointerRef,
      onMouseMove() {
        if (open || restMs === 0) {
          return;
        }

        clearTimeout(restTimeoutRef.current);
        restTimeoutRef.current = setTimeout(() => {
          if (!blockMouseMoveRef.current) {
            onOpenChange(true);
          }
        }, restMs);
      },
    },
    floating: {
      onMouseEnter() {
        clearTimeout(timeoutRef.current);
      },
      onMouseLeave() {
        closeWithDelay(false);
      },
    },
  };
};
