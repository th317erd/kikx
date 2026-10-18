'use strict';

export function serializeFrame(sessionID, frame) {
  let output = {
    ...frame,
    sessionID: frame.sessionID || sessionID,
    contentText: extractContentText(frame),
    hiddenIndex: String(frame.hidden === true),
    deletedIndex: String(frame.deleted === true),
  };

  return output;
}

export function serializeCommit(commit, frames = []) {
  return {
    ...commit,
    frameIDs: frames.map((frame) => frame.id),
  };
}

export function extractContentText(frame) {
  let content = frame?.content;
  if (content == null)
    return '';

  if (typeof content === 'string')
    return content;

  if (typeof content.text === 'string')
    return content.text;

  if (typeof content.html === 'string')
    return stripHTML(content.html);

  if (typeof content.output === 'string')
    return content.output;

  if (typeof content.result === 'string')
    return content.result;

  try {
    return JSON.stringify(content);
  } catch (_error) {
    return '';
  }
}

function stripHTML(html) {
  return html.replace(/<[^>]*>/g, ' ');
}
