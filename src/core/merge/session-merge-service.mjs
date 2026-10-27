'use strict';

import { randomUUID } from 'node:crypto';

import { buildCompactionSummaryJSON } from '../compaction/compaction-summary.mjs';
import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';
import { buildMergeSection, createMergeSummaryRunner, summarizeMergeSections } from './session-merge-summary.mjs';
import { defaultSummaryTokensFor, planSessionCompactions, sessionMergeOrder } from './session-merge-plan.mjs';

const MAX_MERGE_FRAMES_PER_SESSION = 5000;
const MERGE_WAKE_AUTHOR_ID = 'internal:session-merge';

export class SessionMergeService {
  constructor(options = {}) {
    this.frameRuntime = options.frameRuntime || null;
    this.compactionService = options.compactionService || null;
    this.store = options.store || null;
    this.logger = options.logger || console;
    this.clock = options.clock || (() => Date.now());
    this.idGenerator = options.idGenerator || (() => `merge-${randomUUID()}`);
    this.createSummaryRunner = options.createSummaryRunner || createMergeSummaryRunner;
    this.summarizeSections = options.summarizeSections || summarizeMergeSections;
    this._locks = new Map();
    this._active = new Map();
  }

  async startMerge(input = {}) {
    let targetSessionID = normalizeOptional(input.targetSessionID || input.target_session_id || input.sessionID);
    if (!targetSessionID)
      throw new TypeError('target_session_id is required');
    let sessionIDs = uniqueStrings([
      targetSessionID,
      ...(Array.isArray(input.sessionIDs || input.session_ids) ? (input.sessionIDs || input.session_ids) : []),
    ]);
    if (sessionIDs.length < 2)
      throw new TypeError('session_ids must contain at least two sessions');

    let now = this.clock();
    let job = {
      id: this.idGenerator(),
      mergeID: null,
      status: 'running',
      targetSessionID,
      sessionIDs,
      sourceSessionIDs: sessionIDs.filter((id) => id !== targetSessionID),
      closeSessions: input.closeSessions === true || input.close_sessions === true,
      requestedByAgentID: normalizeOptional(input.requestedByAgentID),
      requestedByFrameID: normalizeOptional(input.requestedByFrameID),
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      updatedAt: new Date(now).toISOString(),
      updatedAtMs: now,
      compactionFrameID: null,
      compactedSessionIDs: [],
      untouchedSessionIDs: [],
      closedSessionIDs: [],
      error: null,
      wakeError: null,
    };
    job.mergeID = job.id;
    await this._save(job);
    this._active.set(job.id, job);
    void this._runJob(job, input).catch((error) => this._failJob(job, error, input));
    return sanitizeJob(job);
  }

  async getMerge(id) {
    let mergeID = normalizeOptional(id);
    if (!mergeID)
      throw new TypeError('merge_id is required');
    let active = this._active.get(mergeID);
    if (active)
      return sanitizeJob(active);
    let stored = await this.store?.get?.(mergeID);
    return stored ? sanitizeJob(stored) : null;
  }

  async listMerges(options = {}) {
    let jobs = [];
    for (let job of this._active.values())
      jobs.push(sanitizeJob(job));
    if (this.store?.list) {
      for (let job of await this.store.list(options)) {
        if (!jobs.some((candidate) => candidate.mergeID === job.mergeID))
          jobs.push(sanitizeJob(job));
      }
    }
    return jobs
      .sort((left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0))
      .slice(0, Math.max(1, Number(options.limit) || 50));
  }

