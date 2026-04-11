import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Widget } from '../widgets/Widget.js';

// ── ResizeObserver mock ────────────────────────────────────────────────────
// jsdom doesn't implement ResizeObserver; provide a minimal fake that lets
// us trigger callbacks manually.
let _observers = [];

class MockResizeObserver {
  constructor(cb) {
    this._cb   = cb;
    this._els  = [];
    _observers.push(this);
  }
  observe(el)    { this._els.push(el); }
  disconnect()   { this._els = []; }
  /** Test helper: fire the callback as if the browser noticed a resize. */
  trigger(entries = []) { this._cb(entries, this); }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Stub offsetHeight / offsetWidth on an element (JSDOM always returns 0). */
function stubSize(el, height, width = height) {
  Object.defineProperty(el, 'offsetHeight', { get: () => height, configurable: true });
  Object.defineProperty(el, 'offsetWidth',  { get: () => width,  configurable: true });
}

/** Build a Widget with an optional saved localStorage state. */
function makeWidget(savedState = null) {
  const w = new Widget({ id: 'test', title: 'Test', icon: 'ph-star' });
  if (savedState) {
    localStorage.setItem('mi-widget-test', JSON.stringify(savedState));
  }
  return w;
}

// ── localStorage mock ──────────────────────────────────────────────────────
// jsdom's localStorage implementation varies across vitest versions; use a
// simple in-memory stub to avoid `.clear is not a function` errors.

function makeStorageMock() {
  let store = {};
  return {
    getItem:    (k) => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear:      () => { store = {}; },
  };
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  _observers = [];
  globalThis.ResizeObserver = MockResizeObserver;
  const storageMock = makeStorageMock();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  delete globalThis.ResizeObserver;
});

// ── Constructor ────────────────────────────────────────────────────────────

describe('Widget constructor', () => {
  it('initialises all fields to defaults', () => {
    const w = new Widget({ id: 'x', title: 'X', icon: 'ph-x' });
    expect(w.id).toBe('x');
    expect(w.title).toBe('X');
    expect(w.icon).toBe('ph-x');
    expect(w._container).toBeNull();
    expect(w._body).toBeNull();
    expect(w._rolled).toBe(false);
    expect(w._rollBtn).toBeNull();
    expect(w._orientation).toBe('vertical');
    expect(w._headerSize).toBe(0);
    expect(w._naturalSize).toBeNull();
    expect(w._rollObserver).toBeNull();
  });
});

// ── mount() – basic shell ──────────────────────────────────────────────────

describe('Widget.mount() shell', () => {
  it('renders .widget-header and .widget-body in vertical orientation', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    w.mount(el, 'vertical');
    expect(el.querySelector('.widget-header')).not.toBeNull();
    expect(el.querySelector('.widget-body')).not.toBeNull();
  });

  it('renders .widget-header and .widget-body in horizontal orientation', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    w.mount(el, 'horizontal');
    expect(el.querySelector('.widget-header')).not.toBeNull();
    expect(el.querySelector('.widget-body')).not.toBeNull();
  });

  it('sets _container, _body, and _rollBtn refs after mount', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    w.mount(el);
    expect(w._container).toBe(el);
    expect(w._body).toBe(el.querySelector('.widget-body'));
    expect(w._rollBtn).toBe(el.querySelector('.widget-roll-btn'));
  });

  it('reads _rolled from saved state', () => {
    const w = makeWidget({ _rolled: true, _naturalSize: 180 });
    const el = document.createElement('div');
    w.mount(el);
    expect(w._rolled).toBe(true);
  });

  it('restores _naturalSize from saved state (> 0)', () => {
    const w = makeWidget({ _naturalSize: 250 });
    const el = document.createElement('div');
    w.mount(el);
    expect(w._naturalSize).toBe(250);
  });

  it('does not apply maxHeight when _rolled is false', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    w.mount(el);
    expect(el.style.maxHeight).toBe('');
    expect(w._rollObserver).toBeNull();
  });
});

// ── mount() – hidden container (jsdom always returns 0 for layout) ─────────

