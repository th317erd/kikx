'use strict';

export class Frame {
  constructor(data = {}) {
    let now = Date.now();

    this.id          = data.id;
    this.type        = data.type;
    this.targets     = (data.targets !== undefined) ? data.targets : [];
    this.phantom     = (data.phantom !== undefined) ? data.phantom : false;
    this.content     = (data.content !== undefined) ? data.content : {};
    this.parentId    = data.parentId ?? data.parentID ?? null;
    this.groupId     = data.groupId ?? data.groupID ?? null;
    this.groupType   = (data.groupType !== undefined) ? data.groupType : null;
    this.order       = (data.order !== undefined) ? data.order : 0;
    this.timestamp   = (data.timestamp !== undefined) ? data.timestamp : now;
    this.hidden      = (data.hidden !== undefined) ? data.hidden : true;
    this.deleted     = (data.deleted !== undefined) ? data.deleted : false;
    this.updatedAt   = (data.updatedAt !== undefined) ? data.updatedAt : now;
    this.createdAt   = (data.createdAt !== undefined) ? data.createdAt : now;
    this.authorType  = (data.authorType !== undefined) ? data.authorType : null;
    this.authorID    = (data.authorID !== undefined) ? data.authorID : null;
    this.processed   = (data.processed !== undefined) ? data.processed : null;
    this.processedAt = (data.processedAt !== undefined) ? data.processedAt : null;
  }
}
