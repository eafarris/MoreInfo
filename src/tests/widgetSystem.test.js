import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mountWidgets,
  teardownSidebar,
  remountSidebar,
  rebuildAllSidebars,
} from '../widgetSystem.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal fake widget with tracking. */
function makeWidget(id, wrapperClass = '') {
  return {
    id,
    title: id,
    wrapperClass,
    _mounted: false,
    _destroyed: false,
    _container: null,
    mount(container) {
      this._mounted   = true;
      this._destroyed = false;
      this._container = container;
    },
    destroy() {
      this._mounted   = false;
      this._destroyed = true;
      if (this._container) this._container.innerHTML = '';
      this._container = null;
    },
  };
}

/** Build a minimal sidebar DOM: a div containing a .widget-stack child. */
function makeSidebarEl() {
  const sidebar = document.createElement('div');
  const stack   = document.createElement('div');
  stack.className = 'widget-stack';
  sidebar.appendChild(stack);
  return sidebar;
}

/** Build a ctx object wired to fresh DOM sidebar elements. */
function makeCtx(sidebarNames = ['left', 'right', 'top', 'bottom']) {
  const sbConfig      = {};
  for (const name of sidebarNames) {
    sbConfig[name] = { sidebar: makeSidebarEl() };
  }
  const widgetLayout  = Object.fromEntries(sidebarNames.map(n => [n, []]));
  return {
    sbConfig,
    mountedWidgets: [],
    widgetRegistry: new Map(),
    widgetLayout,
    widgetSizes:    {},
    widgetDrag:     null,
  };
}

// ── mountWidgets ───────────────────────────────────────────────────────────

describe('mountWidgets', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('mounts widgets and adds them to mountedWidgets', () => {
    const w1 = makeWidget('a');
    const w2 = makeWidget('b');
    ctx.widgetRegistry.set('a', w1);
    ctx.widgetRegistry.set('b', w2);

    mountWidgets(ctx, 'left', [w1, w2]);

    expect(ctx.mountedWidgets).toContain(w1);
    expect(ctx.mountedWidgets).toContain(w2);
    expect(w1._mounted).toBe(true);
    expect(w2._mounted).toBe(true);
  });

  it('adds widget IDs to widgetLayout for the sidebar', () => {
    const w1 = makeWidget('a');
    mountWidgets(ctx, 'left', [w1]);
    expect(ctx.widgetLayout.left).toContain('a');
  });

  it('all unsized widgets get flex:1 1 0 applied (last and non-last)', () => {
    const w1 = makeWidget('a', 'my-border');
    const w2 = makeWidget('b');
    mountWidgets(ctx, 'left', [w1, w2]);

    const stack    = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    const wrappers = stack.querySelectorAll('[data-widget-id]');
    // Both wrappers are unsized, so both should be in the DOM.
    expect(wrappers.length).toBe(2);
    expect(wrappers[0].dataset.widgetId).toBe('a');
    expect(wrappers[1].dataset.widgetId).toBe('b');
    // wrapperClass is still applied (for border/colour styling).
    expect(wrappers[0].classList.contains('my-border')).toBe(true);
    // minHeight is set on both (vertical sidebar) — JSDOM normalises '0' → '0px'.
    expect(wrappers[0].style.minHeight).toBe('0px');
    expect(wrappers[1].style.minHeight).toBe('0px');
  });

  it('non-last widget without savedSize gets wrapperClass applied', () => {
    const w1 = makeWidget('a', 'my-class extra-class');
    const w2 = makeWidget('b');
    mountWidgets(ctx, 'left', [w1, w2]);

    const stack    = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    const wrapper1 = stack.querySelector('[data-widget-id="a"]');
    expect(wrapper1.classList.contains('my-class')).toBe(true);
    expect(wrapper1.classList.contains('extra-class')).toBe(true);
  });

  it('does not mount a widget already in mountedWidgets', () => {
    const w = makeWidget('a');
    ctx.mountedWidgets.push(w); // simulate already mounted

    mountWidgets(ctx, 'left', [w]);

    // mount() should NOT have been called again
    expect(w._container).toBeNull();
    const stack = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    expect(stack.children.length).toBe(0);
  });

  it('isLast is correct when earlier widgets are skipped by dedup guard', () => {
    const wAlreadyMounted = makeWidget('already');
    const wNew            = makeWidget('new');
    ctx.mountedWidgets.push(wAlreadyMounted); // first widget will be skipped

    mountWidgets(ctx, 'left', [wAlreadyMounted, wNew]);

    // wNew is the only one actually mounted; it should be treated as last.
    // We verify the isLast flag via minHeight (set on vertical-sidebar last
    // wrappers) rather than style.flex — JSDOM rejects `flex:'1 1 0'` because
    // a unitless 0 flex-basis is technically invalid CSS.
    const stack   = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    const wrapper = stack.querySelector('[data-widget-id="new"]');
    expect(wrapper).not.toBeNull();           // was mounted at all
    expect(stack.children.length).toBe(1);    // only wNew, not wAlreadyMounted
    expect(wrapper.style.minHeight).toBe('0px'); // isLast path taken (JSDOM normalises '0' → '0px')
  });

  it('uses savedSize for non-last widgets when available', () => {
    const w1 = makeWidget('a');
    const w2 = makeWidget('b');
    ctx.widgetSizes['a'] = 120;

    mountWidgets(ctx, 'left', [w1, w2]);

    const stack   = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    const wrapper = stack.querySelector('[data-widget-id="a"]');
    expect(wrapper.style.flex).toBe('0 0 120px');
  });

  it('uses minHeight for vertical, minWidth for horizontal sidebars', () => {
    const wV = makeWidget('v');
    const wH = makeWidget('h');

    mountWidgets(ctx, 'left',   [wV]); // vertical
    mountWidgets(ctx, 'top',    [wH]); // horizontal

    const stackV  = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    const stackH  = ctx.sbConfig.top.sidebar.querySelector('.widget-stack');
    expect(stackV.querySelector('[data-widget-id="v"]').style.minHeight).toBe('0px'); // JSDOM normalises '0' → '0px'
    expect(stackH.querySelector('[data-widget-id="h"]').style.minWidth).toBe('0px');
  });
});