  async _runJob(job, input = {}) {
    try {
      await this._withTargetLock(job.targetSessionID, async () => {
      let runtime = this.frameRuntime || resolveService(input.services, 'frameRuntime');
      let compactionService = this.compactionService || resolveService(input.services, 'compactionService');
      if (!runtime?.ensureSessionEntry)
        throw new Error('session merge requires frameRuntime');
      if (!compactionService?.contextBuilder)
        throw new Error('session merge requires compactionService');

      runtime.pinSession?.(job.targetSessionID);
      try {
        let contexts = await Promise.all(job.sessionIDs.map((sessionID) => this._loadContext(runtime, compactionService, sessionID)));
        let byID = new Map(contexts.map((context) => [context.session.id, context]));
        let target = byID.get(job.targetSessionID);
        if (!target)
          throw new Error(`Unknown target session: ${job.targetSessionID}`);

        let order = sessionMergeOrder(
          contexts.map((context) => ({ sessionID: context.session.id, tokens: context.contextTokens })),
          job.targetSessionID,
        );
        let ordered = order.map((entry) => byID.get(entry.sessionID)).filter(Boolean);
        let totalContextTokens = contexts.reduce((sum, context) => sum + context.contextTokens, 0);
        let totalFrameCount = contexts.reduce((sum, context) => sum + context.context.frames.length, 0);

        let runner = await this.createSummaryRunner({
          compactionService,
          input: { ...input, session: target.session },
          compactionWindow: {
            frames: new Array(totalFrameCount).fill(null),
            startFrameID: '',
            boundaryFrameID: target.lastFrame?.id || '',
            tokens: totalContextTokens,
          },
        });

        let plan = planSessionCompactions({
          sessions: contexts.map((context) => ({ sessionID: context.session.id, tokens: context.contextTokens })),
          targetSessionID: job.targetSessionID,
          budgetTokens: runner.contextBudget,
        });
        let selected = new Set(plan.selectedSessionIDs);
        let summaries = new Map();
        let summarizeBatch = async (ids) => {
          let batch = ids.filter((id) => !summaries.has(id));
          await Promise.all(batch.map(async (id) => {
            let context = byID.get(id);
            if (!context || context.context.frames.length === 0) {
              summaries.set(id, '');
              return;
            }
            let section = buildMergeSection({ session: context.session, frames: context.context.frames });
            let summary = await this.summarizeSections({
              runner,
              compactionService,
              session: context.session,
              sections: [ section ],
              window: context.window,
              input,
              instructionMode: 'session',
            });
            if (typeof summary !== 'string' || summary.trim() === '')
              throw new Error(`Session compaction returned an empty summary for ${id}`);
            summaries.set(id, summary);
          }));
        };

        await summarizeBatch([ ...selected ]);
        let sections = buildSections(ordered, summaries);
        let sectionTokens = sections.reduce((sum, section) => sum + estimateTextTokens(compactionService, section.text), 0);

        // If the model returned longer summaries than planned, compact the next
        // priority sessions in another parallel batch and re-check.
        while (sectionTokens > runner.contextBudget && selected.size < ordered.length) {
          let projected = sectionTokens;
          let next = [];
          for (let context of ordered) {
            if (selected.has(context.session.id))
              continue;
            if (projected <= runner.contextBudget)
              break;
            next.push(context.session.id);
            selected.add(context.session.id);
            projected -= estimateTextTokens(compactionService, buildMergeSection({
              session: context.session,
              frames: context.context.frames,
            }).text);
            projected += Math.max(1, defaultSummaryTokensFor({ tokens: context.contextTokens }, runner.contextBudget));
          }
          if (next.length === 0)
            break;
          await summarizeBatch(next);
          sections = buildSections(ordered, summaries);
          sectionTokens = sections.reduce((sum, section) => sum + estimateTextTokens(compactionService, section.text), 0);
          job.compactedSessionIDs = [ ...selected ];
          await this._save(job);
        }

        job.compactedSessionIDs = [ ...selected ];
        job.untouchedSessionIDs = ordered.map((context) => context.session.id).filter((id) => !selected.has(id));
        await this._save(job);

        let mergeWindow = buildMergeWindow(ordered, target, totalContextTokens);
        let summary = await this.summarizeSections({
          runner,
          compactionService,
          session: target.session,
          sections,
          window: mergeWindow,
          input,
        });
        if (typeof summary !== 'string' || summary.trim() === '')
          throw new Error('Merge compaction returned an empty summary');

        let mergeMeta = {
          kind: 'session_merge',
          targetSessionID: job.targetSessionID,
          sessionIDs: job.sessionIDs,
          sourceSessionIDs: job.sourceSessionIDs,
          compactedSessionIDs: [ ...selected ],
          untouchedSessionIDs: job.untouchedSessionIDs,
          closeSessions: job.closeSessions === true,
          sourceFrameCount: totalFrameCount,
          contextTokens: totalContextTokens,
          compactorInputBudgetTokens: runner.contextBudget,
          compactorInputTokens: sectionTokens,
          requestedByAgentID: job.requestedByAgentID,
          requestedByFrameID: job.requestedByFrameID,
        };
        let frame = compactionService.createCompactionFrame({
          session: target.session,
          compactorAgent: runner.compactorAgent,
          compactionWindow: mergeWindow,
          summary,
          summaryJSON: buildCompactionSummaryJSON(summary),
          status: 'complete',
          manual: true,
          merge: mergeMeta,
          message: `Merged ${job.sessionIDs.length} sessions.`,
        });
        let merged = target.entry.frameEngine.merge([ frame ], {
          authorType: 'system',
          authorID: 'internal:session-merge',
          silent: true,
        });
        let storedFrame = merged[0] || target.entry.frameEngine.get(frame.id) || frame;
        await runtime.frameStore?.flush?.();
        runtime.syncSessionManifestFromEngine?.(target.entry, { frames: merged, persist: true });

        // The merge frame is durable before any optional source close.
        let closedSessionIDs = [];
        if (job.closeSessions) {
          for (let sessionID of job.sourceSessionIDs) {
            try {
              await runtime.deleteSession(sessionID);
              closedSessionIDs.push(sessionID);
            } catch (error) {
              this.logger.warn?.(`Session merge ${job.id} could not close ${sessionID}: ${error.message}`);
            }
          }
        }

        job.status = 'complete';
        job.compactionFrameID = storedFrame.id;
        job.closedSessionIDs = closedSessionIDs;
        job.updatedAt = new Date(this.clock()).toISOString();
        job.updatedAtMs = this.clock();
        await this._save(job);
        await this.frameRuntime?.emitRuntimeEvent?.('session.merged', {
          mergeID: job.id,
          targetSessionID: job.targetSessionID,
          sessionIDs: job.sessionIDs,
          compactionFrameID: storedFrame.id,
        });
        await this._scheduleWake(runtime, target, job, storedFrame, null, input);
      } finally {
        runtime.unpinSession?.(job.targetSessionID);
      }
      });
    } finally {
      this._active.delete(job.id);
    }
  }

