'use strict';

import { FrameStorePreviewBase } from './frame-store-preview.mjs';

export { serializeCommit, serializeFrame, extractContentText } from './frame-store-serialization.mjs';

export class FrameStore extends FrameStorePreviewBase {}
