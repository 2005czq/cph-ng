// Copyright (C) 2026 Langning Chen
//
// This file is part of cph-ng.
//
// cph-ng is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// cph-ng is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with cph-ng.  If not, see <https://www.gnu.org/licenses/>.

import { createHash } from 'node:crypto';
import type {
  AvailableBatch,
  BatchId,
  BatchRemovalReason,
  ClaimBatchResult,
  CompanionProblem,
} from '@cph-ng/core';

type PendingBatch = {
  fingerprints: Set<string>;
  problems: CompanionProblem[];
  size: number;
};

type StoredAvailableBatch = {
  expiryTimer: ReturnType<typeof setTimeout>;
  fingerprints: Set<string>;
  problems: CompanionProblem[];
};

type BatchStoreOptions = {
  availableBatchTtlMs: number;
  finalizedBatchTtlMs?: number;
  isAutoImportEnabled: () => boolean;
  onBatchAvailable: (batch: AvailableBatch, autoImport: boolean) => void;
  onBatchRemoved: (batchId: BatchId, reason: BatchRemovalReason) => void;
  onReadingBatch: (batchId: BatchId, count: number, size: number) => void;
};

export class BatchStore {
  private readonly pendingBatches = new Map<BatchId, PendingBatch>();
  private readonly availableBatches = new Map<BatchId, StoredAvailableBatch>();
  private readonly finalizedBatchTimers = new Map<BatchId, ReturnType<typeof setTimeout>>();

  public constructor(private readonly options: BatchStoreOptions) {}

  public submit(problem: CompanionProblem): 'available' | 'duplicate' | 'ignored' | 'pending' {
    const { id, size } = problem.batch;
    if (this.finalizedBatchTimers.has(id)) return 'ignored';

    const fingerprint = this.createProblemFingerprint(problem);
    const availableBatch = this.availableBatches.get(id);
    if (availableBatch)
      return availableBatch.fingerprints.has(fingerprint) ? 'duplicate' : 'ignored';

    const pendingBatch = this.pendingBatches.get(id) || {
      size,
      problems: [],
      fingerprints: new Set<string>(),
    };
    pendingBatch.size = Math.max(pendingBatch.size, size);
    if (pendingBatch.fingerprints.has(fingerprint)) return 'duplicate';

    pendingBatch.fingerprints.add(fingerprint);
    pendingBatch.problems.push(problem);
    this.pendingBatches.set(id, pendingBatch);

    if (pendingBatch.size !== 1)
      this.options.onReadingBatch(id, pendingBatch.problems.length, pendingBatch.size);

    if (pendingBatch.problems.length < pendingBatch.size) return 'pending';

    this.pendingBatches.delete(id);
    const problems = [...pendingBatch.problems];
    const expiryTimer = setTimeout(() => {
      this.expireAvailableBatch(id);
    }, this.options.availableBatchTtlMs);

    this.availableBatches.set(id, {
      expiryTimer,
      fingerprints: new Set(pendingBatch.fingerprints),
      problems,
    });
    this.options.onBatchAvailable({ batchId: id, problems }, this.options.isAutoImportEnabled());
    return 'available';
  }

  public cancel(batchId: BatchId): boolean {
    const pendingBatch = this.pendingBatches.get(batchId);
    if (pendingBatch) {
      this.pendingBatches.delete(batchId);
      this.markFinalized(batchId);
      this.options.onReadingBatch(batchId, pendingBatch.size + 1, pendingBatch.size);
      return true;
    }

    const availableBatch = this.removeAvailableBatch(batchId);
    if (!availableBatch) return false;

    this.markFinalized(batchId);
    this.options.onBatchRemoved(batchId, 'cancelled');
    return true;
  }

  public claim(batchId: BatchId): ClaimBatchResult {
    const availableBatch = this.removeAvailableBatch(batchId);
    if (!availableBatch)
      return {
        ok: false,
        batchId,
        reason: 'not-available',
      };

    this.markFinalized(batchId);
    this.options.onBatchRemoved(batchId, 'claimed');
    return {
      ok: true,
      batchId,
      problems: [...availableBatch.problems],
    };
  }

  public getSnapshot(): AvailableBatch[] {
    return [...this.availableBatches.entries()].map(([batchId, batch]) => ({
      batchId,
      problems: [...batch.problems],
    }));
  }

  public getPendingDebugSnapshot(): Array<{ batchId: BatchId; count: number; size: number }> {
    return [...this.pendingBatches.entries()].map(([batchId, batch]) => ({
      batchId,
      count: batch.problems.length,
      size: batch.size,
    }));
  }

  public dispose() {
    for (const batch of this.availableBatches.values()) clearTimeout(batch.expiryTimer);
    this.availableBatches.clear();
    for (const timer of this.finalizedBatchTimers.values()) clearTimeout(timer);
    this.finalizedBatchTimers.clear();
    this.pendingBatches.clear();
  }

  private expireAvailableBatch(batchId: BatchId) {
    const availableBatch = this.removeAvailableBatch(batchId);
    if (!availableBatch) return;
    this.markFinalized(batchId);
    this.options.onBatchRemoved(batchId, 'expired');
  }

  private removeAvailableBatch(batchId: BatchId): StoredAvailableBatch | undefined {
    const availableBatch = this.availableBatches.get(batchId);
    if (!availableBatch) return undefined;
    clearTimeout(availableBatch.expiryTimer);
    this.availableBatches.delete(batchId);
    return availableBatch;
  }

  private markFinalized(batchId: BatchId) {
    const existingTimer = this.finalizedBatchTimers.get(batchId);
    if (existingTimer) clearTimeout(existingTimer);

    const finalizedTimer = setTimeout(() => {
      this.finalizedBatchTimers.delete(batchId);
    }, this.options.finalizedBatchTtlMs ?? this.options.availableBatchTtlMs);
    this.finalizedBatchTimers.set(batchId, finalizedTimer);
  }

  private createProblemFingerprint(problem: CompanionProblem): string {
    return createHash('sha1').update(JSON.stringify(problem)).digest('hex');
  }
}
