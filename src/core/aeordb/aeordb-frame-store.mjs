'use strict';

import { AeorDBFrameStorePreviewBase } from './aeordb-frame-store-preview.mjs';

export { serializeCommit, serializeFrame, extractContentText } from './aeordb-frame-store-serialization.mjs';

export class AeorDBFrameStore extends AeorDBFrameStorePreviewBase {}
