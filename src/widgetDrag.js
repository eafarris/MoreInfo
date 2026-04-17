/**
 * Widget drag & resize system.
 *
 * Title-bar interactions:
 *   - Drag vertically within the sidebar → resize: redistributes space
 *     between the dragged widget and its neighbour.
 *   - Drag the widget off the sidebar bounds → move: shows a drop indicator
 *     on target sidebars and relocates the widget on drop.
 *
 * The system is initialised once via `initWidgetDrag()`, which returns a
 * helper that should be called after every (re-)mount to wire up new headers.
 */

// Minimum widget size in px along the sidebar's main axis.
const MIN_WIDGET_SIZE = 48;

// Distance (px) the pointer must travel before switching from click to drag.
const DRAG_THRESHOLD = 5;

/**
 * @param {object} opts
 * @param {object}   opts.sbConfig       — sidebar config map (name → {sidebar})
 * @param {function} opts.getLayout      — () → { left:[], right:[], top:[], bottom:[] }
 * @param {function} opts.setLayout      — (layout) => void  (persist)
 * @param {function} opts.getRegistry    — () → Map<id, widgetInstance>
 * @param {function} opts.remountSidebar — (sidebarName) => void
 * @param {function} opts.getWidgetSizes — () → object (id → px)
 * @param {function} opts.setWidgetSizes — (sizes) => void
 * @returns {{ wireUp: (sidebarName: string) => void }}
 */
