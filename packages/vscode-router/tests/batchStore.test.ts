import type { BatchId, BatchRemovalReason, CompanionProblem } from '@cph-ng/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchStore } from '../src/batchStore';

const makeProblem = (batchId: string, size: number, name: string): CompanionProblem => ({
  name,
  group: 'Test Group',
  url: `https://example.com/${name}`,
  interactive: false,
  memoryLimit: 256,
  timeLimit: 1000,
  tests: [
    {
      input: '1',
      output: '1',
    },
  ],
  testType: 'single',
  input: {
    type: 'stdin',
  },
  output: {
    type: 'stdout',
  },
  languages: {
    java: {
      mainClass: 'Main',
      taskClass: 'Task',
    },
  },
  batch: {
    id: batchId as BatchId,
    size,
  },
});

describe('BatchStore', () => {
  const onReadingBatch = vi.fn();
  const onBatchAvailable = vi.fn();
  const onBatchRemoved = vi.fn();

  const makeStore = () =>
    new BatchStore({
      availableBatchTtlMs: 1000,
      finalizedBatchTtlMs: 1000,
      isAutoImportEnabled: () => false,
      onReadingBatch,
      onBatchAvailable,
      onBatchRemoved,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    onReadingBatch.mockReset();
    onBatchAvailable.mockReset();
    onBatchRemoved.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps completed batches available until they are claimed', () => {
    const store = makeStore();
    store.submit(makeProblem('batch-a', 2, 'A'));
    store.submit(makeProblem('batch-a', 2, 'B'));

    expect(onBatchAvailable).toHaveBeenCalledWith(
      {
        batchId: 'batch-a',
        problems: [makeProblem('batch-a', 2, 'A'), makeProblem('batch-a', 2, 'B')],
      },
      false,
    );
    expect(store.getSnapshot()).toEqual([
      {
        batchId: 'batch-a',
        problems: [makeProblem('batch-a', 2, 'A'), makeProblem('batch-a', 2, 'B')],
      },
    ]);

    const claimResult = store.claim('batch-a' as BatchId);
    expect(claimResult).toEqual({
      ok: true,
      batchId: 'batch-a',
      problems: [makeProblem('batch-a', 2, 'A'), makeProblem('batch-a', 2, 'B')],
    });
    expect(onBatchRemoved).toHaveBeenCalledWith('batch-a', 'claimed');
    expect(store.getSnapshot()).toEqual([]);
  });

  it('deduplicates repeated deliveries within a batch', () => {
    const store = makeStore();
    const firstProblem = makeProblem('batch-b', 2, 'A');

    expect(store.submit(firstProblem)).toBe('pending');
    expect(store.submit(firstProblem)).toBe('duplicate');
    expect(store.submit(makeProblem('batch-b', 2, 'B'))).toBe('available');

    expect(onReadingBatch).toHaveBeenCalledTimes(2);
    expect(onBatchAvailable).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('keeps cancelled and claimed batch ids idempotent until the tombstone expires', () => {
    const store = makeStore();
    store.submit(makeProblem('batch-c', 2, 'A'));

    expect(store.cancel('batch-c' as BatchId)).toBe(true);
    expect(store.submit(makeProblem('batch-c', 2, 'A'))).toBe('ignored');

    store.submit(makeProblem('batch-d', 1, 'A'));
    expect(store.claim('batch-d' as BatchId)).toMatchObject({ ok: true, batchId: 'batch-d' });
    expect(store.submit(makeProblem('batch-d', 1, 'A'))).toBe('ignored');

    vi.advanceTimersByTime(1000);

    expect(store.submit(makeProblem('batch-c', 1, 'A'))).toBe('available');
    expect(store.submit(makeProblem('batch-d', 1, 'A'))).toBe('available');
  });

  it('expires unclaimed available batches after the ttl', () => {
    const store = makeStore();
    store.submit(makeProblem('batch-e', 1, 'A'));

    vi.advanceTimersByTime(1000);

    expect(onBatchRemoved).toHaveBeenCalledWith('batch-e', 'expired' satisfies BatchRemovalReason);
    expect(store.getSnapshot()).toEqual([]);
  });
});
