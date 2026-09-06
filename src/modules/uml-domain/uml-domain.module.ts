import { Module } from '@nestjs/common';
import { CanonicalModelValidator } from './canonical-model.validator';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  controllers: [DocumentsController],
  providers: [CanonicalModelValidator, DocumentsService],
})
export class UmlDomainModule {}
