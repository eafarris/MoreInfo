/**
 * Pure widget-system logic, extracted from main.js for testability.
 *
 * All state is passed in via a `ctx` (context) object rather than globals,
 * so tests can create isolated instances without touching the DOM or imports.
 *
 * main.js wraps these functions with its own globals.
 */

/**
 * @typedef {Object} WidgetSystemCtx
 * @property {Object}      sbConfig       – sidebar config keyed by sidebar name
 * @property {Widget[]}    mountedWidgets – mutable array of currently-mounted instances
 * @property {Map}         widgetRegistry – id → widget instance
 * @property {Object}      widgetLayout   – sidebar name → array of widget IDs
 * @property {Object}      widgetSizes    – widget id → saved px size
 * @property {*}           widgetDrag     – drag system (may be null)
 */

/**
 * Mount an ordered list of widgets into a sidebar's .widget-stack element.
 *
 * Widgets already in ctx.mountedWidgets are skipped (dedup guard).
 * isLast is computed from the set that will actually be mounted so the last
 * widget always gets flex:1 regardless of how many are skipped.
 */
export function mountWidgets(ctx, sidebarName, widgets) {
  const { sidebar } = ctx.sbConfig[sidebarName];
  const stack = sidebar.querySelector('.widget-stack');
  if (!stack) return;

  const orientation = (sidebarName === 'top' || sidebarName === 'bottom')
    ? 'horizontal' : 'vertical';
  const horiz = orientation === 'horizontal';

  const toMount = widgets.filter(w => !ctx.mountedWidgets.includes(w));

  for (let i = 0; i < toMount.length; i++) {
    const widget    = toMount[i];
    const wrapper   = document.createElement('div');
    // Guard: ignore a savedSize below 48 px (e.g. header-strip width saved
    // from a rolled-up widget) so it can't lock the wrapper to a tiny sliver.
    const savedSize = (ctx.widgetSizes[widget.id] >= 48) ? ctx.widgetSizes[widget.id] : 0;
    const isLast    = i === toMount.length - 1;

    // wrapperClass (borders, colours) always applied; inline flex overrides
    // any sizing classes it contains.
    widget.wrapperClass.split(/\s+/).filter(Boolean)
      .forEach(cls => wrapper.classList.add(cls));
    // min-size 0 prevents flex items from refusing to shrink below content size.
    wrapper.style[horiz ? 'minWidth' : 'minHeight'] = '0';

    if (savedSize) {
      // Use 1 1 (grow + shrink) for all widgets so that when total saved sizes
      // exceed the container they shrink proportionally, rather than crowding
      // out any widget that has no saved size yet (e.g. a freshly-added widget).
      wrapper.style.flex = `1 1 ${savedSize}px`;
    } else {
      // No saved size: fill available space freely.
      // Give the last widget a non-zero basis so it stays visible even when
      // all other widgets have large saved sizes that together fill the sidebar.
      wrapper.style.flex = isLast ? '1 1 150px' : '1 1 0';
    }

    wrapper.dataset.widgetId = widget.id;
    stack.appendChild(wrapper);

    // Isolate each widget's mount so an exception in one never silently
    // prevents the remaining widgets from mounting.
    try {
      widget.mount(wrapper, orientation, { isLast });
      ctx.mountedWidgets.push(widget);
      ctx.widgetRegistry.set(widget.id, widget);
      if (!ctx.widgetLayout[sidebarName].includes(widget.id)) {
        ctx.widgetLayout[sidebarName].push(widget.id);
      }
    } catch (err) {
      console.error(`[mountWidgets] widget "${widget.id}" mount() threw:`, err);
      stack.removeChild(wrapper); // remove orphaned shell; don't push to mountedWidgets
    }
  }

  if (ctx.widgetDrag) ctx.widgetDrag.wireUp(sidebarName);
}

/**
 * Destroy all widgets in a sidebar's stack and remove them from mountedWidgets.
 */
export function teardownSidebar(ctx, sidebarName) {
  const { sidebar } = ctx.sbConfig[sidebarName];
  const stack = sidebar.querySelector('.widget-stack');
  if (!stack) return;

  for (const wrapper of [...stack.querySelectorAll('[data-widget-id]')]) {
    const w = ctx.widgetRegistry.get(wrapper.dataset.widgetId);
    if (w) {
      w.destroy();
      const idx = ctx.mountedWidgets.indexOf(w);
      if (idx !== -1) ctx.mountedWidgets.splice(idx, 1);
    }
  }
  stack.innerHTML = '';
}

/**
 * Tear down and remount a single sidebar from the current layout.
 */
export function remountSidebar(ctx, sidebarName, saveUiState) {
  teardownSidebar(ctx, sidebarName);
  const ids     = ctx.widgetLayout[sidebarName] || [];
  const widgets = ids.map(id => ctx.widgetRegistry.get(id)).filter(Boolean);
  ctx.widgetLayout[sidebarName] = [];
  mountWidgets(ctx, sidebarName, widgets);
  saveUiState();
}

/**
 * Tear down ALL sidebars then remount all from the current layout.
 *
 * This must be used (instead of sequential remountSidebar calls) whenever
 * widgets may move between sidebars.  Sequential teardown+mount would leave
 * moving widgets still in mountedWidgets when their destination sidebar is
 * processed, causing the dedup guard to silently skip them.
 */
export function rebuildAllSidebars(ctx, saveUiState) {
  const sbs = Object.keys(ctx.widgetLayout);
  for (const sb of sbs) teardownSidebar(ctx, sb);
  for (const sb of sbs) {
    const ids     = ctx.widgetLayout[sb] || [];
    const widgets = ids.map(id => ctx.widgetRegistry.get(id)).filter(Boolean);
    ctx.widgetLayout[sb] = [];
    mountWidgets(ctx, sb, widgets);
  }
  saveUiState();
}
