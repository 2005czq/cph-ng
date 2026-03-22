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

import type {
  AvailableBatch,
  BatchId,
  BatchRemovalReason,
  CompanionProblem,
  SubmitData,
} from '@cph-ng/core';
import type { IFileSystem } from '@v/application/ports/node/IFileSystem';
import type { ICompanion } from '@v/application/ports/services/ICompanion';
import type { ILogger } from '@v/application/ports/vscode/ILogger';
import type { ITranslator } from '@v/application/ports/vscode/ITranslator';
import type { IUi } from '@v/application/ports/vscode/IUi';
import { ImportCompanionProblems } from '@v/application/useCases/companion/ImportCompanionProblems';
import { TOKENS } from '@v/composition/tokens';
import type { Problem } from '@v/domain/entities/problem';
import { CompanionCommunicationService } from '@v/infrastructure/services/companion/companionCommunicationService';
import { CompanionStatusbarService } from '@v/infrastructure/services/companion/companionStatusbarService';
import { inject, injectable } from 'tsyringe';

export type BatchList = Map<BatchId, CompanionProblem[]>;

@injectable()
export class Companion implements ICompanion {
  private readingProgress: Map<BatchId, (count: number, size: number) => void> = new Map();
  private batchesToClaim: BatchList = new Map();

  public constructor(
    @inject(TOKENS.translator) private readonly translator: ITranslator,
    @inject(TOKENS.fileSystem) private readonly fs: IFileSystem,
    @inject(TOKENS.ui) private readonly ui: IUi,
    @inject(TOKENS.logger) private readonly logger: ILogger,
    @inject(CompanionCommunicationService) private readonly ws: CompanionCommunicationService,
    @inject(CompanionStatusbarService) private readonly statusbar: CompanionStatusbarService,
    @inject(ImportCompanionProblems) private readonly importUseCase: ImportCompanionProblems,
  ) {
    this.logger = this.logger.withScope('companion');
    this.ws.signals.on('statusChanged', this.updateStatusbar);
    this.ws.signals.on('readingBatch', this.readingBatch);
    this.ws.signals.on('batchAvailable', this.batchAvailable);
    this.ws.signals.on('batchSnapshot', this.batchSnapshot);
    this.ws.signals.on('batchRemoved', this.batchRemoved);
    this.statusbar.signals.on('click', this.handleStatusBarClick);
  }

  private removeBatch(batchId: BatchId) {
    this.batchesToClaim.delete(batchId);
  }
  private updateStatusbar = () => {
    this.statusbar.update(this.ws.getStatus(), this.batchesToClaim, this.ws.getFailureMessage());
  };

  private handleStatusBarClick = async () => {
    this.logger.debug('Status bar item clicked');
    if (this.ws.getStatus() !== 'ONLINE') return await this.ws.connect();
    if (this.batchesToClaim.size === 0) this.logger.info('No batches to claim');
    else if (this.batchesToClaim.size === 1) {
      const batchId = Array.from(this.batchesToClaim.keys())[0];
      if (batchId) await this.claimAndImport(batchId);
    } else {
      const batchId = await this.ui.quickPick<BatchId>(
        Array.from(this.batchesToClaim.entries()).map(([batchId, problems]) => ({
          label: this.translator.t('{count} problem(s) available', { count: problems.length }),
          description:
            `${problems.reduce((prev, problem) => Math.max(prev, problem.timeLimit), 0)}ms, ` +
            `${problems.reduce((prev, problem) => Math.max(prev, problem.memoryLimit), 0)}MB`,
          detail: problems.map((problem) => problem.name).join(', '),
          value: batchId,
        })),
        { title: this.translator.t('Select a batch to claim') },
      );
      if (batchId) await this.claimAndImport(batchId);
    }
  };

  private readingBatch = (batchId: BatchId, count: number, size: number) => {
    if (!this.readingProgress.get(batchId)) {
      const progress = this.ui.progress(
        this.translator.t('Reading problems from companion...'),
        () => this.ws.cancelBatch(batchId),
      );
      this.readingProgress.set(batchId, (count, size) => {
        progress.report({ increment: (1 / size) * 100 });
        if (count >= size) {
          progress.done();
          this.readingProgress.delete(batchId);
        }
      });
    }
    this.readingProgress.get(batchId)?.(count, size);
  };
  private batchAvailable = async (
    batchId: BatchId,
    problems: CompanionProblem[],
    autoImport: boolean,
  ) => {
    if (autoImport) {
      this.logger.info('Auto-importing batch', { batchId });
      await this.claimAndImport(batchId);
    } else {
      this.batchesToClaim.set(batchId, problems);
      this.updateStatusbar();
    }
  };

  private batchSnapshot = (batches: AvailableBatch[]) => {
    this.batchesToClaim = new Map(
      batches.map(
        ({ batchId, problems }) => [batchId, problems] satisfies [BatchId, CompanionProblem[]],
      ),
    );
    this.updateStatusbar();
  };

  private async claimAndImport(batchId: BatchId) {
    try {
      const result = await this.ws.claimBatch(batchId);
      if (!result.ok) {
        this.logger.info('Batch is no longer available', { batchId });
        this.removeBatch(batchId);
        this.updateStatusbar();
        return;
      }

      this.removeBatch(batchId);
      this.updateStatusbar();
      await this.importUseCase.exec(result.problems);
    } catch (e) {
      this.logger.error('Failed to import companion problems', e);
      this.ui.alert(
        'error',
        this.translator.t('Failed to import problems: {msg}', { msg: (e as Error).message }),
      );
    }
  }

  private batchRemoved = (batchId: BatchId, reason: BatchRemovalReason) => {
    this.logger.info('Batch removed', { batchId, reason });
    this.removeBatch(batchId);
    this.updateStatusbar();
  };

  public async connect() {
    await this.ws.connect();
    this.updateStatusbar();
  }
  public async disconnect() {
    await this.ws.disconnect();
  }
  public isBrowserExtConnected(): boolean {
    return this.ws.isBrowserConnected();
  }
  public async submit(problem: Problem) {
    if (!problem.url) throw new Error(this.translator.t('Can not parse problem URL'));
    try {
      new URL(problem.url);
    } catch {
      throw new Error(this.translator.t('Can not parse problem URL'));
    }
    this.logger.info('Submitting problem', { problem });

    if (!this.ws.isBrowserConnected()) {
      this.ui.alert(
        'warn',
        this.translator.t(
          'Browser extension not connected. Install or open the CPH-NG Submit browser extension.',
        ),
      );
      return;
    }

    const sourceCode = await this.fs.readFile(problem.src.path);
    if (sourceCode.trim() === '') {
      this.ui.alert('warn', this.translator.t('Source code is empty'));
      return;
    }

    this.ws.submit({
      url: problem.url,
      sourceCode,
    } satisfies SubmitData);
  }
}
