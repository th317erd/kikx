'use strict';

import { createPropertyStore } from '../lib/aeor-ui.mjs';

// Pilot of the targeted-update layer. The topbar preview caption is a pair of
// ordinary properties; it must update its two leaves without rebuilding the
// shell or touching the thread. The existing app state fields remain during the
// migration because the session grid also reads them; the store is the narrow
// surface for the topbar until that consumer is migrated too.
export const previewStatusStore = createPropertyStore({
  loading: false,
  status: '',
}, {
  name: 'topbar-preview-status',
  source: 'previews',
});
