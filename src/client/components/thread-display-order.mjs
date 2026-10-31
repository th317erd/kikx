'use strict';

// A completed AgentMessage is created before its tool calls but updated after
// them. Raw frame pages are ordered by the creation `order`, so the final answer
// can land on an older page while the turn's last tool calls land on a newer
// page. The page source intentionally has stable raw page tokens; this helper
// performs the narrow display correction after pages are mounted: move the
// newest completed response (identified by commitOrder) to the last loaded page
// when it is newer than everything there.
//
// This does not renumber pages or touch frame storage. It only returns the page
// item arrays that need an updatePage() call.

function commitOrder(frame) {
  let value = Number(frame?.commitOrder);
  if (Number.isFinite(value))
    return value;
  value = Number(frame?.order);
  return Number.isFinite(value) ? value : 0;
}

function isCompletedResponse(frame) {
  return frame?.type === 'AgentMessage'
    && (
      frame?.content?.status === 'complete'
      || frame?.state?.lifecycle?.status === 'closed'
    );
}

export function promoteTailResponse(pages = []) {
  if (!Array.isArray(pages) || pages.length < 2)
    return [];

  let lastIndex = pages.length - 1;
  let last = pages[lastIndex];
  if (!last?.loaded)
    return [];

  let lastItems = Array.isArray(last.items) ? last.items.slice() : [];
  let lastIDs = new Set(lastItems.map((item) => item?.frame?.id).filter(Boolean));
  let maxCommit = 0;
  for (let item of lastItems)
    maxCommit = Math.max(maxCommit, commitOrder(item?.frame));

  let updates = [];
  let promoted = [];

  for (let index = 0; index < lastIndex; index++) {
    let page = pages[index];
    if (!page?.loaded || !Array.isArray(page.items))
      continue;

    let kept = [];
    for (let item of page.items) {
      let frame = item?.frame;
      if (!isCompletedResponse(frame) || lastIDs.has(frame.id) || commitOrder(frame) <= maxCommit) {
        kept.push(item);
        continue;
      }

      // Move only one completed response. It is the current turn's final answer;
      // moving every closed response would scramble historical pages.
      if (promoted.length === 0) {
        promoted.push(item);
        lastIDs.add(frame.id);
        maxCommit = Math.max(maxCommit, commitOrder(frame));
        continue;
      }

      kept.push(item);
    }

    if (kept.length !== page.items.length)
      updates.push({ pageIndex: index, items: kept });
  }

  if (promoted.length === 0)
    return [];

  updates.push({ pageIndex: lastIndex, items: [ ...lastItems, ...promoted ] });
  return updates;
}
