import { describe, expect, it } from 'vitest';
import {
  MAX_SESSIONS,
  MAX_SESSIONS_PER_ACCOUNT,
  MAX_STREAMS_PER_SESSION,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  UiSessions,
} from '../src/ui/sessions.js';

const setup = () => {
  const clock = { now: Date.parse('2026-10-15T12:00:00Z') };
  const sessions = new UiSessions(() => clock.now);
  const session = sessions.signIn('account', 'workspace');
  return { clock, sessions, session };
};

describe('UI session timeouts', () => {
  it('ends a session left unused for the idle timeout', () => {
    const { clock, sessions, session } = setup();
    clock.now += SESSION_IDLE_MS - 1;
    expect(sessions.get(session.id)).toBe(session); // using it resets the idle clock
    clock.now += SESSION_IDLE_MS - 1;
    expect(sessions.get(session.id)).toBe(session);
    clock.now += SESSION_IDLE_MS;
    expect(sessions.get(session.id)).toBeUndefined();
    expect(sessions.verify(session.id, session.csrf)).toBeUndefined();
  });

  it('ends a session at the absolute limit, even if it is in constant use', () => {
    const { clock, sessions, session } = setup();
    while (clock.now - session.createdAt < SESSION_MAX_MS - 3600_000) {
      clock.now += 3600_000;
      expect(sessions.verify(session.id, session.csrf)).toBe(session);
    }
    clock.now += 3600_000;
    expect(sessions.verify(session.id, session.csrf)).toBeUndefined();
  });

  it('a flood of anonymous sessions does not push out a signed-in one', () => {
    const { clock, sessions, session } = setup();
    for (let i = 0; i < MAX_SESSIONS + 50; i++) {
      clock.now += 1;
      sessions.resume(undefined);
    }
    expect(sessions.get(session.id)).toBe(session);
  });
});

describe('sessions per account', () => {
  it('ends an account’s least recently used session beyond its cap, and no one else’s', () => {
    const { clock, sessions, session: someoneElse } = setup();
    const mine = [];
    for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT; i++) {
      clock.now += 1;
      mine.push(sessions.signIn('mine', 'w'));
    }
    clock.now += 1;
    sessions.get(mine[0]?.id); // the first is in use, so the second is the oldest
    clock.now += 1;
    sessions.signIn('mine', 'w');
    expect(sessions.get(mine[0]?.id)).toBe(mine[0]);
    expect(sessions.get(mine[1]?.id)).toBeUndefined();
    expect(sessions.get(someoneElse.id)).toBe(someoneElse);
  });
});

describe('live-update streams', () => {
  const open = (sessions: UiSessions, session: ReturnType<UiSessions['signIn']>) => {
    const stream = { closed: false };
    const release = sessions.openStream(session, () => {
      stream.closed = true;
    });
    return { stream, release };
  };

  it('closes when the session ends, times out or is pushed out', () => {
    const { clock, sessions, session } = setup();
    const signedOut = open(sessions, session).stream;
    sessions.end(session);
    expect(signedOut.closed).toBe(true);

    const idle = sessions.signIn('account', 'w');
    const timedOut = open(sessions, idle).stream;
    clock.now += SESSION_IDLE_MS;
    expect(sessions.isLive(idle)).toBe(false);
    expect(timedOut.closed).toBe(true);

    const first = sessions.signIn('account', 'w');
    const pushedOut = open(sessions, first).stream;
    for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT; i++) sessions.signIn('account', 'w');
    expect(pushedOut.closed).toBe(true);
  });

  it('closes the oldest beyond the per-session cap', () => {
    const { sessions, session } = setup();
    const streams = Array.from({ length: MAX_STREAMS_PER_SESSION + 1 }, () =>
      open(sessions, session),
    );
    expect(streams.map((s) => s.stream.closed)).toEqual([
      true,
      ...Array<boolean>(MAX_STREAMS_PER_SESSION).fill(false),
    ]);
  });

  it('a released stream no longer counts', () => {
    const { sessions, session } = setup();
    for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) open(sessions, session).release();
    const last = open(sessions, session).stream;
    expect(last.closed).toBe(false);
    expect(session.streams.size).toBe(1);
  });
});

describe('sign-ins confirming an erase', () => {
  it('keeps one per session: a new one replaces the last', () => {
    const { sessions, session } = setup();
    const login = { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/ui' };
    const reauth = { sessionId: session.id, workspaceId: 'w' };
    const first = sessions.startLogin({ ...login, reauth });
    const other = sessions.startLogin({ ...login, reauth: { ...reauth, sessionId: 'other' } });
    const plain = sessions.startLogin(login);
    const second = sessions.startLogin({ ...login, reauth });
    expect(sessions.takeLogin(first)).toBeUndefined();
    expect(sessions.takeLogin(second)?.reauth).toEqual(reauth);
    expect(sessions.takeLogin(other)).toBeDefined();
    expect(sessions.takeLogin(plain)).toBeDefined();
  });
});