  async _loadContext(runtime, compactionService, sessionID) {
    let entry = await runtime.ensureSessionEntry(sessionID, { frameLimit: MAX_MERGE_FRAMES_PER_SESSION });
    let session = entry.session;
    if (!session?.id)
      throw new Error(`Unknown session: ${sessionID}`);
    if (session.deletedAt)
      throw new Error(`Cannot merge deleted session: ${sessionID}`);
    let allFrames = projectFrameMessages(
      typeof entry.frameEngine.toArray === 'function' ? entry.frameEngine.toArray() : [],
    );
    let context = compactionService.contextBuilder.context(allFrames);
    let tokens = compactionService.contextBuilder.countFrameTokens(context.frames);
    let lastFrame = entry.frameEngine.toArray?.().at(-1) || allFrames.at(-1) || null;
    return {
      entry,
      session,
      allFrames,
      context,
      contextTokens: tokens,
      lastFrame,
      window: {
        frames: context.frames,
        startFrameID: context.frames[0]?.id || '',
        boundaryFrameID: lastFrame?.id || '',
        boundaryOrder: Number(lastFrame?.order || 0),
        tokens,
        sessionID,
      },
    };
  }

  async _failJob(job, error, input = {}) {
    job.status = 'failed';
    job.error = error?.message || String(error);
    job.updatedAt = new Date(this.clock()).toISOString();
    job.updatedAtMs = this.clock();
    await this._save(job);
    this._active.delete(job.id);
    this.logger.error?.(`Session merge ${job.id} failed`, error);
    try {
      let runtime = this.frameRuntime || resolveService(input.services, 'frameRuntime');
      let target = await runtime?.ensureSessionEntry?.(job.targetSessionID, { frameLimit: 1 });
      if (target)
        await this._scheduleWake(runtime, { entry: target, session: target.session }, job, null, job.error, input);
    } catch (wakeError) {
      job.wakeError = wakeError.message || String(wakeError);
      await this._save(job);
    }
  }

