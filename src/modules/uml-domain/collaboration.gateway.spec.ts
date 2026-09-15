import { randomUUID } from 'node:crypto';
import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationRateLimiterService } from './collaboration-rate-limiter.service';

function configuration() {
  return {
    collaboration: {
      commandLimit: 2,
      commandWindowMs: 10_000,
      controlEventLimit: 2,
      controlEventWindowMs: 10_000,
    },
  };
}

function gatewayWithMocks(verifier: { isSessionActive: jest.Mock }) {
  return new CollaborationGateway(
    { getOrThrow: jest.fn().mockReturnValue(configuration()) } as never,
    verifier as never,
    {
      validate: jest.fn().mockImplementation((_name: string, payload: unknown) => payload),
    } as never,
    { getAuthorizedDocument: jest.fn().mockResolvedValue(null) } as never,
    {} as never,
    {} as never,
    new CollaborationRateLimiterService(),
    {} as never,
    {} as never,
    {} as never,
  );
}

function clientWithIdentity(accessTokenExpiresAt: number) {
  return {
    id: `socket-${randomUUID()}`,
    data: {
      identity: {
        userId: randomUUID(),
        sessionId: randomUUID(),
        accessTokenExpiresAt,
      },
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as never;
}

function futureExpiry(): number {
  return Math.floor(Date.now() / 1000) + 300;
}

describe('CollaborationGateway admission order', () => {
  it('consults the session for admitted control events but not for rate-limited ones', async () => {
    const verifier = { isSessionActive: jest.fn().mockResolvedValue(true) };
    const gateway = gatewayWithMocks(verifier);
    const client = clientWithIdentity(futureExpiry());
    const documentId = randomUUID();
    const responses: unknown[] = [];
    const ack = (response: unknown) => {
      responses.push(response);
    };

    await gateway.updatePresence(client, { documentId }, ack);
    await gateway.updatePresence(client, { documentId }, ack);
    expect(verifier.isSessionActive).toHaveBeenCalledTimes(2);

    await gateway.updatePresence(client, { documentId }, ack);
    expect(responses[2]).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(verifier.isSessionActive).toHaveBeenCalledTimes(2);
  });

  it('rejects locally expired tokens without consulting the session', async () => {
    const verifier = { isSessionActive: jest.fn().mockResolvedValue(true) };
    const gateway = gatewayWithMocks(verifier);
    const client = clientWithIdentity(Math.floor(Date.now() / 1000) - 10);
    const responses: unknown[] = [];

    await gateway.updatePresence(client, { documentId: randomUUID() }, (response: unknown) => {
      responses.push(response);
    });

    expect(responses[0]).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(verifier.isSessionActive).not.toHaveBeenCalled();
  });

  it('still disconnects admitted sockets whose session was revoked', async () => {
    const verifier = { isSessionActive: jest.fn().mockResolvedValue(false) };
    const gateway = gatewayWithMocks(verifier);
    const client = clientWithIdentity(futureExpiry()) as unknown as {
      emit: jest.Mock;
      disconnect: jest.Mock;
    };
    const responses: unknown[] = [];

    await gateway.updatePresence(
      client as never,
      { documentId: randomUUID() },
      (response: unknown) => {
        responses.push(response);
      },
    );

    expect(verifier.isSessionActive).toHaveBeenCalledTimes(1);
    expect(responses[0]).toMatchObject({ ok: false, code: 'SESSION_REVOKED' });
    expect(client.emit).toHaveBeenCalledWith(
      'session:revoked',
      expect.objectContaining({ code: 'SESSION_REVOKED' }),
    );
    await Promise.resolve();
  });
});
