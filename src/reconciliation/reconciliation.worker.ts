import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class ReconciliationWorker {
  private readonly logger = new Logger(ReconciliationWorker.name);
  private running = false;

  constructor(private readonly reconciliation: ReconciliationService) {}

  @Interval(1000 * 60 * 10)
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.reconciliation.run();
      if (!report.ok) {
        this.logger.fatal(
          `Reconciliation found drift, invariants broken: ${JSON.stringify(report)}`,
        );
      }
      return report;
    } catch (e) {
      this.logger.error(
        'Reconciliation tick failed',
        e instanceof Error ? e.stack : String(e),
      );
    } finally {
      this.running = false;
    }
  }
}
