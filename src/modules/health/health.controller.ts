import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

export interface HealthResponse {
  status: 'ok';
  service: 'uml-class-designer-be';
  timestamp: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Comprueba que la API está disponible' })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        service: 'uml-class-designer-be',
        timestamp: '2026-09-04T00:00:00.000Z',
      },
    },
  })
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'uml-class-designer-be',
      timestamp: new Date().toISOString(),
    };
  }
}
