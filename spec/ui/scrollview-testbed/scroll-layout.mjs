'use strict';

// Pure virtual geometry for the scrollview testbed. Production will use the
// same contract; this implementation uses a Fenwick tree so height updates and
// offset lookups stay O(log n) at 17k+ items.

export class ScrollLayoutModel {
  constructor({ totalItems = 0, estimateHeight = () => 96 } = {}) {
    this.totalItems = 0;
    this.estimateHeight = typeof estimateHeight === 'function' ? estimateHeight : () => 96;
    this.slots = [];
    this._heights = [];
    this._tree = [];
    this._rebuild(totalItems);
  }

  _rebuild(totalItems) {
    let count = Math.max(0, Math.trunc(Number(totalItems) || 0));
    this.totalItems = count;
    this.slots = new Array(count);
    this._heights = new Float64Array(count);
    this._tree = new Float64Array(count + 1);
    for (let index = 0; index < count; index++) {
      let height = this._normalizeHeight(this.estimateHeight(index));
      this.slots[index] = { index, key: '', estimatedHeight: height, measuredHeight: null, loaded: false, revision: 0 };
      this._heights[index] = height;
      this._treeAdd(index, height);
    }
  }

  setTotal(totalItems) {
    let next = Math.max(0, Math.trunc(Number(totalItems) || 0));
    if (next === this.totalItems)
      return;
    if (next < this.totalItems) {
      this._rebuild(next);
      return;
    }
    this.slots.length = next;
    let heights = new Float64Array(next);
    heights.set(this._heights);
    let tree = new Float64Array(next + 1);
    tree.set(this._tree);
    this._heights = heights;
    this._tree = tree;
    this.totalItems = next;
    for (let index = this.slots.length; index < next; index++) {
      let height = this._normalizeHeight(this.estimateHeight(index));
      this.slots[index] = { index, key: '', estimatedHeight: height, measuredHeight: null, loaded: false, revision: 0 };
      this._heights[index] = height;
      this._treeAdd(index, height);
    }
  }

  slot(index) {
    return this.slots[index] || null;
  }

  heightOf(index) {
    if (index < 0 || index >= this.totalItems)
      return 0;
    let slot = this.slots[index];
    return slot?.measuredHeight ?? slot?.estimatedHeight ?? 0;
  }

  _normalizeHeight(value) {
    let number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 1;
  }

  setEstimatedHeight(index, height) {
    let slot = this.slots[index];
    if (!slot)
      return 0;
    let next = this._normalizeHeight(height);
    slot.estimatedHeight = next;
    if (slot.measuredHeight != null)
      return 0;
    return this._setHeight(index, next);
  }

  setMeasuredHeight(index, height) {
    let slot = this.slots[index];
    if (!slot)
      return 0;
    let next = this._normalizeHeight(height);
    slot.measuredHeight = next;
    return this._setHeight(index, next);
  }

  replaceRange(start, items) {
    let list = Array.isArray(items) ? items : [];
    let changed = 0;
    for (let offset = 0; offset < list.length; offset++) {
      let index = start + offset;
      if (index < 0 || index >= this.totalItems)
        continue;
      let item = list[offset];
      let slot = this.slots[index];
      let height = this._normalizeHeight(item?.estimatedHeight ?? slot.estimatedHeight);
      slot.key = item?.key || item?.id || slot.key;
      slot.loaded = true;
      slot.revision = Number(item?.revision) || slot.revision;
      slot.estimatedHeight = height;
      if (slot.measuredHeight == null)
        changed += this._setHeight(index, height);
    }
    return changed;
  }

  _setHeight(index, height) {
    let previous = this._heights[index] || 0;
    let delta = height - previous;
    if (Math.abs(delta) < 0.01)
      return 0;
    this._heights[index] = height;
    this._treeAdd(index, delta);
    return delta;
  }

  _treeAdd(index, delta) {
    for (let cursor = index + 1; cursor < this._tree.length; cursor += cursor & -cursor)
      this._tree[cursor] += delta;
  }

  offsetOf(index) {
    let cursor = Math.min(Math.max(0, Math.trunc(index)), this.totalItems);
    let sum = 0;
    for (; cursor > 0; cursor -= cursor & -cursor)
      sum += this._tree[cursor];
    return sum;
  }

  totalHeight() {
    return this.offsetOf(this.totalItems);
  }

  indexAtOffset(offset) {
    if (this.totalItems === 0)
      return 0;
    let target = Math.min(Math.max(0, Number(offset) || 0), Math.max(0, this.totalHeight() - 0.001));
    let low = 0;
    let high = this.totalItems;
    while (low < high) {
      let mid = (low + high) >>> 1;
      if (this.offsetOf(mid + 1) <= target)
        low = mid + 1;
      else
        high = mid;
    }
    return Math.min(low, this.totalItems - 1);
  }

  captureAnchor(scrollTop, viewportHeight = 0) {
    if (this.totalItems === 0)
      return { index: 0, offset: 0, scrollTop: 0 };
    let top = Number(scrollTop) || 0;
    let index = this.indexAtOffset(top);
    return {
      index,
      key: this.slots[index]?.key || '',
      offset: top - this.offsetOf(index),
      scrollTop: top,
    };
  }

  restoreAnchor(anchor) {
    if (!anchor || this.totalItems === 0)
      return 0;
    let index = Number.isInteger(anchor.index) ? Math.min(anchor.index, this.totalItems - 1) : this.indexAtOffset(anchor.scrollTop || 0);
    return Math.max(0, this.offsetOf(index) - (Number(anchor.offset) || 0));
  }

  windowFor(scrollTop, viewportHeight, overscan = 0) {
    if (this.totalItems === 0)
      return { start: 0, end: 0 };
    let top = Math.max(0, Number(scrollTop) || 0);
    let height = Math.max(1, Number(viewportHeight) || 1);
    let overscanPx = Math.max(0, Number(overscan) || 0) * height;
    let start = this.indexAtOffset(Math.max(0, top - overscanPx));
    let end = this.indexAtOffset(top + height + overscanPx) + 1;
    return { start, end: Math.max(start, Math.min(this.totalItems, end)) };
  }
}