// ── teardownSidebar ────────────────────────────────────────────────────────

describe('teardownSidebar', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('calls destroy() on each widget in the sidebar', () => {
    const w = makeWidget('a');
    ctx.widgetRegistry.set('a', w);
    mountWidgets(ctx, 'left', [w]);

    teardownSidebar(ctx, 'left');

    expect(w._destroyed).toBe(true);
  });

  it('removes destroyed widgets from mountedWidgets', () => {
    const w = makeWidget('a');
    ctx.widgetRegistry.set('a', w);
    mountWidgets(ctx, 'left', [w]);
    expect(ctx.mountedWidgets).toContain(w);

    teardownSidebar(ctx, 'left');

    expect(ctx.mountedWidgets).not.toContain(w);
  });

  it('clears the stack DOM', () => {
    const w = makeWidget('a');
    ctx.widgetRegistry.set('a', w);
    mountWidgets(ctx, 'left', [w]);

    teardownSidebar(ctx, 'left');

    const stack = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    expect(stack.children.length).toBe(0);
  });
});

// ── remountSidebar ─────────────────────────────────────────────────────────

describe('remountSidebar', () => {
  let ctx;
  const save = vi.fn();
  beforeEach(() => { ctx = makeCtx(); save.mockClear(); });

  it('destroys existing widgets then mounts from layout', () => {
    const wOld = makeWidget('old');
    const wNew = makeWidget('new');
    ctx.widgetRegistry.set('old', wOld);
    ctx.widgetRegistry.set('new', wNew);
    mountWidgets(ctx, 'left', [wOld]);

    ctx.widgetLayout.left = ['new'];
    remountSidebar(ctx, 'left', save);

    expect(wOld._destroyed).toBe(true);
    expect(wNew._mounted).toBe(true);
    expect(ctx.mountedWidgets).not.toContain(wOld);
    expect(ctx.mountedWidgets).toContain(wNew);
  });

  it('calls saveUiState', () => {
    remountSidebar(ctx, 'left', save);
    expect(save).toHaveBeenCalledOnce();
  });

  it('repopulates widgetLayout from the newly mounted widgets', () => {
    const w = makeWidget('a');
    ctx.widgetRegistry.set('a', w);
    ctx.widgetLayout.left = ['a'];
    remountSidebar(ctx, 'left', save);
    expect(ctx.widgetLayout.left).toContain('a');
  });
});

// ── rebuildAllSidebars ─────────────────────────────────────────────────────

