import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './config.js';
import type { IMovimientoContableRepository } from '../application/abstractions/IMovimientoContableRepository.js';
import type { ISaldoContableRepository } from '../application/abstractions/ISaldoContableRepository.js';
import type { ProcesarSaldosContablesUseCase } from '../application/useCases/ProcesarSaldosContablesUseCase.js';
import type { IRabbitMqService } from '../infrastructure/messaging/RabbitMqService.js';

declare module 'fastify' {
  interface FastifyInstance {
    movimientoRepo: IMovimientoContableRepository;
    saldoRepo: ISaldoContableRepository;
    useCase: ProcesarSaldosContablesUseCase;
    config: AppConfig;
    prismaClient: PrismaClient;
    rabbitMqService?: IRabbitMqService;
  }
}
