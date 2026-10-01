'use strict';

// Static map from frame type string to its FrameType* class, plus the
// ClassRegistry key form ('FrameType' + type). Kept in its own module so the
// factory and the index do not import each other.

import { FrameTypeDefault } from './frame-type-default.mjs';
import { FrameTypeUserMessage } from './frame-type-user-message.mjs';
import { FrameTypeAgentMessage } from './frame-type-agent-message.mjs';
import { FrameTypeCommandResult } from './frame-type-command-result.mjs';
import { FrameTypeCompactionFrame } from './frame-type-compaction-frame.mjs';
import { FrameTypeToolCall } from './frame-type-tool-call.mjs';
import { FrameTypeToolResult } from './frame-type-tool-result.mjs';
import { FrameTypeAgentProgress } from './frame-type-agent-progress.mjs';

export const FRAME_TYPE_CLASSES = {
  UserMessage: FrameTypeUserMessage,
  AgentMessage: FrameTypeAgentMessage,
  CommandResult: FrameTypeCommandResult,
  CompactionFrame: FrameTypeCompactionFrame,
  ToolCall: FrameTypeToolCall,
  ToolResult: FrameTypeToolResult,
  AgentProgress: FrameTypeAgentProgress,
};

// Registry keys: 'FrameType' + type, plus the default fallback key.
export const FRAME_TYPE_REGISTRATIONS = {
  ...Object.fromEntries(
    Object.entries(FRAME_TYPE_CLASSES).map(([ type, ClassRef ]) => [ `FrameType${type}`, ClassRef ]),
  ),
  FrameTypeDefault,
};
