import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';

@Module({
  providers: [ReconciliationService, ReconciliationWorker],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