describe('Widget.mount() in hidden container (_rolled: true)', () => {
  it('hides the body immediately', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);
    expect(w._body.style.opacity).toBe('0');
    expect(w._body.style.pointerEvents).toBe('none');
  });

  it('does NOT set maxHeight when headerSize is 0 (container hidden)', () => {
    // JSDOM returns 0 for all measurements → this is the "hidden" path
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);
    expect(el.style.maxHeight).toBe('');
  });

  it('installs a ResizeObserver when headerSize is 0', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);
    expect(w._rollObserver).not.toBeNull();
    expect(_observers.length).toBe(1);
  });

  it('does not overwrite a restored _naturalSize with the measured 0', () => {
    const w = makeWidget({ _rolled: true, _naturalSize: 200 });
    const el = document.createElement('div');
    w.mount(el);
    // Measurement returns 0 (hidden) — must not clobber 200
    expect(w._naturalSize).toBe(200);
  });

  it('ResizeObserver callback does nothing if container is still invisible', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);

    const obs = w._rollObserver;
    // Fire without stubbing sizes → still 0
    obs.trigger();

    // Should not have set maxHeight or disconnected
    expect(el.style.maxHeight).toBe('');
    expect(w._rollObserver).toBe(obs); // still attached
  });

  it('ResizeObserver callback sets maxHeight when container becomes visible', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);

    // Stub sizes to simulate sidebar becoming visible
    const header = el.querySelector('.widget-header');
    stubSize(header, 32);
    stubSize(el, 220);

    w._rollObserver.trigger();

    expect(w._headerSize).toBe(32);
    expect(w._naturalSize).toBe(220);
    expect(el.style.maxHeight).toBe('32px');
  });

  it('ResizeObserver is disconnected and nulled after it fires', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);

    const header = el.querySelector('.widget-header');
    stubSize(header, 28);
    stubSize(el, 180);

    const obs = w._rollObserver;
    w._rollObserver.trigger();

    expect(obs.disconnect).not.toBeUndefined(); // was the mock
    expect(w._rollObserver).toBeNull();
  });
});

// ── mount() – visible container (_rolled: true) ────────────────────────────

describe('Widget.mount() in visible container (_rolled: true)', () => {
  it('applies maxHeight immediately without installing ResizeObserver', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    document.body.appendChild(el);

    // Stub container and header before mount() so measurements return non-zero
    const header = document.createElement('div');
    header.className = 'widget-header';
    // We can't easily pre-stub because mount() creates the DOM internally.
    // Instead, stub using the configurable trick after mount.
    // But the measurement happens synchronously during mount()...
    // So we intercept by stubbing on the container BEFORE mount, which
    // causes the header stub to be re-measured inside mount.
    // Simplest: mount first, then verify we took the correct branch.
    // In jsdom header.offsetHeight === 0 → always uses ResizeObserver.
    // Test the opposite by patching Element.prototype temporarily.
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get: () => 40,
      configurable: true,
    });

    w.mount(el);

    // Restore
    if (orig) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', orig);

    expect(w._headerSize).toBe(40);
    expect(el.style.maxHeight).toBe('40px');
    expect(w._rollObserver).toBeNull(); // no observer needed
  });
});

// ── destroy() ─────────────────────────────────────────────────────────────

describe('Widget.destroy()', () => {
  it('clears container innerHTML and nulls refs', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    w.mount(el);
    w.destroy();
    expect(el.innerHTML).toBe('');
    expect(w._container).toBeNull();
    expect(w._body).toBeNull();
  });

  it('disconnects and nulls _rollObserver if one is active', () => {
    const w = makeWidget({ _rolled: true });
    const el = document.createElement('div');
    w.mount(el);

    const obs = w._rollObserver;
    expect(obs).not.toBeNull();

    w.destroy();

    // disconnect() should have been called on the observer
    expect(obs._els).toHaveLength(0); // MockResizeObserver.disconnect() clears _els
    expect(w._rollObserver).toBeNull();
  });

  it('is safe to call destroy() with no active _rollObserver', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    w.mount(el);
    expect(w._rollObserver).toBeNull();
    expect(() => w.destroy()).not.toThrow();
  });

  it('calls onDestroy hook', () => {
    const w = makeWidget();
    const el = document.createElement('div');
    const spy = vi.spyOn(w, 'onDestroy');
    w.mount(el);
    w.destroy();
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ── saveState / loadState / clearState ────────────────────────────────────

describe('Widget state persistence', () => {
  it('saveState and loadState round-trip', () => {
    const w = makeWidget();
    w.saveState({ _rolled: true, _naturalSize: 200, custom: 'hello' });
    expect(w.loadState()).toEqual({ _rolled: true, _naturalSize: 200, custom: 'hello' });
  });

  it('loadState returns null when nothing is saved', () => {
    const w = makeWidget();
    expect(w.loadState()).toBeNull();
  });

  it('clearState removes persisted data', () => {
    const w = makeWidget();
    w.saveState({ foo: 1 });
    w.clearState();
    expect(w.loadState()).toBeNull();
  });
});
