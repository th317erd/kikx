'use strict';

export class FramePointer {
  constructor(frame, previous = null) {
    this.frame    = frame;
    this.previous = null;
    this.next     = null;
    this.head     = this;
    this.tail     = this;

    if (previous) {
      this.previous  = previous;
      previous.next  = this;

      // Inherit head from the chain
      this.head = previous.head;

      // Update tail for the entire chain
      let pointer = this.head;
      while (pointer) {
        pointer.tail = this;
        pointer      = pointer.next;
      }
    }
  }

  updateHead(newHeadPointer) {
    let pointer = this.tail;
    while (pointer) {
      pointer.head = newHeadPointer;
      pointer      = pointer.previous;
    }
  }
}
