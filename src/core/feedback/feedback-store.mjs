'use strict';

import { randomBytes } from 'node:crypto';

const DEFAULT_FEEDBACK_ROOT = '/feedback';

export class FeedbackStore {
  constructor(options = {}) {
    let {
      aeordb,
      rootPath = DEFAULT_FEEDBACK_ROOT,
      clock = () => new Date().toISOString(),
      idGenerator = createFeedbackID,
    } = options;

    if (!aeordb)
      throw new TypeError('FeedbackStore requires an aeordb client');

    this.aeordb = aeordb;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async createFeedback(input = {}, context = {}) {
    let now = normalizeTimestamp(input.createdAt || this.clock());
    let id = normalizeFeedbackID(input.id || this.idGenerator());
    let report = normalizeFeedbackInput(input, {
      id,
      createdAt: now,
      context,
    });
    let markdown = buildFeedbackMarkdown(report);
    let path = this.feedbackPath(id);

    // TODO: Replace this AeorDB-local dropbox with AEOR Development's company-level feedback API once that service exists.
    await this.aeordb.putFile(path, markdown, {
      contentType: 'text/markdown; charset=utf-8',
    });

    return {
      id,
      path,
      createdAt: now,
      title: report.title,
      severity: report.severity,
      category: report.category,
      markdown,
      message: `Feedback report ${id} was saved to ${path}.`,
    };
  }

  feedbackPath(id) {
    return `${this.rootPath}/feedback-${encodeURIComponent(normalizeFeedbackID(id))}.md`;
  }
}

function normalizeFeedbackInput(input = {}, defaults = {}) {
  let context = defaults.context || {};
  let title = normalizeRequiredString(input.title || input.summary || input.subject, 'title');
  let severity = normalizeSeverity(input.severity);
  let category = normalizeOptionalString(input.category || input.area || input.kind) || 'bug';
  let markdown = normalizeOptionalString(input.markdown || input.report || input.details || input.description);
  let steps = normalizeStringArray(input.steps || input.reproductionSteps || input.reproSteps);
  let expected = normalizeOptionalString(input.expected || input.expectedBehavior);
  let actual = normalizeOptionalString(input.actual || input.actualBehavior);
  let impact = normalizeOptionalString(input.impact);
  let recommendation = normalizeOptionalString(input.recommendation || input.suggestedFix);

  return {
    id: defaults.id,
    title,
    severity,
    category,
    createdAt: defaults.createdAt,
    agentID: normalizeOptionalString(input.agentID || context.agent?.id || input._agentID),
    agentName: normalizeOptionalString(input.agentName || context.agent?.name),
    sessionID: normalizeOptionalString(input.sessionID || context.session?.id || input._sessionID),
    frameID: normalizeOptionalString(input.frameID || context.frame?.id || input._frameID),
    source: normalizeOptionalString(input.source) || 'kikx-agent',
    markdown,
    steps,
    expected,
    actual,
    impact,
    recommendation,
  };
}

function buildFeedbackMarkdown(report) {
  return [
    '---',
    `id: ${yamlScalar(report.id)}`,
    `title: ${yamlScalar(report.title)}`,
    `severity: ${yamlScalar(report.severity)}`,
    `category: ${yamlScalar(report.category)}`,
    `source: ${yamlScalar(report.source)}`,
    `agentID: ${yamlScalar(report.agentID)}`,
    `agentName: ${yamlScalar(report.agentName)}`,
    `sessionID: ${yamlScalar(report.sessionID)}`,
    `frameID: ${yamlScalar(report.frameID)}`,
    `createdAt: ${yamlScalar(report.createdAt)}`,
    '---',
    '',
    `# ${report.title}`,
    '',
    `- Severity: ${report.severity}`,
    `- Category: ${report.category}`,
    `- Agent: ${report.agentName || report.agentID || 'unknown'}`,
    `- Session: ${report.sessionID || 'unknown'}`,
    `- Frame: ${report.frameID || 'unknown'}`,
    '',
    report.markdown ? '## Report' : '',
    report.markdown || '',
    report.steps.length > 0 ? '## Reproduction Steps' : '',
    ...report.steps.map((step, index) => `${index + 1}. ${step}`),
    report.expected ? '## Expected Behavior' : '',
    report.expected,
    report.actual ? '## Actual Behavior' : '',
    report.actual,
    report.impact ? '## Impact' : '',
    report.impact,
    report.recommendation ? '## Recommendation' : '',
    report.recommendation,
    '',
  ].filter((line) => line != null).join('\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeSeverity(value) {
  let severity = normalizeOptionalString(value).toLowerCase();
  if (!severity)
    return 'medium';

  if ([ 'low', 'medium', 'high', 'critical' ].includes(severity))
    return severity;

  return 'medium';
}

function normalizeStringArray(value) {
  if (Array.isArray(value))
    return value.map((item) => normalizeOptionalString(item)).filter(Boolean);

  let text = normalizeOptionalString(value);
  return text ? [ text ] : [];
}

function normalizeFeedbackID(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('feedback id must be a non-empty string');

  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || createFeedbackID();
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}

function normalizeTimestamp(value) {
  let text = normalizeOptionalString(value);
  return text || new Date().toISOString();
}

function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  return `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
}

function yamlScalar(value) {
  let text = normalizeOptionalString(value);
  if (!text)
    return '""';

  return JSON.stringify(text);
}

function createFeedbackID() {
  return randomBytes(12).toString('hex');
}
