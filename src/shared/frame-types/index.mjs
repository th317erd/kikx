'use strict';

// =============================================================================
// Frame Type Classes — Index
// =============================================================================

export { FrameTypeBase, FRAME_PROPERTIES }  from './frame-type-base.mjs';
export { FrameTypeDefault }                 from './frame-type-default.mjs';
export { createTypedFrame }                 from './create-typed-frame.mjs';

export { FrameTypeUserMessage }       from './frame-type-user-message.mjs';
export { FrameTypeMessage }           from './frame-type-message.mjs';
export { FrameTypeToolCall }          from './frame-type-tool-call.mjs';
export { FrameTypeToolResult }        from './frame-type-tool-result.mjs';
export { FrameTypeToolError }         from './frame-type-tool-error.mjs';
export { FrameTypeToolActivity }      from './frame-type-tool-activity.mjs';
export { FrameTypePermissionRequest } from './frame-type-permission-request.mjs';
export { FrameTypePermissionDenied }  from './frame-type-permission-denied.mjs';
export { FrameTypeCommandResult }     from './frame-type-command-result.mjs';
export { FrameTypeSessionLink }       from './frame-type-session-link.mjs';
export { FrameTypeHookBlocked }       from './frame-type-hook-blocked.mjs';
export { FrameTypePendingAction }     from './frame-type-pending-action.mjs';
export { FrameTypeSystemError }       from './frame-type-system-error.mjs';
export { FrameTypeParticipantJoined } from './frame-type-participant-joined.mjs';
export { FrameTypeParticipantLeft }   from './frame-type-participant-left.mjs';
export { FrameTypeError }             from './frame-type-error.mjs';
export { FrameTypeReflection }        from './frame-type-reflection.mjs';
export { FrameTypeCompaction }        from './frame-type-compaction.mjs';
export { FrameTypeStop }              from './frame-type-stop.mjs';

// ---------------------------------------------------------------------------
// FRAME_TYPE_CLASSES — map from type string to class
// ---------------------------------------------------------------------------

import { FrameTypeUserMessage }       from './frame-type-user-message.mjs';
import { FrameTypeMessage }           from './frame-type-message.mjs';
import { FrameTypeToolCall }          from './frame-type-tool-call.mjs';
import { FrameTypeToolResult }        from './frame-type-tool-result.mjs';
import { FrameTypeToolError }         from './frame-type-tool-error.mjs';
import { FrameTypeToolActivity }      from './frame-type-tool-activity.mjs';
import { FrameTypePermissionRequest } from './frame-type-permission-request.mjs';
import { FrameTypePermissionDenied }  from './frame-type-permission-denied.mjs';
import { FrameTypeCommandResult }     from './frame-type-command-result.mjs';
import { FrameTypeSessionLink }       from './frame-type-session-link.mjs';
import { FrameTypeHookBlocked }       from './frame-type-hook-blocked.mjs';
import { FrameTypePendingAction }     from './frame-type-pending-action.mjs';
import { FrameTypeSystemError }       from './frame-type-system-error.mjs';
import { FrameTypeParticipantJoined } from './frame-type-participant-joined.mjs';
import { FrameTypeParticipantLeft }   from './frame-type-participant-left.mjs';
import { FrameTypeError }             from './frame-type-error.mjs';
import { FrameTypeReflection }        from './frame-type-reflection.mjs';
import { FrameTypeCompaction }        from './frame-type-compaction.mjs';
import { FrameTypeStop }              from './frame-type-stop.mjs';

export const FRAME_TYPE_CLASSES = {
  UserMessage:       FrameTypeUserMessage,
  Message:           FrameTypeMessage,
  ToolCall:          FrameTypeToolCall,
  ToolResult:        FrameTypeToolResult,
  ToolError:         FrameTypeToolError,
  ToolActivity:      FrameTypeToolActivity,
  PermissionRequest: FrameTypePermissionRequest,
  PermissionDenied:  FrameTypePermissionDenied,
  CommandResult:     FrameTypeCommandResult,
  SessionLink:       FrameTypeSessionLink,
  HookBlocked:       FrameTypeHookBlocked,
  PendingAction:     FrameTypePendingAction,
  SystemError:       FrameTypeSystemError,
  ParticipantJoined: FrameTypeParticipantJoined,
  ParticipantLeft:   FrameTypeParticipantLeft,
  Error:             FrameTypeError,
  Reflection:        FrameTypeReflection,
  Compaction:        FrameTypeCompaction,
  Stop:              FrameTypeStop,
};