export function initWidgetDrag({
  sbConfig,
  getLayout,
  setLayout,
  getRegistry,
  remountSidebar,
  getWidgetSizes,
  setWidgetSizes,
}) {

  // ── Resize within sidebar ──────────────────────────────────────────────

  function startResize(e, sidebarName, widgetId) {
    const { sidebar } = sbConfig[sidebarName];
    const stack   = sidebar.querySelector('.widget-stack');
    const horiz   = sidebarName === 'top' || sidebarName === 'bottom';
    const prop    = horiz ? 'width' : 'height';
    const axis    = horiz ? 'clientX' : 'clientY';
    const sizeProp = horiz ? 'offsetWidth' : 'offsetHeight';

    const wrappers = [...stack.querySelectorAll('[data-widget-id]')];
    const idx = wrappers.findIndex(w => w.dataset.widgetId === widgetId);
    if (idx < 0 || idx >= wrappers.length - 1) return null; // nothing below to steal from

    const above = wrappers[idx];
    // Fixed-size widgets (e.g. Calendar) are not resizable — their size is set
    // by their content, not by user drag.
    const aboveWidget = getRegistry().get(above.dataset.widgetId);
    if (aboveWidget?.fixedSize) return null;

    // If the widget is rolled, snap it open instantly so the drag grows it
    // from the header size — same end state as clicking the roll button but
    // without animation, and the drag sets the final size.
    if (aboveWidget?._rolled) aboveWidget.unrollImmediate();

    const below = wrappers[idx + 1];
    const startPos   = e[axis];
    const startAbove = above[sizeProp];
    const startBelow = below[sizeProp];

    // Lock all non-fixed wrappers to their current size so flex doesn't fight us.
    // Suppress transitions for the duration of the drag so size updates are instant.
    // Fixed-size wrappers keep their '0 0 auto' flex untouched.
    wrappers.forEach(w => {
      if (getRegistry().get(w.dataset.widgetId)?.fixedSize) return;
      w.style.flex = `0 0 ${w[sizeProp]}px`;
      w.style.transition = 'none';
    });

    function onMove(ev) {
      const delta   = ev[axis] - startPos;
      const newAbove = Math.max(MIN_WIDGET_SIZE, startAbove + delta);
      const newBelow = Math.max(MIN_WIDGET_SIZE, startBelow - delta);
      // Only apply if both sides stay above minimum.
      if (newAbove >= MIN_WIDGET_SIZE && newBelow >= MIN_WIDGET_SIZE) {
        above.style.flex = `0 0 ${newAbove}px`;
        below.style.flex = `0 0 ${newBelow}px`;
      }
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Persist the sizes, skipping rolled-up widgets and fixed-size widgets.
      const sizes = getWidgetSizes();
      wrappers.forEach(w => {
        const widget = getRegistry().get(w.dataset.widgetId);
        if (widget?._rolled || widget?.fixedSize) return;
        sizes[w.dataset.widgetId] = w[sizeProp];
      });
      setWidgetSizes(sizes);

      // Let one non-fixed widget remain flexible (the last in the stack) so
      // the sidebar can still respond to overall resize.  Others keep their
      // explicit size.  Fixed-size widgets always stay at '0 0 auto'.
      const flexibleWrappers = wrappers.filter(
        w => !getRegistry().get(w.dataset.widgetId)?.fixedSize
      );
      if (flexibleWrappers.length > 0) {
        const lastFlex = flexibleWrappers[flexibleWrappers.length - 1];

        // Guard: if the locked siblings (and any fixed-size widgets) together
        // fill more than stackSize - MIN_WIDGET_SIZE, the last widget would
        // receive 0 px — making it invisible and breaking the roll animation.
        // Scale down the flexible non-last widgets proportionally so the last
        // widget always has at least MIN_WIDGET_SIZE px of space.
        const usedByOthers = wrappers
          .filter(w => w !== lastFlex)
          .reduce((sum, w) => sum + w[sizeProp], 0);
        const stackSize = stack[sizeProp];

        if (usedByOthers > stackSize - MIN_WIDGET_SIZE) {
          const nonLastFlex = flexibleWrappers.slice(0, -1); // scalable widgets
          const nonLastFlexTotal = nonLastFlex.reduce((sum, w) => sum + w[sizeProp], 0);
          // Space for the scalable group: total available minus fixed widgets and
          // the MIN_WIDGET_SIZE reserved for the last flexible widget.
          const fixedTotal     = usedByOthers - nonLastFlexTotal;
          const scalableTarget = Math.max(0, stackSize - MIN_WIDGET_SIZE - fixedTotal);

          if (nonLastFlexTotal > 0) {
            nonLastFlex.forEach(w => {
              const scaled = Math.max(
                MIN_WIDGET_SIZE,
                Math.round(w[sizeProp] * scalableTarget / nonLastFlexTotal)
              );
              w.style.flex = `0 0 ${scaled}px`;
              sizes[w.dataset.widgetId] = scaled;
            });
            setWidgetSizes(sizes); // re-persist the corrected sizes
          }
        }

        lastFlex.style.flex = '1 1 0';
      }

      // Restore transitions now that sizes are finalised.
      const cssProp = horiz ? 'max-width' : 'max-height';
      wrappers.forEach(w => {
        if (getRegistry().get(w.dataset.widgetId)?.fixedSize) return;
        w.style.transition = `${cssProp} 220ms ease, flex-basis 220ms ease`;
      });
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = horiz ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';

    return true; // signal that resize was started
  }

  // ── Drag between sidebars ─────────────────────────────────────────────

  function startDragMove(e, sidebarName, widgetId) {
    const { sidebar } = sbConfig[sidebarName];
    const wrapper = sidebar.querySelector(`[data-widget-id="${widgetId}"]`);
    if (!wrapper) return;

    const header = wrapper.querySelector('.widget-header');

    // Ghost element that follows the cursor.
    const ghost = header.cloneNode(true);
    ghost.style.cssText =
      'position:fixed;z-index:9999;pointer-events:none;opacity:0.85;' +
      `width:${header.offsetWidth}px;border-radius:6px;` +
      'box-shadow:0 4px 16px rgba(0,0,0,0.5);';
    document.body.appendChild(ghost);

    // Dim the original.
    wrapper.style.opacity = '0.3';

    // Transparent overlay to capture all events.
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;cursor:grabbing;';
    document.body.appendChild(overlay);

    // Drop indicator line.
    const indicator = document.createElement('div');
    indicator.style.cssText =
      'position:fixed;z-index:9999;pointer-events:none;border-radius:2px;' +
      'background:#f59e0b;transition:top 60ms ease,left 60ms ease;display:none;';
    document.body.appendChild(indicator);

    let dropTarget = null; // { sidebarName, index }

    function onMove(ev) {
      ghost.style.left = ev.clientX + 8 + 'px';
      ghost.style.top  = ev.clientY + 8 + 'px';

      // Find which widget-stack the pointer is over.
      dropTarget = null;
      indicator.style.display = 'none';

      for (const [name, { sidebar: sb }] of Object.entries(sbConfig)) {
        const stack = sb.querySelector('.widget-stack');
        if (!stack) continue;
        const rect = stack.getBoundingClientRect();
        // Expand the hit area slightly for edge sidebars.
        const pad = 20;
        if (ev.clientX < rect.left - pad || ev.clientX > rect.right + pad ||
            ev.clientY < rect.top - pad || ev.clientY > rect.bottom + pad) continue;

        const horiz   = name === 'top' || name === 'bottom';
        const wrappers = [...stack.querySelectorAll('[data-widget-id]')];
        let insertIdx = wrappers.length;

        for (let i = 0; i < wrappers.length; i++) {
          const wr = wrappers[i].getBoundingClientRect();
          const mid = horiz ? wr.left + wr.width / 2 : wr.top + wr.height / 2;
          const pos = horiz ? ev.clientX : ev.clientY;
          if (pos < mid) { insertIdx = i; break; }
        }

        dropTarget = { sidebarName: name, index: insertIdx };

        // Position the indicator.
        if (horiz) {
          if (insertIdx < wrappers.length) {
            const wr = wrappers[insertIdx].getBoundingClientRect();
            indicator.style.cssText += `display:block;left:${wr.left - 2}px;top:${rect.top}px;width:4px;height:${rect.height}px;`;
          } else if (wrappers.length) {
            const wr = wrappers[wrappers.length - 1].getBoundingClientRect();
            indicator.style.cssText += `display:block;left:${wr.right - 2}px;top:${rect.top}px;width:4px;height:${rect.height}px;`;
          }
        } else {
          if (insertIdx < wrappers.length) {
            const wr = wrappers[insertIdx].getBoundingClientRect();
            indicator.style.cssText += `display:block;top:${wr.top - 2}px;left:${rect.left}px;height:4px;width:${rect.width}px;`;
          } else if (wrappers.length) {
            const wr = wrappers[wrappers.length - 1].getBoundingClientRect();
            indicator.style.cssText += `display:block;top:${wr.bottom - 2}px;left:${rect.left}px;height:4px;width:${rect.width}px;`;
          }
        }
        break; // found a target, stop searching
      }
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ghost.remove();
      overlay.remove();
      indicator.remove();
      wrapper.style.opacity = '';

      if (!dropTarget) return; // cancelled — dropped outside all sidebars

      const layout = getLayout();

      // Remove widget from its current sidebar.
      for (const arr of Object.values(layout)) {
        const i = arr.indexOf(widgetId);
        if (i >= 0) { arr.splice(i, 1); break; }
      }

      // Insert at the target position.
      const targetArr = layout[dropTarget.sidebarName];
      targetArr.splice(dropTarget.index, 0, widgetId);

      setLayout(layout);

      // Remount affected sidebars.
      const affected = new Set([sidebarName, dropTarget.sidebarName]);
      for (const name of affected) remountSidebar(name);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // Position ghost at initial cursor.
    ghost.style.left = e.clientX + 8 + 'px';
    ghost.style.top  = e.clientY + 8 + 'px';
  }

  // ── Wire up title bar interactions ────────────────────────────────────

  function wireUp(sidebarName) {
    const { sidebar } = sbConfig[sidebarName];
    const stack = sidebar.querySelector('.widget-stack');
    if (!stack) return;

    const horiz = sidebarName === 'top' || sidebarName === 'bottom';
    const wrappers = [...stack.querySelectorAll('[data-widget-id]')];

    for (let wi = 0; wi < wrappers.length; wi++) {
      const wrapper = wrappers[wi];

      // ── Bottom-edge resize handle ──────────────────────────────────
      // Add a thin resize strip at the trailing edge of every non-last,
      // non-fixed-size widget.
      const isFixed = getRegistry().get(wrapper.dataset.widgetId)?.fixedSize ?? false;
      if (wi < wrappers.length - 1 && !wrapper._resizeHandleWired && !isFixed) {
        wrapper._resizeHandleWired = true;

        const handle = document.createElement('div');
        if (horiz) {
          handle.style.cssText =
            'position:absolute;top:0;right:0;width:4px;height:100%;cursor:ew-resize;z-index:10;';
          wrapper.style.position = 'relative';
          wrapper.style.borderRight = '1px solid var(--color-olive-700)';
        } else {
          handle.style.cssText =
            'position:absolute;bottom:0;left:0;height:4px;width:100%;cursor:ns-resize;z-index:10;';
          wrapper.style.position = 'relative';
          wrapper.style.borderBottom = '1px solid var(--color-olive-700)';
        }
        wrapper.appendChild(handle);

        handle.addEventListener('mousedown', e => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(e, sidebarName, wrapper.dataset.widgetId);
        });
      }

      const header = wrapper.querySelector('.widget-header');
      if (!header || header._widgetDragWired) continue;
      header._widgetDragWired = true;
      header.style.cursor = 'grab';

      header.addEventListener('mousedown', e => {
        // Don't hijack button clicks (roll, etc.).
        if (e.target.closest('button')) return;
        if (e.button !== 0) return;

        const startX = e.clientX;
        const startY = e.clientY;
        function onFirstMove(ev) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

          document.removeEventListener('mousemove', onFirstMove);
          document.removeEventListener('mouseup', onFirstUp);
          startDragMove(e, sidebarName, wrapper.dataset.widgetId);
        }

        function onFirstUp() {
          document.removeEventListener('mousemove', onFirstMove);
          document.removeEventListener('mouseup', onFirstUp);
          // No threshold crossed — treat as click (handled by widget's own listeners).
        }

        document.addEventListener('mousemove', onFirstMove);
        document.addEventListener('mouseup', onFirstUp);
        e.preventDefault();
      });
    }
  }

  return { wireUp };
}
