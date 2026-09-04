import { Module } from '@nestjs/common';

// The canonical contract currently lives in contracts/. Runtime services will
// enter through this module when persistence endpoints are introduced.
@Module({})
export class UmlDomainModule {}