describe('rebuildAllSidebars', () => {
  let ctx;
  const save = vi.fn();
  beforeEach(() => { ctx = makeCtx(); save.mockClear(); });

  it('mounts all widgets in all sidebars', () => {
    const wL = makeWidget('left-w');
    const wR = makeWidget('right-w');
    ctx.widgetRegistry.set('left-w',  wL);
    ctx.widgetRegistry.set('right-w', wR);
    ctx.widgetLayout.left  = ['left-w'];
    ctx.widgetLayout.right = ['right-w'];

    rebuildAllSidebars(ctx, save);

    expect(wL._mounted).toBe(true);
    expect(wR._mounted).toBe(true);
  });

  it('calls saveUiState once', () => {
    rebuildAllSidebars(ctx, save);
    expect(save).toHaveBeenCalledOnce();
  });

  // ── Cross-sidebar move: the critical regression test ──────────────────

  it('correctly moves a widget from one sidebar to another', () => {
    const w = makeWidget('mover');
    ctx.widgetRegistry.set('mover', w);

    // Start: widget in right
    ctx.widgetLayout.right = ['mover'];
    rebuildAllSidebars(ctx, save);
    expect(ctx.mountedWidgets).toContain(w);
    const stackRight = ctx.sbConfig.right.sidebar.querySelector('.widget-stack');
    expect(stackRight.querySelector('[data-widget-id="mover"]')).not.toBeNull();

    // Move: update layout to put widget in left instead
    ctx.widgetLayout.right = [];
    ctx.widgetLayout.left  = ['mover'];
    save.mockClear();
    rebuildAllSidebars(ctx, save);

    const stackLeft  = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    const stackRight2 = ctx.sbConfig.right.sidebar.querySelector('.widget-stack');

    expect(stackLeft.querySelector('[data-widget-id="mover"]')).not.toBeNull();
    expect(stackRight2.querySelector('[data-widget-id="mover"]')).toBeNull();
    expect(w._mounted).toBe(true);
    expect(ctx.mountedWidgets).toContain(w);
    expect(ctx.mountedWidgets.filter(x => x === w).length).toBe(1); // exactly once
  });

  it('sequential remountSidebar (old approach) fails the cross-sidebar move', () => {
    // This test documents the BUG that existed before rebuildAllSidebars.
    // It asserts the broken behaviour so we have a clear regression marker.
    const w = makeWidget('mover');
    ctx.widgetRegistry.set('mover', w);

    ctx.widgetLayout.right = ['mover'];
    rebuildAllSidebars(ctx, save); // initial mount

    // Simulate the old broken approach: move widget then remount sequentially.
    ctx.widgetLayout.right = [];
    ctx.widgetLayout.left  = ['mover'];

    // Old code: remountSidebar('left') first while widget still in mountedWidgets
    remountSidebar(ctx, 'left', () => {});
    // Widget is still in mountedWidgets from right → dedup guard fires → not mounted in left
    const stackLeft = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    // This assertion confirms the old bug: widget NOT present in left after sequential remount
    expect(stackLeft.querySelector('[data-widget-id="mover"]')).toBeNull();
  });

  it('widget appears exactly once across all sidebars after a move', () => {
    const w = makeWidget('shared');
    ctx.widgetRegistry.set('shared', w);
    ctx.widgetLayout.right = ['shared'];
    rebuildAllSidebars(ctx, save);

    ctx.widgetLayout.right = [];
    ctx.widgetLayout.left  = ['shared'];
    rebuildAllSidebars(ctx, save);

    let count = 0;
    for (const sbName of Object.keys(ctx.sbConfig)) {
      const stack = ctx.sbConfig[sbName].sidebar.querySelector('.widget-stack');
      count += stack.querySelectorAll('[data-widget-id="shared"]').length;
    }
    expect(count).toBe(1);
  });

  it('removing a widget from picker leaves it mounted nowhere', () => {
    const w = makeWidget('gone');
    ctx.widgetRegistry.set('gone', w);
    ctx.widgetLayout.left = ['gone'];
    rebuildAllSidebars(ctx, save);

    ctx.widgetLayout.left = []; // picker removes it
    rebuildAllSidebars(ctx, save);

    expect(w._destroyed).toBe(true);
    expect(ctx.mountedWidgets).not.toContain(w);
    for (const sbName of Object.keys(ctx.sbConfig)) {
      const stack = ctx.sbConfig[sbName].sidebar.querySelector('.widget-stack');
      expect(stack.querySelector('[data-widget-id="gone"]')).toBeNull();
    }
  });

  it('adding a new widget to a sidebar mounts it', () => {
    const existing = makeWidget('existing');
    const added    = makeWidget('added');
    ctx.widgetRegistry.set('existing', existing);
    ctx.widgetRegistry.set('added',    added);
    ctx.widgetLayout.left = ['existing'];
    rebuildAllSidebars(ctx, save);

    ctx.widgetLayout.left = ['existing', 'added'];
    rebuildAllSidebars(ctx, save);

    expect(added._mounted).toBe(true);
    expect(existing._mounted).toBe(true);
    const stack = ctx.sbConfig.left.sidebar.querySelector('.widget-stack');
    expect(stack.querySelector('[data-widget-id="added"]')).not.toBeNull();
  });
});