  async _scheduleWake(runtime, target, job, frame, error, input = {}) {
    if (!job.requestedByAgentID || !runtime?.ensureSessionEntry)
      return;
    try {
      let entry = target.entry || (target.frameEngine ? target : await runtime.ensureSessionEntry(job.targetSessionID, { frameLimit: 1 }));
      let now = this.clock();
      let wake = {
        id: `merge-wake-${job.id}`,
        type: 'UserMessage',
        sessionID: job.targetSessionID,
        interactionID: `merge:${job.id}`,
        parentID: frame?.id || null,
        authorType: 'system',
        authorID: MERGE_WAKE_AUTHOR_ID,
        targetAgentID: job.requestedByAgentID,
        hidden: true,
        deleted: false,
        timestamp: now,
        createdAt: now,
        updatedAt: now,
        scheduledAt: now,
        scheduledStatus: 'pending',
        continuation: {
          kind: 'session-merge-complete',
          mergeID: job.id,
          status: job.status,
          compactionFrameID: frame?.id || null,
          targetSessionID: job.targetSessionID,
          sessionIDs: job.sessionIDs,
          error: error || null,
        },
        content: {
          text: error
            ? `Session merge ${job.id} failed: ${error}`
            : `Session merge ${job.id} completed. The merged context is stored in compaction frame ${frame?.id || '(unknown)'}. Report the merge outcome to the user.`,
          status: 'scheduled',
          mergeID: job.id,
          compactionFrameID: frame?.id || null,
          targetSessionID: job.targetSessionID,
          sessionIDs: job.sessionIDs,
          error: error || null,
        },
      };
      entry.frameEngine.merge([ wake ], { authorType: 'system', authorID: MERGE_WAKE_AUTHOR_ID, silent: true });
      await runtime.frameStore?.flush?.();
      await runtime.processScheduledFrames?.();
    } catch (wakeError) {
      job.wakeError = wakeError.message || String(wakeError);
      await this._save(job);
    }
  }

  async _save(job) {
    if (this.store?.save)
      await this.store.save(job);
    if (this._active.has(job.id))
      this._active.set(job.id, job);
  }

  async _withTargetLock(targetSessionID, task) {
    let previous = this._locks.get(targetSessionID) || Promise.resolve();
    let next = previous.catch(() => {}).then(task);
    this._locks.set(targetSessionID, next);
    try {
      return await next;
    } finally {
      if (this._locks.get(targetSessionID) === next)
        this._locks.delete(targetSessionID);
    }
  }
}

function buildMergeWindow(orderedContexts, target, totalContextTokens) {
  let byID = new Map();
  for (let context of orderedContexts) {
    for (let frame of context.context.frames) {
      if (frame?.id)
        byID.set(frame.id, frame);
    }
  }
  if (target.lastFrame?.id)
    byID.set(target.lastFrame.id, target.lastFrame);
  let frames = [ ...byID.values() ];
  return {
    frames,
    startFrameID: frames[0]?.id || '',
    boundaryFrameID: target.lastFrame?.id || '',
    boundaryOrder: Number(target.lastFrame?.order || 0),
    tokens: totalContextTokens,
  };
}

function buildSections(orderedContexts, summaries) {
  return orderedContexts
    .map((context) => {
      let summary = summaries.get(context.session.id);
      return buildMergeSection({
        session: context.session,
        frames: context.context.frames,
        summary: summary == null ? null : summary,
      });
    })
    .filter((section) => section.text.trim() !== '');
}

function estimateTextTokens(compactionService, text) {
  return compactionService.contextBuilder.estimateTokens(text);
}

function uniqueStrings(values) {
  let output = [];
  for (let value of values) {
    let normalized = normalizeOptional(value);
    if (normalized && !output.includes(normalized))
      output.push(normalized);
  }
  return output;
}

function normalizeOptional(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sanitizeJob(job = {}) {
  return {
    mergeID: job.id || job.mergeID,
    status: job.status,
    targetSessionID: job.targetSessionID,
    sessionIDs: [ ...(job.sessionIDs || []) ],
    sourceSessionIDs: [ ...(job.sourceSessionIDs || []) ],
    closeSessions: job.closeSessions === true,
    compactionFrameID: job.compactionFrameID || null,
    compactedSessionIDs: [ ...(job.compactedSessionIDs || []) ],
    untouchedSessionIDs: [ ...(job.untouchedSessionIDs || []) ],
    closedSessionIDs: [ ...(job.closedSessionIDs || []) ],
    error: job.error || null,
    wakeError: job.wakeError || null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
  };
}

function resolveService(services = {}, name) {
  let context = services?.context || services;
  if (context?.has?.(name) && typeof context.require === 'function')
    return context.require(name);
  if (typeof context?.require === 'function') {
    try {
      return context.require(name);
    } catch (_error) {}
  }
  return null;
}
