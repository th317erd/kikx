'use strict';

// =============================================================================
// Frame Type Classes — index
// =============================================================================
// Concrete classes exist only for current frame types with real behavior. Any
// other type resolves to FrameTypeDefault through the factory.

export { FrameTypeBase, FRAME_PROPERTIES } from './frame-type-base.mjs';
export { FrameTypeDefault } from './frame-type-default.mjs';
export { frameTypeClass, createTypedFrame } from './create-typed-frame.mjs';
export {
  FRAME_TYPE_CLASSES,
  FRAME_TYPE_REGISTRATIONS,
} from './frame-type-classes.mjs';

export { FrameTypeUserMessage } from './frame-type-user-message.mjs';
export { FrameTypeAgentMessage } from './frame-type-agent-message.mjs';
export { FrameTypeCommandResult } from './frame-type-command-result.mjs';
export { FrameTypeCompactionFrame } from './frame-type-compaction-frame.mjs';
export { FrameTypeToolCall } from './frame-type-tool-call.mjs';
export { FrameTypeToolResult } from './frame-type-tool-result.mjs';
export { FrameTypeAgentProgress } from './frame-type-agent-progress.mjs';
