import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../src/_includes/components/site-interactions.webc', import.meta.url), 'utf8')
  .replace(/^<script webc:keep>\s*/, '').replace(/<\/script>\s*$/, '');

function element(properties = {}) {
  const listeners = {};
  return Object.assign({
    hidden: false, checked: false, value: '', textContent: '', dataset: {},
    addEventListener(type, listener) { listeners[type] = listener; },
    fire(type, event = {}) { listeners[type]?.(event); },
    focus() { this.focused = true; },
  }, properties);
}

function disclosure(reduce = false) {
  const summary = element(); const animations = [];
  const details = element({ open: false, style: {},
    querySelector: () => summary,
    getBoundingClientRect: () => ({ height: details.open ? 180 : 40 }),
    animate(frames, options) {
      const animation = { frames, options, cancel() { this.cancelled = true; } };
      animations.push(animation); return animation;
    },
  });
  const media = element({ matches: reduce });
  const document = element({ documentElement: element(), querySelector: () => null,
    querySelectorAll: selector => selector.startsWith('.standings-list') ? [details] : [],
  });
  vm.runInNewContext(script, { document, matchMedia: () => media });
  const click = detail => {
    const event = { detail, target: { closest: () => null }, preventDefault() { this.prevented = true; } };
    summary.fire('click', event); return event;
  };
  return { details, animations, click, media };
}

test('disclosures retain native keyboard and reduced-motion behaviour', () => {
  for (const [reduce, detail] of [[false, 0], [true, 1]]) {
    const ui = disclosure(reduce);
    assert.equal(ui.click(detail).prevented, undefined);
    assert.equal(ui.animations.length, 0);
  }
});

test('interrupted disclosure reverses and cleans up the final closed state', () => {
  const ui = disclosure();
  assert.equal(ui.click(1).prevented, true);
  assert.equal(ui.details.open, true);
  ui.click(1);
  assert.equal(ui.animations[0].cancelled, true);
  ui.animations[1].onfinish();
  assert.equal(ui.details.open, false);
  assert.equal(ui.details.style.overflow, '');
});

test('changing reduced-motion preference settles a running disclosure', () => {
  const ui = disclosure(); ui.click(1);
  ui.media.matches = true; ui.media.fire('change');
  assert.equal(ui.animations[0].cancelled, true);
  assert.equal(ui.details.open, true);
  assert.equal(ui.details.style.height, '');
});
